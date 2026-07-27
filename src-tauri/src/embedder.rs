//! Background embedding: keep every chunk's vector current for semantic
//! search, with as little memory and as few wakeups as possible.
//!
//! Two properties of the ONNX runtime shape this file. Its arena allocator is
//! grow-only -- the largest `embed()` call a process ever makes becomes that
//! process's memory floor until it exits -- and attention scratch grows as
//! `batch x heads x tokens^2 x 4B`. Batches of 32 full-length chunks reserved
//! ~1.9GB that was never handed back, so a batch is now capped by BOTH item
//! count and character count (see `pace`).
//!
//! Deliberately NOT done: truncating chunk text before embedding. e5 already
//! truncates at 512 tokens, which ~2,000 characters barely reaches, so a
//! character cap would only discard text the model was about to read -- and
//! since it changes the vectors it would force `EMBEDDING_VERSION` up and
//! re-embed the whole corpus (~14.5M characters, tens of minutes of CPU, with
//! search reduced to keyword-only ranking throughout). Capping the batch buys
//! the same memory without touching a single stored vector.

use std::sync::atomic::{AtomicU8, Ordering};

/// 0 = unavailable, 1 = indexing, 2 = ready (model loaded, all chunks embedded)
pub static SEMANTIC_STATE: AtomicU8 = AtomicU8::new(0);

pub fn semantic_status() -> &'static str {
    match SEMANTIC_STATE.load(Ordering::Relaxed) {
        2 => "ready",
        1 => "indexing",
        _ => "unavailable",
    }
}

/// The drain loop's pure decisions: how big a batch may be, and how long to
/// sleep after an iteration. They live OUTSIDE `imp` because `imp` needs
/// fastembed and a real 110MB ONNX model to exercise anything, and the rules
/// that keep the loop from spinning are exactly the ones that must be provable
/// without one.
#[cfg_attr(not(feature = "semantic"), allow(dead_code))]
pub mod pace {
    use std::time::Duration;

    /// Chunks per `embed()` call. Was 32: the arena is grow-only, so that peak
    /// (32 x 12 heads x 512^2 x 4B ~= 400MB of attention scratch) became the
    /// process's memory floor for the rest of its life.
    pub const MAX_BATCH: usize = 8;

    /// ...and characters per call, which is the cap that actually bites. The
    /// corpus is bimodal -- median chunk 149 chars, but 21% run to the
    /// 2,000-char chunker limit -- and a batch is padded to its LONGEST member,
    /// so eight maximal chunks would rebuild the old peak while eight median
    /// ones cost nothing. Those go three at a time instead.
    pub const BATCH_CHAR_BUDGET: usize = 6_000;

    /// Failed attempts before a chunk is skipped (until the next reconcile), so
    /// one unstorable row cannot hold the queue -- or a core.
    pub const MAX_EMBED_ATTEMPTS: i64 = 5;

    /// How many of `pending` may go into one `embed()` call. Never zero for a
    /// non-empty slice: a single chunk over the character budget still has to
    /// be embedded, and returning 0 would be a spin, not a small batch.
    pub fn batch_len(pending: &[(i64, String)]) -> usize {
        let mut chars = 0;
        for (i, (_, text)) in pending.iter().take(MAX_BATCH).enumerate() {
            chars += text.chars().count();
            if chars > BATCH_CHAR_BUDGET && i > 0 {
                return i;
            }
        }
        pending.len().min(MAX_BATCH)
    }

