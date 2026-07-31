//! Background embedding on a SCHEDULE: load the model, drain the queue, drop
//! the model, sleep half a day. Between runs semantic queries return nothing
//! and search serves keyword ranking — a deliberate trade.
//!
//! Two properties of the ONNX runtime shape this file. Its arena allocator is
//! grow-only -- the largest `embed()` call a process ever makes becomes that
//! process's memory floor FOR AS LONG AS THE SESSION LIVES -- and attention
//! scratch grows as `batch x heads x tokens^2 x 4B`. Batches of 32 full-length
//! chunks reserved ~1.9GB; capping batches (see `pace`) brought the arena to
//! ~512MB, but a resident model still made that half-gigabyte the app's
//! permanent floor. Dropping the model between runs releases the arena AND the
//! ~110MB of weights; a machine under memory pressure gets all of it back for
//! the ~23.9 hours a day the queue is empty anyway. New chunks are
//! keyword-searchable the moment they are written, so the schedule only delays
//! the newest turns joining the SEMANTIC index, never their findability.
//!
//! Deliberately NOT done: truncating chunk text before embedding. e5 already
//! truncates at 512 tokens, which ~2,000 characters barely reaches, so a
//! character cap would only discard text the model was about to read -- and
//! since it changes the vectors it would force `EMBEDDING_VERSION` up and
//! re-embed the whole corpus (~14.5M characters, tens of minutes of CPU, with
//! search reduced to keyword-only ranking throughout). Capping the batch buys
//! the same memory without touching a single stored vector.

use std::sync::atomic::{AtomicU8, Ordering};

/// 0 = unavailable (model init failed), 1 = indexing (a drain run is live),
/// 2 = ready (model loaded, queue empty — brief, mid-run), 3 = parked (vectors
/// stored, model unloaded until the next scheduled run; queries fall back to
/// keyword ranking).
pub static SEMANTIC_STATE: AtomicU8 = AtomicU8::new(0);

pub fn semantic_status() -> &'static str {
    match SEMANTIC_STATE.load(Ordering::Relaxed) {
        3 => "parked",
        2 => "ready",
        1 => "indexing",
        _ => "unavailable",
    }
}

#[cfg(test)]
mod state_tests {
    use super::*;

    /// The search palette switches on these strings; "parked" is what the
    /// scheduled lifecycle reports between runs, and anything the frontend
    /// doesn't recognize renders as plain keyword search — which is exactly
    /// what parked means, so even an older frontend stays honest.
    #[test]
    fn every_state_has_a_name_and_parked_is_distinct() {
        for (v, s) in [(0u8, "unavailable"), (1, "indexing"), (2, "ready"), (3, "parked")] {
            SEMANTIC_STATE.store(v, Ordering::Relaxed);
            assert_eq!(semantic_status(), s);
        }
        SEMANTIC_STATE.store(0, Ordering::Relaxed);
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
        /// Nothing pending. Under the scheduled lifecycle the drain RETURNS
        /// here instead of idling, so this arm's backoff only matters to the
        /// tests that pin it -- kept because Pacer is a pure schedule and
        /// "what does idling cost" should stay provable.
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
    use std::path::{Path, PathBuf};
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// The model, present only while a drain run is live. An `Arc` inside a
    /// Mutex rather than the model itself: `embed_query` clones the Arc out and
    /// releases the lock BEFORE embedding, so a search never waits on the batch
    /// loop and the batch loop never waits on a search. When the run ends the
    /// slot goes back to None and the last Arc drop releases the ONNX session —
    /// its grow-only arena and the ~110MB of weights with it.
    static MODEL: Mutex<Option<Arc<TextEmbedding>>> = Mutex::new(None);

    // Bump this string whenever the embedding recipe changes (model, prefix,
    // pooling) to force a one-time re-embed of every chunk on next launch.
    const EMBEDDING_VERSION: &str = "e5-small-passage-v1";

    /// Wait between attempts to open the store (the watcher's initial sync can
    /// hold the lock for a moment at startup).
    const REOPEN_DELAY: Duration = Duration::from_secs(5);
    /// Consecutive failed queue reads before the connection is written off.
    const DB_ERROR_LIMIT: u32 = 5;
    /// Store-open attempts per run before giving up until the next run.
    const OPEN_ATTEMPTS: u32 = 6;
    /// Time between drain runs: twice a day. Chunks written in between stay
    /// keyword-searchable immediately; they join the semantic index at the
    /// next run. Restarting the app also runs a catch-up drain.
    const RUN_EVERY: Duration = Duration::from_secs(12 * 60 * 60);

    /// Scheduled embedding: a catch-up run at launch, then one run every
    /// `RUN_EVERY`. All the memory lives inside `run_once`.
    pub fn run(db_path: PathBuf, cache_dir: PathBuf) {
        let mut migrated = false;
        loop {
            run_once(&db_path, &cache_dir, &mut migrated);
            std::thread::sleep(RUN_EVERY);
        }
    }

    fn open_store(db_path: &Path) -> Option<Store> {
        for attempt in 0..OPEN_ATTEMPTS {
            match Store::open(db_path) {
                Ok(s) => return Some(s),
                Err(e) if attempt + 1 == OPEN_ATTEMPTS => {
                    eprintln!("embedder: store unavailable, skipping this run: {e:#}");
                }
                Err(_) => std::thread::sleep(REOPEN_DELAY),
            }
        }
        None
    }

    /// One drain run: reconcile the queue, and only if there is actual work,
    /// load the model, drain to empty, and unload it again. A day where
    /// nothing changed never pays the model load at all.
    fn run_once(db_path: &Path, cache_dir: &Path, migrated: &mut bool) {
        let Some(mut store) = open_store(db_path) else { return };
        // One-time re-embed on a recipe change: older embeddings lack the e5
        // `passage:` prefix and so sit in a different space than `query:`-
        // prefixed searches. Dropping every vector re-queues them all.
        if !*migrated {
            if store.meta_get("embedding_version").ok().flatten().as_deref() != Some(EMBEDDING_VERSION) {
                if let Ok(n) = store.clear_embeddings() {
                    if n > 0 {
                        eprintln!("re-embedding {n} chunks with the e5 passage: prefix");
                    }
                }
                let _ = store.meta_set("embedding_version", EMBEDDING_VERSION);
            }
            *migrated = true;
        }
        // `embed_queue` is a materialized view of the "no vector yet" anti-join,
        // kept current by DB triggers. Re-deriving it at the start of each run
        // is what makes trusting it safe -- including across a DB shared with
        // an older build (see Store::reconcile_embed_queue).
        let _ = store.reconcile_embed_queue();
        if store.embed_queue_is_empty().unwrap_or(false) {
            let _ = crate::hues::refresh(&store);
            SEMANTIC_STATE.store(3, Ordering::Relaxed);
            return;
        }

        let model = match TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::MultilingualE5Small).with_cache_dir(cache_dir.to_path_buf()),
        ) {
            Ok(m) => Arc::new(m),
            Err(e) => {
                eprintln!("semantic search disabled this run (model init failed): {e:#}");
                SEMANTIC_STATE.store(0, Ordering::Relaxed);
                return;
            }
        };
        // publish for queries: semantic search works while the run is live
        *MODEL.lock().unwrap() = Some(model.clone());
        SEMANTIC_STATE.store(1, Ordering::Relaxed);

