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
    pub slug: Option<String>,
    pub starred: bool,
    pub hidden: bool,
    pub live_status: String,
    pub live_pid: Option<i64>,
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
    pub goal: String,
    pub state: String,
    pub next_step: String,
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
  git_branch TEXT, cli_version TEXT, ai_title TEXT, slug TEXT,
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
  ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
CREATE TABLE IF NOT EXISTS sync_state(
  file_path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  tail_hex TEXT
);
CREATE TABLE IF NOT EXISTS pins(
  project_path TEXT PRIMARY KEY,
  pinned_at INTEGER NOT NULL
);
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
CREATE TABLE IF NOT EXISTS cards(
  session_id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  state TEXT NOT NULL,
  next_step TEXT NOT NULL,
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
               git_branch, cli_version, ai_title, slug, hidden)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
             ON CONFLICT(session_id) DO UPDATE SET
               project_path=excluded.project_path, title=excluded.title,
               title_source=excluded.title_source, latest_recap=excluded.latest_recap,
               first_prompt=excluded.first_prompt, last_prompt=excluded.last_prompt,
               last_message_at=excluded.last_message_at, message_count=excluded.message_count,
               user_message_count=excluded.user_message_count, git_branch=excluded.git_branch,
               cli_version=excluded.cli_version, ai_title=excluded.ai_title,
               slug=excluded.slug, hidden=excluded.hidden",
            params![
                session_id, merged.project_path.clone().unwrap_or_default(), title, title_source,
                merged.latest_recap, merged.first_prompt, merged.last_prompt, merged.last_message_at,
                merged.message_count, merged.user_message_count, merged.git_branch,
                merged.cli_version, merged.ai_title, merged.slug, hidden as i64
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
                    cli_version, ai_title, slug, starred, hidden, live_status, live_pid
             FROM sessions WHERE session_id = ?1",
            params![session_id],
            |r| Ok(SessionRow {
                session_id: r.get(0)?, project_path: r.get(1)?, title: r.get(2)?,
                title_source: r.get(3)?, latest_recap: r.get(4)?, first_prompt: r.get(5)?,
                last_prompt: r.get(6)?, last_message_at: r.get(7)?, message_count: r.get(8)?,
                user_message_count: r.get(9)?, git_branch: r.get(10)?, cli_version: r.get(11)?,
                ai_title: r.get(12)?, slug: r.get(13)?,
                starred: r.get::<_, i64>(14)? != 0, hidden: r.get::<_, i64>(15)? != 0,
                live_status: r.get(16)?, live_pid: r.get(17)?,
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

    pub fn delete_session(&mut self, session_id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM chunks_fts WHERE session_id = ?1", params![session_id])?;
        tx.execute(
            "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE session_id = ?1)",
            params![session_id],
        )?;
        tx.execute("DELETE FROM chunks WHERE session_id = ?1", params![session_id])?;
        tx.execute("DELETE FROM cards WHERE session_id = ?1", params![session_id])?;
        tx.execute("DELETE FROM sync_state WHERE session_id = ?1", params![session_id])?;
        tx.execute("DELETE FROM sessions WHERE session_id = ?1", params![session_id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn chunk_count(&self, session_id: &str) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM chunks WHERE session_id = ?1",
            params![session_id], |r| r.get(0))?)
    }

    pub fn set_sync_state(&mut self, file_path: &str, session_id: &str, byte_offset: i64, mtime: i64, tail_hex: Option<&str>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO sync_state(file_path, session_id, byte_offset, mtime, tail_hex) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(file_path) DO UPDATE SET session_id=excluded.session_id,
               byte_offset=excluded.byte_offset, mtime=excluded.mtime, tail_hex=excluded.tail_hex",
            params![file_path, session_id, byte_offset, mtime, tail_hex])?;
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
        tx.execute(
            "DELETE FROM sessions WHERE live_status = 'ended' AND title_source = 'radar-stub'",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_chunks(&self, session_id: &str) -> Result<Vec<Chunk>> {
        let mut stmt = self.conn.prepare(
            "SELECT role, text, ts FROM chunks WHERE session_id = ?1 ORDER BY seq",
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
            "SELECT session_id, goal, state, next_step, generated_at, at_message_count
             FROM cards WHERE session_id = ?1",
            params![session_id],
            |r| Ok(Card {
                session_id: r.get(0)?, goal: r.get(1)?, state: r.get(2)?,
                next_step: r.get(3)?, generated_at: r.get(4)?, at_message_count: r.get(5)?,
            }),
        ).optional()?)
    }

    pub fn put_card(&mut self, session_id: &str, goal: &str, state: &str, next_step: &str, at_message_count: i64) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        self.conn.execute(
            "INSERT OR REPLACE INTO cards(session_id, goal, state, next_step, generated_at, at_message_count)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![session_id, goal, state, next_step, now, at_message_count],
        )?;
        Ok(())
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
             WHERE e.chunk_id IS NULL ORDER BY c.chunk_id LIMIT ?1",
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

    /// Toggle a project pin; returns the new pinned state.
    pub fn toggle_pin(&mut self, project_path: &str) -> Result<bool> {
        let removed = self.conn.execute("DELETE FROM pins WHERE project_path = ?1", params![project_path])?;
        if removed > 0 {
            return Ok(false);
        }
        let now = chrono::Utc::now().timestamp_millis();
        self.conn.execute("INSERT INTO pins(project_path, pinned_at) VALUES (?1, ?2)", params![project_path, now])?;
        Ok(true)
    }

    pub fn pinned_projects(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT project_path FROM pins ORDER BY pinned_at")?;
        let rows: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn all_synced_paths(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT file_path FROM sync_state ORDER BY file_path")?;
        let rows: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
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
        assert_eq!(s.all_synced_paths().unwrap(), vec!["/a/b.jsonl".to_string()]);

        // tail_hex is optional (pre-migration rows carry NULL)
        s.set_sync_state("/a/b.jsonl", "sid", 2000, 5679, None).unwrap();
        assert_eq!(s.get_sync_state("/a/b.jsonl").unwrap().unwrap().tail_hex, None);
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

        s.put_card("11111111-1111-1111-1111-111111111111", "goal", "state", "next", 8).unwrap();
        let card = s.get_card("11111111-1111-1111-1111-111111111111").unwrap().unwrap();
        assert_eq!(card.goal, "goal");
        assert_eq!(card.at_message_count, 8);
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
        s.put_card("11111111-1111-1111-1111-111111111111", "goal", "state", "next", 8).unwrap();

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
    fn pin_toggle_roundtrip() {
        let mut s = mem();
        assert!(s.pinned_projects().unwrap().is_empty());
        assert!(s.toggle_pin("/a").unwrap());
        assert!(s.toggle_pin("/b").unwrap());
        assert!(!s.toggle_pin("/a").unwrap()); // second toggle unpins
        assert_eq!(s.pinned_projects().unwrap(), vec!["/b".to_string()]);
    }
}