    /// What one iteration of the drain loop accomplished.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Step {
        /// At least one embedding was STORED -- the only outcome that earns
        /// another immediate iteration.
        Progress,
        /// Nothing pending: the steady state, ~all of the time.
        Drained,
        /// Rows were pending and none of them landed (model error, failed
        /// write, poison row). Must never be retried at full speed.
        Stalled,
    }

    /// Sleep schedule for the drain loop.
    ///
    /// The loop does not sleep after useful work -- a fresh index has ~25k
    /// chunks to get through and pauses there are pure latency. That is only
    /// safe because every OTHER outcome sleeps: previously a chunk that
    /// embedded but failed to store re-entered the loop instantly, pinning a
    /// core with a table scan plus an ONNX inference, indefinitely.
    #[derive(Debug, Default)]
    pub struct Pacer {
        drained: u32,
        stalled: u32,
    }

    impl Pacer {
        /// First idle poll, doubling to `IDLE_MAX` so an untouched machine
        /// stops waking 28,800 times a day. New chunks are keyword-searchable
        /// the moment they are written, so the cap only delays the newest turn
        /// joining the SEMANTIC index.
        const IDLE_BASE: Duration = Duration::from_secs(3);
        const IDLE_MAX: Duration = Duration::from_secs(30);
        /// A stall is abnormal, so it backs off much harder than an idle poll.
        const STALL_BASE: Duration = Duration::from_secs(5);
        const STALL_MAX: Duration = Duration::from_secs(120);

        pub fn next_delay(&mut self, step: Step) -> Duration {
            match step {
                Step::Progress => {
                    self.drained = 0;
                    self.stalled = 0;
                    Duration::ZERO
                }
                Step::Drained => {
                    self.stalled = 0;
                    self.drained += 1;
                    Self::backoff(Self::IDLE_BASE, Self::IDLE_MAX, self.drained)
                }
                Step::Stalled => {
                    self.drained = 0;
                    self.stalled += 1;
                    Self::backoff(Self::STALL_BASE, Self::STALL_MAX, self.stalled)
                }
            }
        }

        /// `base x 2^(n-1)`, capped. Saturating and shift-clamped because this
        /// counter runs for the life of the process.
        fn backoff(base: Duration, max: Duration, n: u32) -> Duration {
            base.saturating_mul(1u32 << n.saturating_sub(1).min(16)).min(max)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn chunks(sizes: &[usize]) -> Vec<(i64, String)> {
            sizes.iter().enumerate().map(|(i, n)| (i as i64, "x".repeat(*n))).collect()
        }

        #[test]
        fn batch_is_capped_by_items_then_by_characters() {
            // ordinary traffic: the median chunk is ~150 chars, so items bind
            assert_eq!(batch_len(&chunks(&[150; 20])), MAX_BATCH);
            // the case that sets the arena high-water mark: maximal chunks
            assert_eq!(batch_len(&chunks(&[2000; 8])), 3);
            // a short queue is never over-reported
            assert_eq!(batch_len(&chunks(&[150; 2])), 2);
        }

        #[test]
        fn an_oversize_chunk_still_gets_embedded() {
            // returning 0 here would be an infinite loop, not a small batch
            assert_eq!(batch_len(&chunks(&[BATCH_CHAR_BUDGET * 3])), 1);
            assert_eq!(batch_len(&chunks(&[BATCH_CHAR_BUDGET * 3, 10])), 1);
        }

        #[test]
        fn the_budget_counts_characters_not_bytes() {
            // transcripts are part Chinese; counting bytes would make the
            // budget bind 3x too early and shrink batches for no reason
            let cjk: Vec<(i64, String)> = (0..8).map(|i| (i, "\u{6f22}".repeat(700))).collect();
            assert_eq!(batch_len(&cjk), MAX_BATCH); // 5,600 chars = 16,800 bytes
        }

        #[test]
        fn progress_never_sleeps() {
            // the drain has to stay fast; that is why Stalled exists at all
            let mut p = Pacer::default();
            for _ in 0..1000 {
                assert_eq!(p.next_delay(Step::Progress), Duration::ZERO);
            }
        }

        #[test]
        fn a_stall_can_never_spin() {
            // the latent P3 bug: embed succeeded, the write failed, and the
            // loop went straight back into a full scan plus an inference
            let mut p = Pacer::default();
            assert_eq!(p.next_delay(Step::Progress), Duration::ZERO);
            let first = p.next_delay(Step::Stalled);
            assert!(first >= Duration::from_secs(5), "a stall always sleeps: {first:?}");
            let mut last = first;
            for _ in 0..10 {
                let d = p.next_delay(Step::Stalled);
                assert!(d >= last, "backoff never shrinks while stalled");
                last = d;
            }
            assert_eq!(last, Duration::from_secs(120), "and it stops at the cap");
        }

        #[test]
        fn idle_backs_off_and_work_resets_it() {
            let mut p = Pacer::default();
            assert_eq!(p.next_delay(Step::Drained), Duration::from_secs(3));
            assert_eq!(p.next_delay(Step::Drained), Duration::from_secs(6));
            assert_eq!(p.next_delay(Step::Drained), Duration::from_secs(12));
            assert_eq!(p.next_delay(Step::Drained), Duration::from_secs(24));
            for _ in 0..100 {
                assert_eq!(p.next_delay(Step::Drained), Duration::from_secs(30));
            }
            // a new chunk arrives: back to a fast poll, not a 30s wait
            assert_eq!(p.next_delay(Step::Progress), Duration::ZERO);
            assert_eq!(p.next_delay(Step::Drained), Duration::from_secs(3));
        }

        #[test]
        fn recovering_from_a_stall_resets_the_stall_backoff() {
            let mut p = Pacer::default();
            for _ in 0..5 {
                p.next_delay(Step::Stalled);
            }
            assert_eq!(p.next_delay(Step::Progress), Duration::ZERO);
            assert_eq!(p.next_delay(Step::Stalled), Duration::from_secs(5));
        }
    }
}

