#[derive(Debug, Clone, PartialEq)]
pub enum ParsedRecord {
    Chain(Chain),
    State(State),
    Unknown { raw_type: Option<String> },
    Malformed,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Chain {
    pub kind: String, // "user" | "assistant" | "system" | "attachment"
    pub subtype: Option<String>,
    pub uuid: Option<String>,
    pub session_id: Option<String>,
    pub timestamp_ms: Option<i64>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub version: Option<String>,
    pub is_meta: bool,
    pub is_sidechain: bool,
    /// user record whose message content is only tool_result blocks (machine-generated)
    pub is_tool_result_only: bool,
    pub slug: Option<String>,
    pub role: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct State {
    pub kind: String, // one of STATE_KINDS
    pub session_id: Option<String>,
    pub ai_title: Option<String>,
    /// User-assigned session name (`claude -n` / `/rename`) — outranks every
    /// generated title.
    pub custom_title: Option<String>,
    pub last_prompt: Option<String>,
}

pub const CHAIN_KINDS: [&str; 4] = ["user", "assistant", "system", "attachment"];
pub const STATE_KINDS: [&str; 7] =
    ["ai-title", "custom-title", "last-prompt", "permission-mode", "mode", "file-history-snapshot", "queue-operation"];
