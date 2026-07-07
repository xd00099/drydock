use crate::accumulator::{resolve_title, SessionDelta};
use crate::chunker::Chunk;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub struct Store { conn: Connection }

#[derive(Debug, Clone, PartialEq)]
pub struct SessionRow {
    pub session_id: String,
    pub project_path: String,
    pub title: String,
    pub title_source: String,
    pub latest_recap: Option<String>,
    pub first_prompt: Option<String>,
    pub last_prompt: Option<String>,
    pub last_message_at: Option<i64>,
    pub message_count: i64,
    pub user_message_count: i64,
    pub git_branch: Option<String>,
    pub cli_version: Option<String>,
    pub ai_title: Option<String>,
    pub custom_title: Option<String>,
    pub slug: Option<String>,
    pub starred: bool,
    pub hidden: bool,
    pub live_status: String,
    pub live_pid: Option<i64>,
}

/// One user-created sidebar folder, in band order.
#[derive(Debug, Clone, PartialEq)]
pub struct FolderRow {
    pub folder_id: String,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SyncState {
    pub session_id: String,
    pub byte_offset: i64,
    pub mtime: i64,
    /// Hex of the last <=64 bytes before byte_offset; None for pre-migration rows.
    pub tail_hex: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    pub session_id: String,
    /// ~5-word description of the session, used as its display title.
    pub summary: String,
    /// JSON array of timeline items (shape owned by the app layer).
    pub timeline: String,
    pub generated_at: i64,
    pub at_message_count: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub chunk_id: i64,
    pub session_id: String,
    pub snippet: String,
    pub rank: f64, // lower = better (bm25, or 1-cosine for semantic)
}

/// Quote every whitespace-separated term so FTS5 syntax chars can't break the query.
fn fts_query(raw: &str) -> String {
    raw.split_whitespace()
        .map(|t| format!("\"{}\"", t.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ")
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
CREATE TABLE IF NOT EXISTS sessions(
  session_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  title_source TEXT NOT NULL DEFAULT '',
  latest_recap TEXT, first_prompt TEXT, last_prompt TEXT,
  last_message_at INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  user_message_count INTEGER NOT NULL DEFAULT 0,
  git_branch TEXT, cli_version TEXT, ai_title TEXT, custom_title TEXT, slug TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  live_status TEXT NOT NULL DEFAULT 'ended',
  live_pid INTEGER
);
CREATE TABLE IF NOT EXISTS chunks(
  chunk_id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER,
  agent_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_session_seq ON chunks(session_id, seq);
CREATE TABLE IF NOT EXISTS sync_state(
  file_path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  tail_hex TEXT,
  is_agent INTEGER NOT NULL DEFAULT 0
);
-- Sessions the user hid from Drydock (kept in its own table so re-syncs, which
-- recompute the ghost `hidden` column, can't clobber the user's choice).
CREATE TABLE IF NOT EXISTS hidden_sessions(
  session_id TEXT PRIMARY KEY,
  hidden_at INTEGER NOT NULL
);
-- User renames made in Drydock's UI. A Drydock-side override (we never write
-- ~/.claude), in its own table for the same reason as hidden_sessions: re-syncs
-- rewrite session rows and must never clobber the user's names. No FK: a name
-- outlives transcript expiry and reattaches when the session returns.
CREATE TABLE IF NOT EXISTS session_names(
  session_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  named_at INTEGER NOT NULL
);
-- User-created sidebar folders ('working groups') and their members. Own
-- tables for the same reason as hidden_sessions: re-syncs rewrite session
-- rows and must never clobber the user's organization. session_id is the
-- PRIMARY KEY of folder_sessions — a session lives in at most ONE folder
-- (move semantics, enforced by the schema). Deliberately no FK to sessions:
-- memberships outlive transcript expiry, so a session that re-syncs later
-- lands back in its folder.
CREATE TABLE IF NOT EXISTS folders(
  folder_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS folder_sessions(
  session_id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folder_sessions_folder ON folder_sessions(folder_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  chunk_id UNINDEXED,
  session_id UNINDEXED,
  tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS chunk_embeddings(
  chunk_id INTEGER PRIMARY KEY,
  embedding BLOB NOT NULL
);
-- Semantic hue per session (degrees 0..360): the angle of the session's mean
-- chunk embedding projected on the persisted 2D basis (meta 'hue_basis_v1'),
-- so sessions about similar things wear similar colors. embedded_chunks is
-- how many vectors the mean covered — a session that grew gets re-tinted.
CREATE TABLE IF NOT EXISTS session_hues(
  session_id TEXT PRIMARY KEY,
  hue REAL NOT NULL,
  embedded_chunks INTEGER NOT NULL DEFAULT 0
);
-- Briefing card: a one-line summary plus a JSON timeline of milestones.
CREATE TABLE IF NOT EXISTS cards(
  session_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL DEFAULT '',
  timeline TEXT NOT NULL DEFAULT '[]',
  generated_at INTEGER NOT NULL,
  at_message_count INTEGER NOT NULL
);
";

/// Additive migrations for DBs created by older Drydock versions.
/// ALTER fails harmlessly when the column already exists (fresh SCHEMA has it).
fn migrate(conn: &Connection) {
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN live_status TEXT NOT NULL DEFAULT 'ended'", []);
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN live_pid INTEGER", []);
    let _ = conn.execute("ALTER TABLE sync_state ADD COLUMN tail_hex TEXT", []);
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN custom_title TEXT", []);
    let _ = conn.execute("ALTER TABLE chunks ADD COLUMN agent_id TEXT", []);
    let _ = conn.execute("ALTER TABLE sync_state ADD COLUMN is_agent INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_session_seq ON chunks(session_id, seq)", []);
    let _ = conn.execute("DROP INDEX IF EXISTS idx_chunks_session", []);
    // Project-level pins were removed; drop the table on existing DBs.
    let _ = conn.execute("DROP TABLE IF EXISTS pins", []);
    // Cards moved from {goal,state,next_step} to {summary,timeline}. The old
    // columns can't be migrated in place, but cards are cheap to regenerate, so
    // recreate the table once (gated on a meta flag) and let the enricher refill.
    let card_schema: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'card_schema'", [], |r| r.get(0))
        .optional()
        .unwrap_or(None);
    if card_schema.as_deref() != Some("v2") {
        let _ = conn.execute("DROP TABLE IF EXISTS cards", []);
        let _ = conn.execute(
            "CREATE TABLE cards(
               session_id TEXT PRIMARY KEY,
               summary TEXT NOT NULL DEFAULT '',
               timeline TEXT NOT NULL DEFAULT '[]',
               generated_at INTEGER NOT NULL,
               at_message_count INTEGER NOT NULL
             )",
            [],
        );
        let _ = conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('card_schema', 'v2')",
            [],
        );
    }
    // backfill FTS for DBs whose chunks predate the chunks_fts table
    let need_backfill: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM chunks) - (SELECT COUNT(*) FROM chunks_fts)",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if need_backfill > 0 {
        let _ = conn.execute(
            "INSERT INTO chunks_fts(text, chunk_id, session_id)
             SELECT text, chunk_id, session_id FROM chunks
             WHERE chunk_id NOT IN (SELECT chunk_id FROM chunks_fts)",
            [],
        );
    }
}

/// Replace a session's synthetic `card`-role search chunk with fresh text: drop
/// the old chunk (plus its FTS row and embedding) and insert the new one so a
/// regenerated card gets re-embedded. Blank text just clears the old chunk.
/// Takes a plain `Connection` so it composes inside an existing transaction
/// (`&Transaction` derefs to `&Connection`).
fn replace_card_chunk(conn: &Connection, session_id: &str, card_text: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM chunk_embeddings WHERE chunk_id IN
           (SELECT chunk_id FROM chunks WHERE session_id = ?1 AND role = 'card')",
        params![session_id],
    )?;
    conn.execute(
        "DELETE FROM chunks_fts WHERE chunk_id IN
           (SELECT chunk_id FROM chunks WHERE session_id = ?1 AND role = 'card')",
        params![session_id],
    )?;
    conn.execute("DELETE FROM chunks WHERE session_id = ?1 AND role = 'card'", params![session_id])?;
    if card_text.trim().is_empty() {
        return Ok(()); // nothing worth indexing
    }
    let next_seq: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), -1) + 1 FROM chunks WHERE session_id = ?1",
        params![session_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO chunks(session_id, seq, role, text, ts) VALUES (?1, ?2, 'card', ?3, NULL)",
        params![session_id, next_seq, card_text],
    )?;
    let chunk_rowid = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO chunks_fts(text, chunk_id, session_id) VALUES (?1, ?2, ?3)",
        params![card_text, chunk_rowid, session_id],
    )?;
    Ok(())
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        // two connections (UI reads, watcher writes) share the file: set the busy
        // timeout and WAL before any write so the schema/migration statements
        // themselves wait out a lock instead of failing the open.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn);
        Ok(Store { conn })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn);
        Ok(Store { conn })
    }

    /// Merge a parse delta into the session row and append its chunks. One transaction.
    pub fn apply_delta(&mut self, session_id: &str, d: &SessionDelta, chunks: &[Chunk]) -> Result<()> {
        let tx = self.conn.transaction()?;
        let existing: Option<SessionRow> = Self::row_in_conn(&tx, session_id)?;

        let merged = SessionDelta {
            session_id: Some(session_id.to_string()),
            // Sticky like first_prompt: an already-known (non-empty) project
            // path is the session's root cwd and must not be overwritten by a
            // later batch whose first cwd drifted. Radar stubs store '' so a
            // real transcript can still fill it in.
            project_path: existing
                .as_ref()
                .map(|e| e.project_path.clone())
                .filter(|p| !p.is_empty())
                .or_else(|| d.project_path.clone()),
            first_prompt: existing.as_ref().and_then(|e| e.first_prompt.clone()).or_else(|| d.first_prompt.clone()),
            last_prompt: d.last_prompt.clone().or_else(|| existing.as_ref().and_then(|e| e.last_prompt.clone())),
            latest_recap: d.latest_recap.clone().or_else(|| existing.as_ref().and_then(|e| e.latest_recap.clone())),
            ai_title: d.ai_title.clone().or_else(|| existing.as_ref().and_then(|e| e.ai_title.clone())),
            custom_title: d.custom_title.clone().or_else(|| existing.as_ref().and_then(|e| e.custom_title.clone())),
            slug: d.slug.clone().or_else(|| existing.as_ref().and_then(|e| e.slug.clone())),
            last_message_at: match (d.last_message_at, existing.as_ref().and_then(|e| e.last_message_at)) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            },
            message_count: d.message_count + existing.as_ref().map_or(0, |e| e.message_count),
            user_message_count: d.user_message_count + existing.as_ref().map_or(0, |e| e.user_message_count),
            git_branch: d.git_branch.clone().or_else(|| existing.as_ref().and_then(|e| e.git_branch.clone())),
            cli_version: d.cli_version.clone().or_else(|| existing.as_ref().and_then(|e| e.cli_version.clone())),
        };

        let (title, title_source) = resolve_title(&merged, session_id);
        let hidden = merged.user_message_count == 0;

        tx.execute(
            "INSERT INTO sessions(session_id, project_path, title, title_source, latest_recap,
               first_prompt, last_prompt, last_message_at, message_count, user_message_count,
               git_branch, cli_version, ai_title, custom_title, slug, hidden)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
             ON CONFLICT(session_id) DO UPDATE SET
               project_path=excluded.project_path, title=excluded.title,
               title_source=excluded.title_source, latest_recap=excluded.latest_recap,
               first_prompt=excluded.first_prompt, last_prompt=excluded.last_prompt,
               last_message_at=excluded.last_message_at, message_count=excluded.message_count,
               user_message_count=excluded.user_message_count, git_branch=excluded.git_branch,
               cli_version=excluded.cli_version, ai_title=excluded.ai_title,
               custom_title=excluded.custom_title, slug=excluded.slug, hidden=excluded.hidden",
            params![
                session_id, merged.project_path.clone().unwrap_or_default(), title, title_source,
                merged.latest_recap, merged.first_prompt, merged.last_prompt, merged.last_message_at,
                merged.message_count, merged.user_message_count, merged.git_branch,
                merged.cli_version, merged.ai_title, merged.custom_title, merged.slug, hidden as i64
            ],
        )?;

        let next_seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM chunks WHERE session_id = ?1",
            params![session_id], |r| r.get(0),
        )?;
        for (i, c) in chunks.iter().enumerate() {
            tx.execute(
                "INSERT INTO chunks(session_id, seq, role, text, ts) VALUES (?1,?2,?3,?4,?5)",
                params![session_id, next_seq + i as i64, c.role, c.text, c.ts],
            )?;
            let chunk_rowid = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO chunks_fts(text, chunk_id, session_id) VALUES (?1, ?2, ?3)",
                params![c.text, chunk_rowid, session_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn row_in_conn(conn: &Connection, session_id: &str) -> Result<Option<SessionRow>> {
        Ok(conn.query_row(
            "SELECT session_id, project_path, title, title_source, latest_recap, first_prompt,
                    last_prompt, last_message_at, message_count, user_message_count, git_branch,
                    cli_version, ai_title, custom_title, slug, starred, hidden, live_status, live_pid
             FROM sessions WHERE session_id = ?1",
            params![session_id],
            |r| Ok(SessionRow {
                session_id: r.get(0)?, project_path: r.get(1)?, title: r.get(2)?,
                title_source: r.get(3)?, latest_recap: r.get(4)?, first_prompt: r.get(5)?,
                last_prompt: r.get(6)?, last_message_at: r.get(7)?, message_count: r.get(8)?,
                user_message_count: r.get(9)?, git_branch: r.get(10)?, cli_version: r.get(11)?,
                ai_title: r.get(12)?, custom_title: r.get(13)?, slug: r.get(14)?,
                starred: r.get::<_, i64>(15)? != 0, hidden: r.get::<_, i64>(16)? != 0,
                live_status: r.get(17)?, live_pid: r.get(18)?,
            }),
        ).optional()?)
    }

    pub fn get_session(&self, session_id: &str) -> Result<Option<SessionRow>> {
        Self::row_in_conn(&self.conn, session_id)
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id FROM sessions ORDER BY last_message_at DESC NULLS LAST",
        )?;
        let ids: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        ids.iter()
            .filter_map(|id| self.get_session(id).transpose())
            .collect::<Result<Vec<_>>>()
    }

    pub fn set_starred(&mut self, session_id: &str, starred: bool) -> Result<()> {
        self.conn.execute("UPDATE sessions SET starred = ?2 WHERE session_id = ?1",
            params![session_id, starred as i64])?;
        Ok(())
    }

    /// Overwrite a session's project_path directly (one-time data repairs).
    /// Bypasses apply_delta's stickiness on purpose. No-op for unknown ids.
    pub fn set_project_path(&self, session_id: &str, path: &str) -> Result<()> {
        self.conn.execute("UPDATE sessions SET project_path = ?2 WHERE session_id = ?1",
            params![session_id, path])?;
        Ok(())
    }

    pub fn meta_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0))
            .optional()?)
    }

    pub fn meta_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Remove a session the USER deleted: everything goes, including the
    /// user-flag tables (hidden/name/folder) — an explicit delete is the one
    /// declaration that a session's flags shouldn't ever come back.
    pub fn delete_session(&mut self, session_id: &str) -> Result<()> {
        self.delete_session_inner(session_id, true)
    }

    /// Remove a session's DERIVED data only (chunks, card, sync state, hues,
    /// row) — the watcher's reparse/expiry paths. The user-flag tables
    /// (hidden_sessions, session_names, folder_sessions) SURVIVE, honoring
    /// their schema contract: a truncated/rewritten transcript is immediately
    /// re-indexed as the same session, and an expired one may return — the
    /// user's names, hidden flags and filings must reattach, not vanish.
    pub fn delete_session_data(&mut self, session_id: &str) -> Result<()> {
        self.delete_session_inner(session_id, false)
    }

    fn delete_session_inner(&mut self, session_id: &str, purge_flags: bool) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM chunks_fts WHERE session_id = ?1", params![session_id])?;
        tx.execute(
            "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE session_id = ?1)",
            params![session_id],
        )?;
        tx.execute("DELETE FROM chunks WHERE session_id = ?1", params![session_id])?;
        tx.execute("DELETE FROM cards WHERE session_id = ?1", params![session_id])?;
        tx.execute("DELETE FROM sync_state WHERE session_id = ?1", params![session_id])?;
        if purge_flags {
            tx.execute("DELETE FROM hidden_sessions WHERE session_id = ?1", params![session_id])?;
            tx.execute("DELETE FROM session_names WHERE session_id = ?1", params![session_id])?;
            tx.execute("DELETE FROM folder_sessions WHERE session_id = ?1", params![session_id])?;
        }
        tx.execute("DELETE FROM session_hues WHERE session_id = ?1", params![session_id])?;
        tx.execute("DELETE FROM sessions WHERE session_id = ?1", params![session_id])?;
        tx.commit()?;
        Ok(())
    }

    /// Append a SUBAGENT transcript's chunks: searchable (FTS + embeddings)
    /// under the parent session, but tagged with agent_id so get_chunks —
    /// which feeds the transcript fallback, the enricher's card context and
    /// the card-search backfill — never mixes agent traffic into the parent's
    /// own conversation.
    /// Returns false (writing nothing) unless the parent is a REAL indexed
    /// session. The check lives inside the write transaction on purpose: a
    /// radar STUB must not adopt agent content (stub cleanup would strand it),
    /// and a concurrent delete_session_permanently must not race a
    /// check-then-act gap into re-inserting chunks for a dead session. The
    /// caller skips recording sync state when this returns false.
    pub fn apply_agent_chunks(&mut self, session_id: &str, agent_id: &str, chunks: &[Chunk]) -> Result<bool> {
        let tx = self.conn.transaction()?;
        let parent_real: bool = tx
            .query_row(
                "SELECT 1 FROM sessions WHERE session_id = ?1 AND title_source != 'radar-stub'",
                params![session_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !parent_real {
            return Ok(false);
        }
        let next_seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM chunks WHERE session_id = ?1",
            params![session_id], |r| r.get(0),
        )?;
        for (i, c) in chunks.iter().enumerate() {
            tx.execute(
                "INSERT INTO chunks(session_id, seq, role, text, ts, agent_id) VALUES (?1,?2,?3,?4,?5,?6)",
                params![session_id, next_seq + i as i64, c.role, c.text, c.ts, agent_id],
            )?;
            let chunk_rowid = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO chunks_fts(text, chunk_id, session_id) VALUES (?1, ?2, ?3)",
                params![c.text, chunk_rowid, session_id],
            )?;
        }
        tx.commit()?;
        Ok(true)
    }

    /// Drop one subagent file's derived data (its chunks + its sync row) —
    /// the parent session stays intact. Used when CC prunes an agent file.
    pub fn delete_agent_file(&mut self, file_path: &str, session_id: &str, agent_id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM chunks_fts WHERE chunk_id IN
               (SELECT chunk_id FROM chunks WHERE session_id = ?1 AND agent_id = ?2)",
            params![session_id, agent_id],
        )?;
        tx.execute(
            "DELETE FROM chunk_embeddings WHERE chunk_id IN
               (SELECT chunk_id FROM chunks WHERE session_id = ?1 AND agent_id = ?2)",
            params![session_id, agent_id],
        )?;
        tx.execute("DELETE FROM chunks WHERE session_id = ?1 AND agent_id = ?2", params![session_id, agent_id])?;
        tx.execute("DELETE FROM sync_state WHERE file_path = ?1", params![file_path])?;
        tx.commit()?;
        Ok(())
    }

    pub fn chunk_count(&self, session_id: &str) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM chunks WHERE session_id = ?1",
            params![session_id], |r| r.get(0))?)
    }

    pub fn set_sync_state(&mut self, file_path: &str, session_id: &str, byte_offset: i64, mtime: i64, tail_hex: Option<&str>) -> Result<()> {
        self.set_sync_state_kind(file_path, session_id, byte_offset, mtime, tail_hex, false)
    }

    pub fn set_sync_state_kind(&mut self, file_path: &str, session_id: &str, byte_offset: i64, mtime: i64, tail_hex: Option<&str>, is_agent: bool) -> Result<()> {
        self.conn.execute(
            "INSERT INTO sync_state(file_path, session_id, byte_offset, mtime, tail_hex, is_agent) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(file_path) DO UPDATE SET session_id=excluded.session_id,
               byte_offset=excluded.byte_offset, mtime=excluded.mtime, tail_hex=excluded.tail_hex,
               is_agent=excluded.is_agent",
            params![file_path, session_id, byte_offset, mtime, tail_hex, is_agent as i64])?;
        Ok(())
    }

    pub fn get_sync_state(&self, file_path: &str) -> Result<Option<SyncState>> {
        Ok(self.conn.query_row(
            "SELECT session_id, byte_offset, mtime, tail_hex FROM sync_state WHERE file_path = ?1",
            params![file_path],
            |r| Ok(SyncState { session_id: r.get(0)?, byte_offset: r.get(1)?, mtime: r.get(2)?, tail_hex: r.get(3)? }),
        ).optional()?)
    }

    /// Overwrite live statuses: listed sessions get (status, pid), all others reset to 'ended'.
    /// A live session with no transcript yet (e.g. a resume picker still open) gets a stub
    /// row (title_source='radar-stub') so the radar can show it; stubs are removed once dead.
    pub fn apply_live(&mut self, live: &[crate::radar::LiveSession]) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("UPDATE sessions SET live_status='ended', live_pid=NULL WHERE live_status != 'ended'", [])?;
        for l in live {
            let updated = tx.execute(
                "UPDATE sessions SET live_status = ?2, live_pid = ?3 WHERE session_id = ?1",
                params![l.session_id, l.status, l.pid as i64],
            )?;
            if updated == 0 {
                let project = l.cwd.clone().unwrap_or_default();
                tx.execute(
                    "INSERT INTO sessions(session_id, project_path, title, title_source, live_status, live_pid)
                     VALUES (?1, ?2, '(live session, no messages yet)', 'radar-stub', ?3, ?4)",
                    params![l.session_id, project, l.status, l.pid as i64],
                )?;
            }
        }
        // ended stubs cascade like any delete: agent sidecar chunks can attach
        // to a stub (race), and a bare row delete would strand them forever
        let dead: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT session_id FROM sessions WHERE live_status = 'ended' AND title_source = 'radar-stub'",
            )?;
            let ids = stmt.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            ids
        };
        for sid in &dead {
            tx.execute("DELETE FROM chunks_fts WHERE session_id = ?1", params![sid])?;
            tx.execute(
                "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE session_id = ?1)",
                params![sid],
            )?;
            tx.execute("DELETE FROM chunks WHERE session_id = ?1", params![sid])?;
            tx.execute("DELETE FROM sync_state WHERE session_id = ?1", params![sid])?;
            tx.execute("DELETE FROM session_hues WHERE session_id = ?1", params![sid])?;
            // a stub that dies transcript-less can never reattach a name —
            // without this, renaming a stub leaves an orphan row carried into
            // every backup forever
            tx.execute("DELETE FROM session_names WHERE session_id = ?1", params![sid])?;
            tx.execute("DELETE FROM sessions WHERE session_id = ?1", params![sid])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Transcript chunks for display and for the enricher's prompt. Excludes the
    /// synthetic `card` chunk (the briefing's own searchable text) so it neither
    /// shows in the transcript nor feeds back into the next card generation.
    pub fn get_chunks(&self, session_id: &str) -> Result<Vec<Chunk>> {
        let mut stmt = self.conn.prepare(
            // agent chunks are search-only: the transcript fallback and the
            // enricher's card context must see the parent conversation alone
            "SELECT role, text, ts FROM chunks
             WHERE session_id = ?1 AND role != 'card' AND agent_id IS NULL ORDER BY seq",
        )?;
        let rows: Vec<Chunk> = stmt
            .query_map(params![session_id], |r| {
                Ok(Chunk { role: r.get(0)?, text: r.get(1)?, ts: r.get(2)? })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn search_keyword(&self, query: &str, limit: i64) -> Result<Vec<SearchHit>> {
        let q = fts_query(query);
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT chunk_id, session_id, snippet(chunks_fts, 0, '«', '»', '…', 12), bm25(chunks_fts)
             FROM chunks_fts WHERE chunks_fts MATCH ?1 ORDER BY bm25(chunks_fts) LIMIT ?2",
        )?;
        let rows: Vec<SearchHit> = stmt
            .query_map(params![q, limit], |r| {
                Ok(SearchHit { chunk_id: r.get(0)?, session_id: r.get(1)?, snippet: r.get(2)?, rank: r.get(3)? })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn get_card(&self, session_id: &str) -> Result<Option<Card>> {
        Ok(self.conn.query_row(
            "SELECT session_id, summary, timeline, generated_at, at_message_count
             FROM cards WHERE session_id = ?1",
            params![session_id],
            |r| Ok(Card {
                session_id: r.get(0)?, summary: r.get(1)?, timeline: r.get(2)?,
                generated_at: r.get(3)?, at_message_count: r.get(4)?,
            }),
        ).optional()?)
    }

    /// Store a card and (re)index its searchable text as a `card`-role chunk, so
    /// the briefing's distilled summary participates in keyword + semantic search.
    /// `card_text` is the caller-composed search payload (summary + timeline text).
    pub fn put_card(&mut self, session_id: &str, summary: &str, timeline: &str, card_text: &str, at_message_count: i64) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO cards(session_id, summary, timeline, generated_at, at_message_count)
             VALUES (?1,?2,?3,?4,?5)",
            params![session_id, summary, timeline, now, at_message_count],
        )?;
        replace_card_chunk(&tx, session_id, card_text)?;
        tx.commit()?;
        Ok(())
    }

    /// (Re)index a card's searchable text without rewriting the card row — used to
    /// backfill the search chunk for cards generated before this existed.
    pub fn put_card_search_chunk(&mut self, session_id: &str, card_text: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        replace_card_chunk(&tx, session_id, card_text)?;
        tx.commit()?;
        Ok(())
    }

    /// Session ids that have a card but no `card`-role search chunk yet.
    pub fn cards_without_search_chunk(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.session_id FROM cards c
             WHERE NOT EXISTS (
               SELECT 1 FROM chunks ch WHERE ch.session_id = c.session_id AND ch.role = 'card'
             )",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// (session_id, summary) for every card with a non-empty summary — used to
    /// override session titles in the snapshot.
    pub fn card_summaries(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT session_id, summary FROM cards WHERE summary != ''")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Sessions whose card is missing or stale; idle/ended, >=3 user turns, not stubs/hidden.
    /// An existing card only goes stale after meaningful growth (>=5 messages) AND
    /// 10 min without activity, so an actively-used session isn't regenerated every minute.
    /// Priority: starred first, then most recently active.
    pub fn sessions_needing_cards(&self, limit: i64, now_ms: i64) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.session_id FROM sessions s
             LEFT JOIN cards c ON c.session_id = s.session_id
             WHERE s.live_status != 'busy'
               AND s.user_message_count >= 3
               AND s.hidden = 0
               AND s.title_source != 'radar-stub'
               AND (c.session_id IS NULL
                    OR (s.message_count - c.at_message_count >= 5
                        AND s.last_message_at <= ?2 - 600000))
             ORDER BY s.starred DESC, s.last_message_at DESC
             LIMIT ?1",
        )?;
        let rows: Vec<String> = stmt.query_map(params![limit, now_ms], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// (chunk_id, text) of chunks not yet embedded, oldest first.
    pub fn chunks_without_embeddings(&self, limit: i64) -> Result<Vec<(i64, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.chunk_id, c.text FROM chunks c
             LEFT JOIN chunk_embeddings e ON e.chunk_id = c.chunk_id
             WHERE e.chunk_id IS NULL
             ORDER BY (c.agent_id IS NOT NULL) ASC, c.chunk_id ASC LIMIT ?1",
        )?;
        let rows: Vec<(i64, String)> = stmt
            .query_map(params![limit], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn put_embedding(&mut self, chunk_id: i64, vec: &[f32]) -> Result<()> {
        let bytes: Vec<u8> = vec.iter().flat_map(|f| f.to_le_bytes()).collect();
        self.conn.execute(
            "INSERT OR REPLACE INTO chunk_embeddings(chunk_id, embedding) VALUES (?1, ?2)",
            params![chunk_id, bytes],
        )?;
        Ok(())
    }

    /// Drop every stored embedding. Used for a one-time re-embed when the
    /// embedding recipe changes (e.g. adding the e5 `passage:` prefix): the
    /// background loop then re-embeds all chunks consistently.
    pub fn clear_embeddings(&self) -> Result<usize> {
        Ok(self.conn.execute("DELETE FROM chunk_embeddings", [])?)
    }

    /// Brute-force cosine over all stored vectors; rank = 1 - cosine (lower = better).
    pub fn search_semantic(&self, query: &[f32], limit: usize) -> Result<Vec<SearchHit>> {
        let mut stmt = self.conn.prepare(
            "SELECT e.chunk_id, e.embedding, c.session_id, c.text
             FROM chunk_embeddings e JOIN chunks c ON c.chunk_id = e.chunk_id",
        )?;
        let qn = (query.iter().map(|x| x * x).sum::<f32>()).sqrt();
        let mut scored: Vec<SearchHit> = stmt
            .query_map([], |r| {
                let chunk_id: i64 = r.get(0)?;
                let blob: Vec<u8> = r.get(1)?;
                let session_id: String = r.get(2)?;
                let text: String = r.get(3)?;
                Ok((chunk_id, blob, session_id, text))
            })?
            .flatten()
            .filter_map(|(chunk_id, blob, session_id, text)| {
                let v: Vec<f32> = blob.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
                if v.len() != query.len() {
                    return None;
                }
                let dot: f32 = v.iter().zip(query).map(|(a, b)| a * b).sum();
                let vn = (v.iter().map(|x| x * x).sum::<f32>()).sqrt();
                if vn == 0.0 || qn == 0.0 {
                    return None;
                }
                let cos = dot / (vn * qn);
                let snippet: String = text.chars().take(90).collect();
                Some(SearchHit { chunk_id, session_id, snippet, rank: (1.0 - cos) as f64 })
            })
            .collect();
        scored.sort_by(|a, b| a.rank.partial_cmp(&b.rank).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        Ok(scored)
    }

    /// Hide/unhide a session from Drydock (kept across re-syncs).
    pub fn set_session_hidden(&self, session_id: &str, hidden: bool) -> Result<()> {
        if hidden {
            let now = chrono::Utc::now().timestamp_millis();
            self.conn.execute(
                "INSERT OR IGNORE INTO hidden_sessions(session_id, hidden_at) VALUES (?1, ?2)",
                params![session_id, now],
            )?;
        } else {
            self.conn.execute("DELETE FROM hidden_sessions WHERE session_id = ?1", params![session_id])?;
        }
        Ok(())
    }

    pub fn hidden_session_ids(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT session_id FROM hidden_sessions ORDER BY hidden_at")?;
        let rows: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Rename a session from Drydock's UI. The name is a Drydock-side override
    /// (never written to ~/.claude); a blank/whitespace name clears it. Capped
    /// server-side (the UI's maxLength only guards the honest path).
    pub fn set_session_name(&self, session_id: &str, name: &str) -> Result<()> {
        let trimmed: String = name.trim().chars().take(200).collect();
        let trimmed = trimmed.trim();
        if trimmed.is_empty() {
            self.conn.execute("DELETE FROM session_names WHERE session_id = ?1", params![session_id])?;
        } else {
            let now = chrono::Utc::now().timestamp_millis();
            self.conn.execute(
                "INSERT INTO session_names(session_id, name, named_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id) DO UPDATE SET name = ?2, named_at = ?3",
                params![session_id, trimmed, now],
            )?;
        }
        Ok(())
    }

    pub fn session_names(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare("SELECT session_id, name FROM session_names")?;
        let rows: Vec<(String, String)> =
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// The label a session wears in the UI, resolved with the frontend's
    /// precedence: Drydock name > claude custom-title > card summary > title.
    /// For backend surfaces that show labels (menu-bar tray, export) so they
    /// can't drift from what the sidebar shows.
    pub fn display_label(&self, session_id: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT COALESCE(
               NULLIF(TRIM((SELECT name FROM session_names WHERE session_id = s.session_id)), ''),
               CASE WHEN s.title_source = 'custom-title' THEN NULLIF(TRIM(s.title), '') END,
               NULLIF(TRIM((SELECT summary FROM cards WHERE session_id = s.session_id)), ''),
               s.title)
             FROM sessions s WHERE s.session_id = ?1",
        )?;
        let label: Option<String> = stmt.query_row(params![session_id], |r| r.get(0)).optional()?;
        Ok(label)
    }

    // ---- session hues (semantic colors) -----------------------------------

    /// Sessions whose hue is missing, or computed from fewer embedded chunks
    /// than now exist (their topic mean has moved since).
    pub fn sessions_with_stale_hues(&self, limit: i64) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT q.sid FROM (
               SELECT c.session_id AS sid, COUNT(e.chunk_id) AS n
               FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.chunk_id
               WHERE c.agent_id IS NULL
               GROUP BY c.session_id
             ) q LEFT JOIN session_hues h ON h.session_id = q.sid
             WHERE h.session_id IS NULL OR h.embedded_chunks != q.n
             LIMIT ?1",
        )?;
        let rows: Vec<String> = stmt.query_map(params![limit], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn decode_embedding(blob: &[u8]) -> Vec<f32> {
        blob.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
    }

    /// Mean of one session's chunk embeddings, plus how many it covered.
    pub fn session_embedding_mean(&self, session_id: &str) -> Result<Option<(Vec<f32>, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT e.embedding FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.chunk_id
             WHERE c.session_id = ?1 AND c.agent_id IS NULL",
        )?;
        let mut mean: Vec<f32> = Vec::new();
        let mut n = 0i64;
        for blob in stmt.query_map(params![session_id], |r| r.get::<_, Vec<u8>>(0))?.flatten() {
            let v = Self::decode_embedding(&blob);
            if mean.is_empty() {
                mean = vec![0.0; v.len()];
            }
            if v.len() != mean.len() {
                continue; // vector from an older model recipe — skip
            }
            for (m, x) in mean.iter_mut().zip(&v) {
                *m += x;
            }
            n += 1;
        }
        if n == 0 {
            return Ok(None);
        }
        for m in &mut mean {
            *m /= n as f32;
        }
        Ok(Some((mean, n)))
    }

    /// Mean embedding for every session that has any — the basis-fitting input.
    pub fn all_session_embedding_means(&self) -> Result<Vec<(String, Vec<f32>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.session_id, e.embedding
             FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.chunk_id
             WHERE c.agent_id IS NULL",
        )?;
        let mut acc: std::collections::HashMap<String, (Vec<f32>, i64)> = std::collections::HashMap::new();
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))?.flatten() {
            let (sid, blob) = row;
            let v = Self::decode_embedding(&blob);
            let entry = acc.entry(sid).or_insert_with(|| (vec![0.0; v.len()], 0));
            if entry.0.len() != v.len() {
                continue;
            }
            for (m, x) in entry.0.iter_mut().zip(&v) {
                *m += x;
            }
            entry.1 += 1;
        }
        Ok(acc
            .into_iter()
            .map(|(sid, (mut sum, n))| {
                for m in &mut sum {
                    *m /= n as f32;
                }
                (sid, sum)
            })
            .collect())
    }

    pub fn set_session_hue(&self, session_id: &str, hue: f64, embedded_chunks: i64) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO session_hues(session_id, hue, embedded_chunks) VALUES (?1, ?2, ?3)",
            params![session_id, hue, embedded_chunks],
        )?;
        Ok(())
    }

    pub fn session_hues(&self) -> Result<Vec<(String, f64)>> {
        let mut stmt = self.conn.prepare("SELECT session_id, hue FROM session_hues")?;
        let rows: Vec<(String, f64)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    // ---- sidebar folders ------------------------------------------------

    /// Create a folder at the end of the band. The id is caller-supplied (the
    /// frontend mints a UUID, same as pinned session ids); INSERT OR IGNORE so
    /// a backup restore can replay creations safely.
    pub fn create_folder(&self, folder_id: &str, name: &str) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        self.conn.execute(
            "INSERT OR IGNORE INTO folders(folder_id, name, position, created_at)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(position) + 1, 0) FROM folders), ?3)",
            params![folder_id, name, now],
        )?;
        Ok(())
    }

    pub fn rename_folder(&self, folder_id: &str, name: &str) -> Result<()> {
        self.conn.execute("UPDATE folders SET name = ?2 WHERE folder_id = ?1", params![folder_id, name])?;
        Ok(())
    }

    /// Delete a folder. Non-destructive for sessions: members simply return to
    /// their auto project groups (their membership rows go away with it).
    pub fn delete_folder(&mut self, folder_id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM folder_sessions WHERE folder_id = ?1", params![folder_id])?;
        tx.execute("DELETE FROM folders WHERE folder_id = ?1", params![folder_id])?;
        tx.commit()?;
        Ok(())
    }

    /// Rewrite the whole band's order (positions 0..n-1, in the given order).
    /// Ids not in the list keep their old position values — harmless, they sort
    /// after by the stable (position, created_at) order.
    pub fn reorder_folders(&mut self, ids: &[String]) -> Result<()> {
        let tx = self.conn.transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute("UPDATE folders SET position = ?2 WHERE folder_id = ?1", params![id, i as i64])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// File a session into a folder (Some) or back to its project group (None).
    /// INSERT OR REPLACE + the session_id PRIMARY KEY give move semantics: a
    /// session lives in at most one folder.
    pub fn set_session_folder(&self, session_id: &str, folder_id: Option<&str>) -> Result<()> {
        match folder_id {
            Some(f) => {
                let now = chrono::Utc::now().timestamp_millis();
                self.conn.execute(
                    "INSERT OR REPLACE INTO folder_sessions(session_id, folder_id, added_at) VALUES (?1, ?2, ?3)",
                    params![session_id, f, now],
                )?;
            }
            None => {
                self.conn.execute("DELETE FROM folder_sessions WHERE session_id = ?1", params![session_id])?;
            }
        }
        Ok(())
    }

    /// All folders in band order.
    pub fn list_folders(&self) -> Result<Vec<FolderRow>> {
        let mut stmt = self
            .conn
            .prepare("SELECT folder_id, name, position FROM folders ORDER BY position, created_at")?;
        let rows: Vec<FolderRow> = stmt
            .query_map([], |r| {
                Ok(FolderRow { folder_id: r.get(0)?, name: r.get(1)?, position: r.get(2)? })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Every (session_id, folder_id) membership. Memberships may reference
    /// sessions the index doesn't currently know (expired transcripts) — that's
    /// the point: they file themselves back in when the session returns.
    pub fn folder_memberships(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare("SELECT session_id, folder_id FROM folder_sessions")?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// The transcript file Drydock synced this session from, if any (radar-only
    /// stub sessions have none).
    pub fn transcript_path(&self, session_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                // agent sidecar rows share the parent's session_id — the
                // session's transcript is the one non-agent row
                "SELECT file_path FROM sync_state WHERE session_id = ?1 AND is_agent = 0",
                params![session_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// (file_path, session_id, is_agent) for every synced file — deletion
    /// mirroring needs to know whether a vanished path was a whole session's
    /// transcript or just one subagent sidecar file.
    pub fn all_synced_paths(&self) -> Result<Vec<(String, String, bool)>> {
        let mut stmt = self.conn.prepare(
            "SELECT file_path, session_id, is_agent FROM sync_state ORDER BY file_path",
        )?;
        let rows: Vec<(String, String, bool)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accumulator::SessionDelta;
    use crate::chunker::Chunk;

    fn mem() -> Store { Store::open_in_memory().unwrap() }

    fn delta(first: &str) -> SessionDelta {
        SessionDelta {
            session_id: Some("11111111-1111-1111-1111-111111111111".into()),
            project_path: Some("/Users/dev/work".into()),
            first_prompt: Some(first.into()),
            last_prompt: Some(first.into()),
            last_message_at: Some(1000),
            message_count: 2,
            user_message_count: 1,
            ..Default::default()
        }
    }

    #[test]
    fn folders_crud_ordering_and_move_semantics() {
        let mut s = mem();
        s.create_folder("f1", "Reviews").unwrap();
        s.create_folder("f2", "Experiments").unwrap();
        s.create_folder("f2", "dup ignored").unwrap(); // replayed create is a no-op
        let folders = s.list_folders().unwrap();
        assert_eq!(folders.len(), 2);
        assert_eq!((folders[0].name.as_str(), folders[0].position), ("Reviews", 0));
        assert_eq!((folders[1].name.as_str(), folders[1].position), ("Experiments", 1));

        // filing: one folder per session, last write wins (move, not tag)
        s.set_session_folder("sid-a", Some("f1")).unwrap();
        s.set_session_folder("sid-b", Some("f1")).unwrap();
        s.set_session_folder("sid-a", Some("f2")).unwrap();
        let members = s.folder_memberships().unwrap();
        assert_eq!(members.len(), 2);
        assert!(members.contains(&("sid-a".into(), "f2".into())));
        assert!(members.contains(&("sid-b".into(), "f1".into())));

        // unfiling
        s.set_session_folder("sid-b", None).unwrap();
        assert_eq!(s.folder_memberships().unwrap().len(), 1);

        // reorder rewrites positions in the given order
        s.reorder_folders(&["f2".into(), "f1".into()]).unwrap();
        let folders = s.list_folders().unwrap();
        assert_eq!(folders[0].folder_id, "f2");
        assert_eq!(folders[1].folder_id, "f1");

        s.rename_folder("f1", "Code Reviews").unwrap();
        assert_eq!(s.list_folders().unwrap()[1].name, "Code Reviews");

        // deleting a folder drops its memberships but not the sessions
        s.delete_folder("f2").unwrap();
        assert_eq!(s.list_folders().unwrap().len(), 1);
        assert!(s.folder_memberships().unwrap().is_empty(), "f2's membership went with it");
    }

    #[test]
    fn delete_session_prunes_folder_membership() {
        let mut s = mem();
        let sid = "11111111-1111-1111-1111-111111111111";
        s.apply_delta(sid, &delta("hello"), &[]).unwrap();
        s.create_folder("f1", "Work").unwrap();
        s.set_session_folder(sid, Some("f1")).unwrap();
        s.delete_session(sid).unwrap();
        assert!(s.folder_memberships().unwrap().is_empty());
        assert_eq!(s.list_folders().unwrap().len(), 1, "the folder itself survives");
    }

    #[test]
    fn folder_membership_outlives_the_session_row() {
        // the no-FK design: filing an id the index doesn't know must stick, so
        // an expired session that re-syncs later lands back in its folder
        let s = mem();
        s.create_folder("f1", "Archive").unwrap();
        s.set_session_folder("not-indexed-yet", Some("f1")).unwrap();
        assert_eq!(s.folder_memberships().unwrap().len(), 1);
    }

    #[test]
    fn apply_then_get_roundtrip() {
        let mut s = mem();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("hello"), &[
            Chunk { role: "user".into(), text: "user: hello\n".into(), ts: Some(1000) },
        ]).unwrap();
        let row = s.get_session("11111111-1111-1111-1111-111111111111").unwrap().unwrap();
        assert_eq!(row.project_path, "/Users/dev/work");
        assert_eq!(row.title, "hello");
        assert_eq!(row.title_source, "first-prompt");
        assert_eq!(row.message_count, 2);
        assert!(!row.hidden);
        assert_eq!(s.chunk_count("11111111-1111-1111-1111-111111111111").unwrap(), 1);
    }

    #[test]
    fn second_delta_merges_counts_and_keeps_first_prompt() {
        let mut s = mem();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("hello"), &[]).unwrap();
        let mut d2 = delta("ignored");
        d2.first_prompt = Some("later prompt".into()); // must NOT overwrite
        d2.last_message_at = Some(2000);
        d2.ai_title = Some("Now titled".into());
        s.apply_delta("11111111-1111-1111-1111-111111111111", &d2, &[]).unwrap();
        let row = s.get_session("11111111-1111-1111-1111-111111111111").unwrap().unwrap();
        assert_eq!(row.first_prompt.as_deref(), Some("hello"));
        assert_eq!(row.message_count, 4); // 2 + 2
        assert_eq!(row.last_message_at, Some(2000));
        assert_eq!(row.title, "Now titled");
        assert_eq!(row.title_source, "ai-title");
    }

    #[test]
    fn project_path_is_sticky_across_batches() {
        let mut s = mem();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("hello"), &[]).unwrap();
        let mut d2 = delta("more");
        d2.project_path = Some("/Users/dev/work/app".into()); // drifted cwd
        s.apply_delta("11111111-1111-1111-1111-111111111111", &d2, &[]).unwrap();
        let row = s.get_session("11111111-1111-1111-1111-111111111111").unwrap().unwrap();
        // the root cwd from the first batch survives, so resume stays correct
        assert_eq!(row.project_path, "/Users/dev/work");
    }

    #[test]
    fn radar_stub_empty_path_is_filled_by_transcript() {
        let mut s = mem();
        // stub first (empty path), then the real transcript delta arrives
        let mut stub = delta("hi");
        stub.project_path = Some(String::new());
        s.apply_delta("11111111-1111-1111-1111-111111111111", &stub, &[]).unwrap();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("hi"), &[]).unwrap();
        let row = s.get_session("11111111-1111-1111-1111-111111111111").unwrap().unwrap();
        assert_eq!(row.project_path, "/Users/dev/work");
    }

    #[test]
    fn starred_survives_updates() {
        let mut s = mem();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("hello"), &[]).unwrap();
        s.set_starred("11111111-1111-1111-1111-111111111111", true).unwrap();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("more"), &[]).unwrap();
        assert!(s.get_session("11111111-1111-1111-1111-111111111111").unwrap().unwrap().starred);
    }

    #[test]
    fn ghost_sessions_are_hidden() {
        let mut s = mem();
        let mut d = delta("x");
        d.user_message_count = 0;
        d.first_prompt = None;
        s.apply_delta("33333333-3333-3333-3333-333333333333", &d, &[]).unwrap();
        assert!(s.get_session("33333333-3333-3333-3333-333333333333").unwrap().unwrap().hidden);
    }

    #[test]
    fn delete_cascades() {
        let mut s = mem();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("hello"), &[
            Chunk { role: "user".into(), text: "t".into(), ts: None },
        ]).unwrap();
        s.set_sync_state("/tmp/f.jsonl", "11111111-1111-1111-1111-111111111111", 10, 99, None).unwrap();
        s.delete_session("11111111-1111-1111-1111-111111111111").unwrap();
        assert!(s.get_session("11111111-1111-1111-1111-111111111111").unwrap().is_none());
        assert_eq!(s.chunk_count("11111111-1111-1111-1111-111111111111").unwrap(), 0);
        assert!(s.get_sync_state("/tmp/f.jsonl").unwrap().is_none());
    }

    #[test]
    fn sync_state_roundtrip() {
        let mut s = mem();
        s.set_sync_state("/a/b.jsonl", "sid", 1234, 5678, Some("deadbeef")).unwrap();
        let st = s.get_sync_state("/a/b.jsonl").unwrap().unwrap();
        assert_eq!((st.byte_offset, st.mtime), (1234, 5678));
        assert_eq!(st.tail_hex.as_deref(), Some("deadbeef"));
        assert_eq!(
            s.all_synced_paths().unwrap(),
            vec![("/a/b.jsonl".to_string(), "sid".to_string(), false)]
        );

        // tail_hex is optional (pre-migration rows carry NULL)
        s.set_sync_state("/a/b.jsonl", "sid", 2000, 5679, None).unwrap();
        assert_eq!(s.get_sync_state("/a/b.jsonl").unwrap().unwrap().tail_hex, None);
    }

    #[test]
    fn transcript_path_never_returns_an_agent_sidecar() {
        let mut s = mem();
        // agent row synced FIRST (path sorts first too) — must still lose
        s.set_sync_state_kind("/p/a/sid/subagents/agent-x.jsonl", "sid", 10, 1, None, true).unwrap();
        assert_eq!(s.transcript_path("sid").unwrap(), None, "agent-only session has no transcript");
        s.set_sync_state("/p/b/sid.jsonl", "sid", 20, 2, None).unwrap();
        assert_eq!(s.transcript_path("sid").unwrap().as_deref(), Some("/p/b/sid.jsonl"));
    }

    fn live(sid: &str, status: &str, pid: u32, cwd: Option<&str>) -> crate::radar::LiveSession {
        crate::radar::LiveSession {
            pid,
            session_id: sid.to_string(),
            status: status.to_string(),
            updated_at: None,
            cwd: cwd.map(String::from),
        }
    }

    #[test]
    fn apply_live_sets_and_resets() {
        let mut s = mem();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("a"), &[]).unwrap();
        let mut d2 = delta("b");
        d2.session_id = Some("22222222-2222-2222-2222-222222222222".into());
        s.apply_delta("22222222-2222-2222-2222-222222222222", &d2, &[]).unwrap();

        s.apply_live(&[live("11111111-1111-1111-1111-111111111111", "busy", 101, None)]).unwrap();
        assert_eq!(s.get_session("11111111-1111-1111-1111-111111111111").unwrap().unwrap().live_status, "busy");
        assert_eq!(s.get_session("22222222-2222-2222-2222-222222222222").unwrap().unwrap().live_status, "ended");

        s.apply_live(&[]).unwrap(); // everything ended
        assert_eq!(s.get_session("11111111-1111-1111-1111-111111111111").unwrap().unwrap().live_status, "ended");
    }

    #[test]
    fn live_session_without_transcript_gets_stub_then_cleanup() {
        let mut s = mem();
        s.apply_live(&[live("99999999-9999-9999-9999-999999999999", "idle", 555, Some("/Users/x/proj"))]).unwrap();
        let row = s.get_session("99999999-9999-9999-9999-999999999999").unwrap().unwrap();
        assert_eq!(row.live_status, "idle");
        assert_eq!(row.project_path, "/Users/x/proj");
        assert_eq!(row.title_source, "radar-stub");

        s.apply_live(&[]).unwrap(); // session died with no transcript → stub removed entirely
        assert!(s.get_session("99999999-9999-9999-9999-999999999999").unwrap().is_none());
    }

    #[test]
    fn get_chunks_roundtrip() {
        let mut s = mem();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("a"), &[
            Chunk { role: "user".into(), text: "user: hello\n".into(), ts: Some(1) },
            Chunk { role: "recap".into(), text: "did things".into(), ts: Some(2) },
        ]).unwrap();
        let chunks = s.get_chunks("11111111-1111-1111-1111-111111111111").unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].role, "user");
        assert_eq!(chunks[1].text, "did things");
    }

    #[test]
    fn keyword_search_finds_and_ranks() {
        let mut s = mem();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("a"), &[
            Chunk { role: "user".into(), text: "user: fix the frigate camera bitrate\n".into(), ts: Some(1) },
        ]).unwrap();
        let mut d2 = delta("b");
        d2.session_id = Some("22222222-2222-2222-2222-222222222222".into());
        s.apply_delta("22222222-2222-2222-2222-222222222222", &d2, &[
            Chunk { role: "assistant".into(), text: "assistant: trading reports pipeline 报告管道\n".into(), ts: Some(2) },
        ]).unwrap();

        let hits = s.search_keyword("camera bitrate", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "11111111-1111-1111-1111-111111111111");
        assert!(hits[0].snippet.contains("bitrate"));

        // Chinese via trigram tokenizer
        let zh = s.search_keyword("报告管道", 10).unwrap();
        assert_eq!(zh.len(), 1);
        assert_eq!(zh[0].session_id, "22222222-2222-2222-2222-222222222222");

        // FTS special chars must not error (quoted-term sanitizing)
        assert!(s.search_keyword("c++ \"unbalanced", 10).is_ok());
    }

    #[test]
    fn keyword_search_excludes_deleted_sessions() {
        let mut s = mem();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("a"), &[
            Chunk { role: "user".into(), text: "user: zanzibar test\n".into(), ts: None },
        ]).unwrap();
        s.delete_session("11111111-1111-1111-1111-111111111111").unwrap();
        assert!(s.search_keyword("zanzibar", 10).unwrap().is_empty());
    }

    #[test]
    fn embedding_roundtrip_and_cosine_order() {
        let mut s = mem();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("a"), &[
            Chunk { role: "user".into(), text: "alpha".into(), ts: None },
            Chunk { role: "user".into(), text: "beta".into(), ts: None },
        ]).unwrap();
        let pending = s.chunks_without_embeddings(10).unwrap();
        assert_eq!(pending.len(), 2);

        // orthogonal toy vectors: chunk0 matches query exactly, chunk1 doesn't
        s.put_embedding(pending[0].0, &[1.0, 0.0, 0.0]).unwrap();
        s.put_embedding(pending[1].0, &[0.0, 1.0, 0.0]).unwrap();
        assert_eq!(s.chunks_without_embeddings(10).unwrap().len(), 0);

        let hits = s.search_semantic(&[1.0, 0.0, 0.0], 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].chunk_id, pending[0].0);
        assert!(hits[0].rank < hits[1].rank); // rank = 1 - cosine; lower is better
    }

    #[test]
    fn clear_embeddings_makes_chunks_pending_again() {
        let mut s = mem();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("a"), &[
            Chunk { role: "user".into(), text: "alpha".into(), ts: None },
            Chunk { role: "user".into(), text: "beta".into(), ts: None },
        ]).unwrap();
        let pending = s.chunks_without_embeddings(10).unwrap();
        for (id, _) in &pending {
            s.put_embedding(*id, &[1.0, 0.0]).unwrap();
        }
        assert_eq!(s.chunks_without_embeddings(10).unwrap().len(), 0);

        assert_eq!(s.clear_embeddings().unwrap(), 2); // both rows removed
        // every chunk is unembedded again, so the loop will re-embed them
        assert_eq!(s.chunks_without_embeddings(10).unwrap().len(), 2);
    }

    #[test]
    fn deleting_session_drops_embeddings() {
        let mut s = mem();
        s.apply_delta("11111111-1111-1111-1111-111111111111", &delta("a"), &[
            Chunk { role: "user".into(), text: "alpha".into(), ts: None },
        ]).unwrap();
        let pending = s.chunks_without_embeddings(10).unwrap();
        s.put_embedding(pending[0].0, &[1.0, 0.0]).unwrap();
        s.delete_session("11111111-1111-1111-1111-111111111111").unwrap();
        assert!(s.search_semantic(&[1.0, 0.0], 10).unwrap().is_empty());
    }

    // delta() puts last_message_at at 1000, so this "now" is 10 min of quiet later
    const QUIET_NOW: i64 = 1000 + 600_000;

    #[test]
    fn card_roundtrip_and_eligibility() {
        let mut s = mem();
        // session with 4 user turns (eligible)
        let mut d = delta("a");
        d.user_message_count = 4;
        d.message_count = 8;
        s.apply_delta("11111111-1111-1111-1111-111111111111", &d, &[]).unwrap();
        // session with 1 user turn (too short)
        let mut d2 = delta("b");
        d2.session_id = Some("22222222-2222-2222-2222-222222222222".into());
        d2.user_message_count = 1;
        s.apply_delta("22222222-2222-2222-2222-222222222222", &d2, &[]).unwrap();

        let need = s.sessions_needing_cards(10, QUIET_NOW).unwrap();
        assert_eq!(need.len(), 1);
        assert_eq!(need[0], "11111111-1111-1111-1111-111111111111");

        s.put_card("11111111-1111-1111-1111-111111111111", "fix telemetry", "[]", "fix telemetry", 8).unwrap();
        let card = s.get_card("11111111-1111-1111-1111-111111111111").unwrap().unwrap();
        assert_eq!(card.summary, "fix telemetry");
        assert_eq!(card.at_message_count, 8);
        // summary surfaces in the title-override map
        assert_eq!(
            s.card_summaries().unwrap(),
            vec![("11111111-1111-1111-1111-111111111111".to_string(), "fix telemetry".to_string())]
        );
        // fresh card → no longer needing
        assert!(s.sessions_needing_cards(10, QUIET_NOW).unwrap().is_empty());

        // transcript grows by >=5 (and the session is quiet) → stale again
        let mut d3 = delta("c");
        d3.message_count = 5;
        s.apply_delta("11111111-1111-1111-1111-111111111111", &d3, &[]).unwrap();
        assert_eq!(s.sessions_needing_cards(10, QUIET_NOW).unwrap().len(), 1);
    }

    #[test]
    fn card_staleness_requires_growth_and_quiet() {
        let mut s = mem();
        let mut d = delta("a");
        d.user_message_count = 4;
        d.message_count = 8;
        s.apply_delta("11111111-1111-1111-1111-111111111111", &d, &[]).unwrap();
        s.put_card("11111111-1111-1111-1111-111111111111", "fix telemetry", "[]", "fix telemetry", 8).unwrap();

        // growth below threshold (4 < 5): not stale even after 10 min of quiet
        let mut grow4 = delta("b");
        grow4.message_count = 4;
        grow4.user_message_count = 0;
        grow4.last_message_at = Some(50_000);
        s.apply_delta("11111111-1111-1111-1111-111111111111", &grow4, &[]).unwrap();
        assert!(s.sessions_needing_cards(10, 50_000 + 600_000).unwrap().is_empty());

        // growth reaches threshold but the session was active 1s ago: not stale
        let mut grow1 = delta("c");
        grow1.message_count = 1;
        grow1.user_message_count = 0;
        grow1.last_message_at = Some(60_000);
        s.apply_delta("11111111-1111-1111-1111-111111111111", &grow1, &[]).unwrap();
        assert!(s.sessions_needing_cards(10, 60_000 + 1_000).unwrap().is_empty());

        // same growth after 10 min of quiet: stale
        assert_eq!(s.sessions_needing_cards(10, 60_000 + 600_000).unwrap().len(), 1);
    }

    #[test]
    fn card_text_is_searchable_but_hidden_from_transcript() {
        let mut s = mem();
        let sid = "11111111-1111-1111-1111-111111111111";
        s.apply_delta(sid, &delta("hi"), &[
            Chunk { role: "user".into(), text: "deploy the widget".into(), ts: None },
        ]).unwrap();
        s.put_card(sid, "telemetry pipeline", "[]", "telemetry pipeline via utils", 4).unwrap();

        // keyword search surfaces the session via the card text...
        assert!(s.search_keyword("telemetry", 10).unwrap().iter().any(|h| h.session_id == sid));
        // ...the card chunk is queued for embedding (so semantic search gets it too)...
        assert!(s.chunks_without_embeddings(10).unwrap().iter().any(|(_, t)| t.contains("telemetry")));
        // ...but it never shows in the transcript view.
        let chunks = s.get_chunks(sid).unwrap();
        assert!(chunks.iter().all(|c| c.role != "card"));
        assert_eq!(chunks.len(), 1);
    }

    #[test]
    fn regenerating_a_card_replaces_its_search_chunk() {
        let mut s = mem();
        let sid = "11111111-1111-1111-1111-111111111111";
        s.apply_delta(sid, &delta("hi"), &[]).unwrap();
        s.put_card(sid, "old", "[]", "telemetry pipeline", 4).unwrap();
        s.put_card(sid, "new", "[]", "billing dashboard", 5).unwrap();
        assert!(s.search_keyword("telemetry", 10).unwrap().is_empty());
        assert!(s.search_keyword("billing", 10).unwrap().iter().any(|h| h.session_id == sid));
        let n: i64 = s.conn
            .query_row("SELECT COUNT(*) FROM chunks WHERE session_id=?1 AND role='card'", params![sid], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn backfills_card_search_chunk_for_existing_cards() {
        let mut s = mem();
        let sid = "11111111-1111-1111-1111-111111111111";
        s.apply_delta(sid, &delta("hi"), &[]).unwrap();
        // a card row from before card-search existed: no `card` chunk
        s.conn.execute(
            "INSERT INTO cards(session_id, summary, timeline, generated_at, at_message_count) VALUES (?1,'s','[]',0,1)",
            params![sid],
        ).unwrap();
        assert_eq!(s.cards_without_search_chunk().unwrap(), vec![sid.to_string()]);
        s.put_card_search_chunk(sid, "indexed now").unwrap();
        assert!(s.cards_without_search_chunk().unwrap().is_empty());
        assert!(s.search_keyword("indexed", 10).unwrap().iter().any(|h| h.session_id == sid));
    }

    #[test]
    fn busy_sessions_are_not_carded() {
        let mut s = mem();
        let mut d = delta("a");
        d.user_message_count = 4;
        s.apply_delta("11111111-1111-1111-1111-111111111111", &d, &[]).unwrap();
        s.apply_live(&[live("11111111-1111-1111-1111-111111111111", "busy", 1, None)]).unwrap();
        assert!(s.sessions_needing_cards(10, QUIET_NOW).unwrap().is_empty());
        s.apply_live(&[live("11111111-1111-1111-1111-111111111111", "idle", 1, None)]).unwrap();
        assert_eq!(s.sessions_needing_cards(10, QUIET_NOW).unwrap().len(), 1);
    }

    #[test]
    fn open_enables_wal_for_file_dbs() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::open(&tmp.path().join("wal.db")).unwrap();
        let mode: String = s.conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }

    #[test]
    fn hide_persists_and_delete_cleans_it_up() {
        let mut s = mem();
        let sid = "11111111-1111-1111-1111-111111111111";
        s.apply_delta(sid, &delta("hi"), &[]).unwrap();
        assert!(s.hidden_session_ids().unwrap().is_empty());

        s.set_session_hidden(sid, true).unwrap();
        assert_eq!(s.hidden_session_ids().unwrap(), vec![sid.to_string()]);
        // a re-sync (recomputes the ghost `hidden` column) must not unhide it
        s.apply_delta(sid, &delta("more"), &[]).unwrap();
        assert_eq!(s.hidden_session_ids().unwrap(), vec![sid.to_string()]);

        s.set_session_hidden(sid, false).unwrap();
        assert!(s.hidden_session_ids().unwrap().is_empty());

        // deleting the session drops any hidden entry too
        s.set_session_hidden(sid, true).unwrap();
        s.delete_session(sid).unwrap();
        assert!(s.hidden_session_ids().unwrap().is_empty());
    }

    #[test]
    fn session_names_set_rename_clear_and_survive_resync() {
        let mut s = Store::open_in_memory().unwrap();
        let sid = "s-named";
        s.apply_delta(sid, &delta("hi"), &[]).unwrap();
        assert!(s.session_names().unwrap().is_empty());

        s.set_session_name(sid, "  release pipeline  ").unwrap();
        assert_eq!(s.session_names().unwrap(), vec![(sid.to_string(), "release pipeline".to_string())], "stored trimmed");

        // rename replaces (upsert, not a second row)
        s.set_session_name(sid, "release CI").unwrap();
        assert_eq!(s.session_names().unwrap(), vec![(sid.to_string(), "release CI".to_string())]);

        // a re-sync rewriting the session row must not clobber the name
        s.apply_delta(sid, &delta("more"), &[]).unwrap();
        assert_eq!(s.session_names().unwrap().len(), 1);

        // blank clears the override
        s.set_session_name(sid, "   ").unwrap();
        assert!(s.session_names().unwrap().is_empty());

        // a USER delete drops the name (an explicit delete means "gone")
        s.set_session_name(sid, "gone").unwrap();
        s.delete_session(sid).unwrap();
        assert!(s.session_names().unwrap().is_empty());
    }

    #[test]
    fn sync_driven_reparse_preserves_names_hidden_and_folders() {
        // The watcher deletes-and-reparses a session when its file is
        // truncated/rewritten, and mirrors deletions when files vanish. Those
        // are DATA events, not user intent: names, hidden flags and folder
        // filings must survive and reattach when the session returns.
        let mut s = Store::open_in_memory().unwrap();
        let sid = "s-reparse";
        s.apply_delta(sid, &delta("hi"), &[]).unwrap();
        s.set_session_name(sid, "release CI").unwrap();
        s.set_session_hidden(sid, true).unwrap();
        s.create_folder("f1", "infra").unwrap();
        s.set_session_folder(sid, Some("f1")).unwrap();

        // truncate-reparse / vanished-transcript path
        s.delete_session_data(sid).unwrap();
        assert!(s.get_session(sid).unwrap().is_none(), "row and derived data gone");
        assert_eq!(s.session_names().unwrap().len(), 1, "name survives");
        assert_eq!(s.hidden_session_ids().unwrap(), vec![sid.to_string()], "hidden survives");
        assert_eq!(s.folder_memberships().unwrap().len(), 1, "filing survives");

        // the session returns (re-synced from byte 0) → flags reattach
        s.apply_delta(sid, &delta("hi again"), &[]).unwrap();
        assert_eq!(s.session_names().unwrap(), vec![(sid.to_string(), "release CI".to_string())]);
    }

    #[test]
    fn session_name_is_capped_server_side() {
        let mut s = Store::open_in_memory().unwrap();
        let sid = "s-cap";
        s.apply_delta(sid, &delta("hi"), &[]).unwrap();
        s.set_session_name(sid, &"x".repeat(100_000)).unwrap();
        let stored = &s.session_names().unwrap()[0].1;
        assert!(stored.chars().count() <= 200, "cap ignores the frontend's honesty");
    }
}