#[cfg(feature = "semantic")]
pub mod imp {
    use super::pace::{batch_len, Pacer, Step, MAX_BATCH, MAX_EMBED_ATTEMPTS};
    use super::SEMANTIC_STATE;
    use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
    use drydock_core::store::Store;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;
    use std::sync::OnceLock;
    use std::time::Duration;

    // OnceLock, not Mutex: embed() takes &self, so queries never wait on the
    // background batch loop (which used to hold a lock for seconds per batch).
    static MODEL: OnceLock<TextEmbedding> = OnceLock::new();

    // Bump this string whenever the embedding recipe changes (model, prefix,
    // pooling) to force a one-time re-embed of every chunk on next launch.
    const EMBEDDING_VERSION: &str = "e5-small-passage-v1";

    /// Wait before taking a fresh connection after one stops answering.
    const REOPEN_DELAY: Duration = Duration::from_secs(5);
    /// Consecutive failed queue reads before the connection is written off.
    /// Reopening is how the old per-tick `Store::open` shrugged off a locked or
    /// replaced DB; with one long-lived connection we have to ask for it.
    const DB_ERROR_LIMIT: u32 = 5;
    /// How often the queue is re-derived from the anti-join it materializes.
    const RECONCILE_EVERY: Duration = Duration::from_secs(1800);

