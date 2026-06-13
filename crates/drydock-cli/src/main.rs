use anyhow::Result;
use clap::{Parser, Subcommand};
use drydock_core::store::Store;
use drydock_core::sync::sync_all;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "drydock", about = "Drydock core indexer debug CLI")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// One-shot scan + incremental sync of all transcripts into the index
    Index {
        #[arg(long, default_value_os_t = default_claude_dir())]
        claude_dir: PathBuf,
        #[arg(long, default_value = "drydock.db")]
        db: PathBuf,
    },
    /// Print the sessions table (most recent first)
    List {
        #[arg(long, default_value = "drydock.db")]
        db: PathBuf,
        /// include hidden (ghost) sessions
        #[arg(long)]
        all: bool,
    },
    /// Watch ~/.claude and keep the index in sync until Ctrl-C
    Watch {
        #[arg(long, default_value_os_t = default_claude_dir())]
        claude_dir: PathBuf,
        #[arg(long, default_value = "drydock.db")]
        db: PathBuf,
    },
    /// Read-only schema-drift check against the real ~/.claude (spec §12)
    Canary {
        #[arg(long, default_value_os_t = default_claude_dir())]
        claude_dir: PathBuf,
    },
}

fn default_claude_dir() -> PathBuf {
    dirs_home().join(".claude")
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).expect("HOME not set")
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Index { claude_dir, db } => {
            let mut store = Store::open(&db)?;
            let r = sync_all(&mut store, &claude_dir)?;
            println!(
                "parsed {} file(s), skipped {}, deleted {} session(s), {} malformed line(s)",
                r.files_parsed, r.files_skipped, r.sessions_deleted, r.malformed_lines
            );
        }
        Cmd::List { db, all } => {
            let store = Store::open(&db)?;
            for s in store.list_sessions()? {
                if s.hidden && !all { continue; }
                let star = if s.starred { "★" } else { " " };
                let when = s.last_message_at.map(chrono_fmt).unwrap_or_else(|| "-".into());
                println!(
                    "{star} {:<17} {:<52} {:<32} {}",
                    when, clip(&s.title, 50), clip(&s.project_path, 30), s.session_id
                );
            }
        }
        Cmd::Watch { claude_dir, db } => {
            let mut store = Store::open(&db)?;
            let r = sync_all(&mut store, &claude_dir)?;
            println!("initial sync: {} parsed, {} skipped", r.files_parsed, r.files_skipped);
            drydock_core::watcher::watch(&claude_dir, &db)?;
        }
        Cmd::Canary { claude_dir } => {
            let files = drydock_core::scanner::scan_projects(&claude_dir)?;
            let mut total_malformed = 0usize;
            let mut total_unknown = 0usize;
            for sf in &files {
                let Ok(text) = std::fs::read_to_string(&sf.path) else { continue };
                let (mut malformed, mut unknown) = (0usize, 0usize);
                for line in text.lines() {
                    match drydock_core::parser::parse_line(line) {
                        drydock_core::records::ParsedRecord::Malformed => malformed += 1,
                        drydock_core::records::ParsedRecord::Unknown { raw_type } => {
                            unknown += 1;
                            eprintln!("  unknown type {:?} in {}", raw_type, sf.path.display());
                        }
                        _ => {}
                    }
                }
                if malformed + unknown > 0 {
                    println!("{}: {} malformed, {} unknown", sf.path.display(), malformed, unknown);
                }
                total_malformed += malformed;
                total_unknown += unknown;
            }
            println!(
                "canary: {} files, {} malformed, {} unknown-type lines",
                files.len(), total_malformed, total_unknown
            );
            if total_malformed > 0 {
                std::process::exit(1);
            }
        }
    }
    Ok(())
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn chrono_fmt(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| ms.to_string())
}