        loop {
            match drain(&mut store, &model) {
                DrainEnd::Empty => break,
                // Reopening is how the old per-tick Store::open shrugged off a
                // locked or replaced DB; with a long-lived connection we ask.
                DrainEnd::ConnBroken => match open_store(db_path) {
                    Some(s) => store = s,
                    None => break,
                },
            }
        }
        // Session hues are maintained even though nothing renders them today:
        // they are the stored substrate for on-demand "find similar" features.
        // No UI event — since the sidebar stopped wearing topic colors there
        // is nothing on screen for this to refresh.
        let _ = crate::hues::refresh(&store);

        *MODEL.lock().unwrap() = None;
        drop(model); // the last Arc frees the session, its arena, the weights
        SEMANTIC_STATE.store(3, Ordering::Relaxed);
    }

    enum DrainEnd {
        /// Nothing workable left in the queue (drained, or the remainder is
        /// parked past MAX_EMBED_ATTEMPTS until the next run's reconcile).
        Empty,
        /// The store connection stopped answering; caller reopens.
        ConnBroken,
    }

    /// Drain the queue on one connection.
    fn drain(store: &mut Store, model: &TextEmbedding) -> DrainEnd {
        let mut pacer = Pacer::default();
        let mut db_errors = 0u32;
        // Set after a multi-row batch fails in the model, so the next pass
        // isolates the offending chunk (see the `narrow` use below).
        let mut narrow = false;
        loop {
            let pending = match store.pending_embeddings(MAX_BATCH as i64, MAX_EMBED_ATTEMPTS) {
                Ok(rows) => {
                    db_errors = 0;
                    rows
                }
                Err(e) => {
                    db_errors += 1;
                    eprintln!("embed queue read failed ({db_errors}): {e:#}");
                    if db_errors >= DB_ERROR_LIMIT {
                        return DrainEnd::ConnBroken;
                    }
                    std::thread::sleep(pacer.next_delay(Step::Stalled));
                    continue;
                }
            };
            if pending.is_empty() {
                return DrainEnd::Empty;
            }
            // After a whole-batch model failure, retry one row at a time so
            // the blame lands on the chunk that actually caused it instead
            // of on the healthy rows that happened to share its batch.
            let n = if narrow { 1 } else { batch_len(&pending) };
            let step = embed_batch(store, model, &pending[..n]);
            narrow = step == Step::Stalled && n > 1;
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
    ///
    /// None whenever the model is parked (most of the time, by design): the
    /// caller serves keyword ranking instead. The Arc is cloned out and the
    /// lock released before embedding — see `MODEL`.
    pub fn embed_query(q: &str) -> Option<Vec<f32>> {
        let model = MODEL.lock().unwrap().clone()?;
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
    pub fn run(_db: PathBuf, _cache: PathBuf) {}
    pub fn embed_query(_q: &str) -> Option<Vec<f32>> {
        None
    }
}