    /// Background loop: load the model once (downloads ~110MB on first run),
    /// then drain unembedded chunks forever at low priority. Once drained, it
    /// also refreshes the semantic session hues (see `hues`) and pokes the UI.
    pub fn run(db_path: PathBuf, cache_dir: PathBuf, emit: tauri::AppHandle) {
        let model = match TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::MultilingualE5Small).with_cache_dir(cache_dir),
        ) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("semantic search disabled (model init failed): {e:#}");
                SEMANTIC_STATE.store(0, Ordering::Relaxed);
                return;
            }
        };
        let _ = MODEL.set(model);
        let Some(model) = MODEL.get() else { return };
        SEMANTIC_STATE.store(1, Ordering::Relaxed);

        let mut migrated = false;
        loop {
            let Ok(mut store) = Store::open(&db_path) else {
                std::thread::sleep(REOPEN_DELAY);
                continue;
            };
            // One-time re-embed, on the first store we can actually open (the
            // watcher's initial sync may hold the lock for a moment at startup):
            // older embeddings lack the e5 `passage:` prefix and so sit in a
            // different space than `query:`-prefixed searches. On a recipe
            // version change, drop every vector so the loop re-embeds them all.
            if !migrated {
                if store.meta_get("embedding_version").ok().flatten().as_deref() != Some(EMBEDDING_VERSION) {
                    if let Ok(n) = store.clear_embeddings() {
                        if n > 0 {
                            eprintln!("re-embedding {n} chunks with the e5 passage: prefix");
                        }
                    }
                    let _ = store.meta_set("embedding_version", EMBEDDING_VERSION);
                }
                migrated = true;
            }
            // The connection is now long-lived -- reopening it 28,800 times a
            // day re-ran 16 CREATE ... IF NOT EXISTS statements for nothing --
            // so `drain` hands it back when it stops answering and we take a
            // fresh one here.
            drain(&mut store, model, &emit);
            std::thread::sleep(REOPEN_DELAY);
        }
    }

    /// Keep the queue empty on one connection. Returns only when that
    /// connection has failed `DB_ERROR_LIMIT` reads in a row.
    fn drain(store: &mut Store, model: &TextEmbedding, emit: &tauri::AppHandle) {
        use tauri::Emitter;
        let mut pacer = Pacer::default();
        // hue maintenance is due at startup (catch up on earlier runs) and
        // after any embedding work; stale-ness can't change otherwise
        let mut recolor_due = true;
        let mut db_errors = 0u32;
        // Set after a multi-row batch fails in the model, so the next pass
        // isolates the offending chunk (see the `narrow` use below).
        let mut narrow = false;
        // `embed_queue` is a materialized view of the "no vector yet" anti-join,
        // kept current by DB triggers. Re-deriving it on connect and on a slow
        // timer is what makes trusting it safe -- including across a DB shared
        // with an older build (see Store::reconcile_embed_queue).
        let mut reconciled_at = std::time::Instant::now();
        let _ = store.reconcile_embed_queue();
        loop {
            if reconciled_at.elapsed() >= RECONCILE_EVERY {
                reconciled_at = std::time::Instant::now();
                let _ = store.reconcile_embed_queue();
            }
            let pending = match store.pending_embeddings(MAX_BATCH as i64, MAX_EMBED_ATTEMPTS) {
                Ok(rows) => {
                    db_errors = 0;
                    rows
                }
                Err(e) => {
                    db_errors += 1;
                    eprintln!("embed queue read failed ({db_errors}): {e:#}");
                    if db_errors >= DB_ERROR_LIMIT {
                        return; // run() reopens
                    }
                    std::thread::sleep(pacer.next_delay(Step::Stalled));
                    continue;
                }
            };
            let step = if pending.is_empty() {
                // Rows parked past MAX_EMBED_ATTEMPTS are filtered OUT of
                // `pending`, so an empty page is not the same as an embedded
                // corpus. Report "ready" only when the queue itself is empty --
                // otherwise the search palette drops its "semantic index
                // catching up -- keyword results" hint while recall really is
                // still incomplete, which is a lie the user cannot see through.
                let all_done = store.embed_queue_is_empty().unwrap_or(false);
                SEMANTIC_STATE.store(if all_done { 2 } else { 1 }, Ordering::Relaxed);
                if recolor_due {
                    recolor_due = false;
                    if crate::hues::refresh(store) > 0 {
                        let _ = emit.emit("index-updated", ()); // recolor the sidebar/tabs now
                    }
                }
                Step::Drained
            } else {
                SEMANTIC_STATE.store(1, Ordering::Relaxed);
                // After a whole-batch model failure, retry one row at a time so
                // the blame lands on the chunk that actually caused it instead
                // of on the healthy rows that happened to share its batch.
                let n = if narrow { 1 } else { batch_len(&pending) };
                let step = embed_batch(store, model, &pending[..n]);
                narrow = step == Step::Stalled && n > 1;
                recolor_due |= step == Step::Progress;
                step
            };
            let delay = pacer.next_delay(step);
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
        }
    }

    /// Embed one batch and store what comes back. `Progress` means at least one
    /// vector actually LANDED -- that distinction is the whole point: a batch
    /// that embeds but fails to write leaves its rows pending, and calling that
    /// progress is what let this loop run a table scan and an ONNX inference
    /// back to back, forever, on one bad row.
    fn embed_batch(store: &mut Store, model: &TextEmbedding, batch: &[(i64, String)]) -> Step {
        // e5 documents must carry the `passage:` prefix (paired with the
        // `query:` prefix on searches); fastembed does not add it for us.
        let texts: Vec<String> = batch.iter().map(|(_, t)| format!("passage: {t}")).collect();
        let vecs = match model.embed(texts, None) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("embed batch failed ({} chunks): {e:#}", batch.len());
                // A failed CALL is not evidence against any individual row --
                // up to MAX_BATCH-1 innocent chunks were along for the ride,
                // and blaming them all would park healthy work five attempts
                // later. Only a batch of one names its offender; for anything
                // wider, `drain` retries narrowed to a single chunk.
                if batch.len() == 1 {
                    let _ = store.bump_embed_attempts(&[batch[0].0]);
                }
                return Step::Stalled;
            }
        };
        let mut stored: Vec<i64> = Vec::with_capacity(batch.len());
        for ((chunk_id, _), v) in batch.iter().zip(vecs) {
            match store.put_embedding(*chunk_id, &v) {
                Ok(()) => stored.push(*chunk_id),
                // not `let _ =`: a write that fails silently here is precisely
                // the condition that used to peg a core
                Err(e) => eprintln!("chunk {chunk_id} embedded but did not store: {e:#}"),
            }
        }
        // everything we did NOT store counts as an attempt -- including a row
        // the model returned no vector for -- so nothing is retried forever
        let missed: Vec<i64> =
            batch.iter().map(|(id, _)| *id).filter(|id| !stored.contains(id)).collect();
        if !missed.is_empty() {
            let _ = store.bump_embed_attempts(&missed);
        }
        if stored.is_empty() {
            Step::Stalled
        } else {
            Step::Progress
        }
    }

    /// Embed a search query. e5 models pair a `query:` prefix on searches with
    /// a `passage:` prefix on documents; fastembed adds neither, so we prepend
    /// it here (and `passage:` in the background loop).
    pub fn embed_query(q: &str) -> Option<Vec<f32>> {
        let model = MODEL.get()?;
        model
            .embed(vec![format!("query: {q}")], None)
            .ok()?
            .into_iter()
            .next()
    }
}

#[cfg(not(feature = "semantic"))]
pub mod imp {
    use std::path::PathBuf;
    pub fn run(_db: PathBuf, _cache: PathBuf, _emit: tauri::AppHandle) {}
    pub fn embed_query(_q: &str) -> Option<Vec<f32>> {
        None
    }
}
