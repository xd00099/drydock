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

#[cfg(feature = "semantic")]
pub mod imp {
    use super::SEMANTIC_STATE;
    use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
    use drydock_core::store::Store;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;
    use std::sync::OnceLock;

    // OnceLock, not Mutex: embed() takes &self, so queries never wait on the
    // background batch loop (which used to hold a lock for seconds per batch).
    static MODEL: OnceLock<TextEmbedding> = OnceLock::new();

    // Bump this string whenever the embedding recipe changes (model, prefix,
    // pooling) to force a one-time re-embed of every chunk on next launch.
    const EMBEDDING_VERSION: &str = "e5-small-passage-v1";

    /// Background loop: load the model once (downloads ~110MB on first run),
    /// then drain unembedded chunks forever at low priority.
    pub fn run(db_path: PathBuf, cache_dir: PathBuf) {
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
                std::thread::sleep(std::time::Duration::from_secs(5));
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
            let pending = store.chunks_without_embeddings(32).unwrap_or_default();
            if pending.is_empty() {
                SEMANTIC_STATE.store(2, Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_secs(3));
                continue;
            }
            SEMANTIC_STATE.store(1, Ordering::Relaxed);
            // e5 documents must carry the `passage:` prefix (paired with the
            // `query:` prefix on searches); fastembed does not add it for us.
            let texts: Vec<String> = pending.iter().map(|(_, t)| format!("passage: {t}")).collect();
            match model.embed(texts, None) {
                Ok(vecs) => {
                    for ((chunk_id, _), v) in pending.iter().zip(vecs) {
                        let _ = store.put_embedding(*chunk_id, &v);
                    }
                }
                Err(e) => {
                    eprintln!("embed batch failed: {e:#}");
                    std::thread::sleep(std::time::Duration::from_secs(10));
                }
            }
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
    pub fn run(_db: PathBuf, _cache: PathBuf) {}
    pub fn embed_query(_q: &str) -> Option<Vec<f32>> {
        None
    }
}
