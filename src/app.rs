//! Application state and the event loop merging keyboard/mouse events with
//! ACP events.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::time::Instant;

use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseEventKind};
use ratatui::style::{Modifier, Style};
use ratatui::text::Span;
use ratatui::DefaultTerminal;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::acp::{
    short_id, AcpClient, AcpEvent, ConfigChoice, ConfigOptionState, ListedSession, PermOption,
};
use crate::theme as t;
use crate::ui;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    User,
    Agent,
    Thought,
    Tool,
    System,
}

#[derive(Clone)]
pub struct Entry {
    pub kind: EntryKind,
    pub text: String,
    /// Tool entries only: the current status word (drives the status dot).
    pub status: Option<String>,
    /// Tool entries only: clipped rawInput preview (the actual command/args).
    pub detail: Option<String>,
    /// Tool entries only: the ACP tool_call_id (drives Ctrl+O collapse).
    pub tool_id: Option<String>,
}

#[derive(Clone)]
struct ToolMeta {
    title: String,
    kind: String,
    status: String,
}

/// Progressive local reveal of a committed chunk. The dsh ACP surface
/// (automation-only contract) delivers assistant messages and thoughts as
/// single committed blocks at turn end — raw provider deltas never touch the
/// wire (verified with `scripts/acp-stream-probe.mjs`). To restore the
/// streaming feel, committed text is typed out locally (~1s per block).
struct Reveal {
    kind: EntryKind,
    text: String,
    /// Reveal schedule: drains in ≤ ticks_left render ticks (~33ms each).
    ticks_left: u32,
    /// Entry index the reveal appends to; created on the first tick when None.
    target: Option<usize>,
    /// No more merging into this reveal (a tool card / user message came
    /// between, so the next same-kind chunk starts a new entry).
    sealed: bool,
    /// First tick must create a NEW entry (set when enqueued after a seal —
    /// plain append_chunk would merge into the previous same-kind entry).
    force_new: bool,
}

pub enum Dialog {
    None,
    Permission {
        request_id: Value,
        tool_title: String,
        options: Vec<PermOption>,
        selected: usize,
    },
    Sessions {
        items: Vec<ListedSession>,
        selected: usize,
    },
    Config {
        id: String,
        title: String,
        current: String,
        choices: Vec<ConfigChoice>,
        selected: usize,
    },
    /// Generic scrollable text panel (/help, /status, /cost, …).
    Info {
        title: String,
        lines: Vec<String>,
        selected: usize,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Booting,
    Idle,
    Busy,
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CmdGroup {
    Session,
    Model,
    Info,
    System,
}

impl CmdGroup {
    pub fn label(&self) -> &'static str {
        match self {
            CmdGroup::Session => "会话",
            CmdGroup::Model => "模型",
            CmdGroup::Info => "信息",
            CmdGroup::System => "系统",
        }
    }

    /// Canonical menu order.
    pub const ORDER: [CmdGroup; 4] =
        [CmdGroup::Session, CmdGroup::Model, CmdGroup::Info, CmdGroup::System];
}

pub struct Cmd {
    pub name: &'static str,
    /// Extra spellings that match the menu filter and verbatim dispatch
    /// (e.g. `/sessions` → `/list`). Aliases never show as canonical names.
    pub aliases: &'static [&'static str],
    pub desc: &'static str,
    pub group: CmdGroup,
    /// Blocked while a prompt is in flight (must cancel first).
    pub idle_only: bool,
}

pub const COMMANDS: &[Cmd] = &[
    Cmd { name: "/new", aliases: &["/n"], desc: "新建会话", group: CmdGroup::Session, idle_only: true },
    Cmd { name: "/list", aliases: &["/sessions", "/s"], desc: "历史会话列表", group: CmdGroup::Session, idle_only: true },
    Cmd { name: "/model", aliases: &["/m"], desc: "切换模型", group: CmdGroup::Model, idle_only: false },
    Cmd { name: "/effort", aliases: &["/e"], desc: "切换推理档位", group: CmdGroup::Model, idle_only: false },
    Cmd { name: "/cost", aliases: &[], desc: "今日 token 用量与费用", group: CmdGroup::Info, idle_only: false },
    Cmd { name: "/usage", aliases: &[], desc: "当前会话用量明细", group: CmdGroup::Info, idle_only: false },
    Cmd { name: "/status", aliases: &[], desc: "当前会话 / 配置信息", group: CmdGroup::Info, idle_only: false },
    Cmd { name: "/doctor", aliases: &["/diag"], desc: "环境自检（dsh/插件/配置）", group: CmdGroup::Info, idle_only: false },
    Cmd { name: "/preset", aliases: &[], desc: "列出 agent presets", group: CmdGroup::Info, idle_only: false },
    Cmd { name: "/permission", aliases: &["/perm"], desc: "本地权限规则", group: CmdGroup::Info, idle_only: false },
    Cmd { name: "/help", aliases: &["/h", "/?"], desc: "显示所有命令", group: CmdGroup::Info, idle_only: false },
    Cmd { name: "/web", aliases: &[], desc: "启动/打开 web 界面", group: CmdGroup::System, idle_only: false },
    Cmd { name: "/clear", aliases: &["/c"], desc: "清屏（不影响会话上下文）", group: CmdGroup::System, idle_only: false },
    Cmd { name: "/quit", aliases: &["/exit", "/q"], desc: "退出", group: CmdGroup::System, idle_only: false },
];

/// Resolve a verbatim `/input` to its canonical command (name or alias).
fn resolve_cmd(input: &str) -> Option<&'static Cmd> {
    COMMANDS.iter().find(|c| c.name == input || c.aliases.contains(&input))
}

/// Menu rows: matched commands flattened into group headers + commands, in
/// canonical group order. Headers are non-selectable display rows.
pub enum MenuRow {
    Header(&'static str),
    Cmd(&'static Cmd),
}

pub fn grouped_menu(items: &[&'static Cmd]) -> Vec<MenuRow> {
    let mut rows = Vec::new();
    for group in CmdGroup::ORDER {
        let group_items: Vec<&'static Cmd> = items.iter().copied().filter(|c| c.group == group).collect();
        if group_items.is_empty() {
            continue;
        }
        rows.push(MenuRow::Header(group.label()));
        rows.extend(group_items.into_iter().map(MenuRow::Cmd));
    }
    rows
}

/// Next/previous selectable command row, skipping group headers; clamps at
/// the ends.
fn nav_cmd(rows: &[MenuRow], from: usize, dir: i16) -> usize {
    let mut i = from as i64 + dir as i64;
    while i >= 0 && (i as usize) < rows.len() && !matches!(rows[i as usize], MenuRow::Cmd(_)) {
        i += dir as i64;
    }
    if i < 0 || (i as usize) >= rows.len() {
        from
    } else {
        i as usize
    }
}

/// Persisted user preferences (`~/.dsh-tui/prefs.json`): the last model /
/// effort choice is re-applied automatically to every new session, because
/// dsh creates acp sessions with the profile's default route.
#[derive(Clone, Default)]
pub struct Prefs {
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// Local permission rule (kimi `permission.rules`-style, client-side only):
/// auto-answer `session/request_permission` prompts whose tool title matches
/// `pattern` (case-insensitive substring). The kernel is never involved.
#[derive(Clone, Debug, PartialEq)]
pub enum PermDecision {
    Allow,
    Deny,
}

#[derive(Clone, Debug)]
pub struct PermRule {
    pub pattern: String,
    pub decision: PermDecision,
}

fn load_permission_rules() -> Vec<PermRule> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok();
    let Some(home) = home else { return Vec::new() };
    let p = PathBuf::from(home).join(".dsh-tui").join("permission.json");
    let Ok(txt) = std::fs::read_to_string(p) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&txt) else {
        return Vec::new();
    };
    let Some(rules) = v.get("rules").and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    rules
        .iter()
        .filter_map(|r| {
            let pattern = r.get("pattern").and_then(|x| x.as_str())?.to_string();
            let decision = match r.get("decision").and_then(|x| x.as_str()) {
                Some("allow") => PermDecision::Allow,
                Some("deny") => PermDecision::Deny,
                _ => return None,
            };
            Some(PermRule { pattern, decision })
        })
        .collect()
}

fn prefs_path() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let dir = PathBuf::from(home).join(".dsh-tui");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("prefs.json"))
}

fn load_prefs() -> Prefs {
    let Some(p) = prefs_path() else {
        return Prefs::default();
    };
    let Ok(txt) = std::fs::read_to_string(p) else {
        return Prefs::default();
    };
    let v: Value = serde_json::from_str(&txt).unwrap_or(Value::Null);
    Prefs {
        model: v.get("model").and_then(|x| x.as_str()).map(String::from),
        effort: v.get("effort").and_then(|x| x.as_str()).map(String::from),
    }
}

fn save_prefs(p: &Prefs) {
    if let Some(path) = prefs_path() {
        let v = serde_json::json!({
            "model": p.model,
            "effort": p.effort,
        });
        let _ = std::fs::write(path, serde_json::to_string_pretty(&v).unwrap_or_default());
    }
}

// ---------------------------------------------------------------------------
// Input history (persisted to ~/.dsh-tui/history.json, capped)
// ---------------------------------------------------------------------------

const HISTORY_CAP: usize = 200;

fn history_path() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let dir = PathBuf::from(home).join(".dsh-tui");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("history.json"))
}

fn load_history() -> Vec<String> {
    let Some(p) = history_path() else {
        return Vec::new();
    };
    let Ok(txt) = std::fs::read_to_string(p) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&txt).unwrap_or_default()
}

fn save_history(history: &[String]) {
    let tail: Vec<String> = history.iter().rev().take(HISTORY_CAP).cloned().collect();
    let tail: Vec<String> = tail.into_iter().rev().collect();
    if let Some(path) = history_path() {
        let _ = std::fs::write(path, serde_json::to_string_pretty(&tail).unwrap_or_default());
    }
}

// ---------------------------------------------------------------------------
// Local session titles — the dsh acp profile disables model-generated titles
// (ACP exposes no title surface), so the TUI keeps its own map keyed by
// session id: the first user prompt of a session becomes its short title,
// shown in the session list next to dsh's deterministic fallback.
// ---------------------------------------------------------------------------

fn titles_path() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let dir = PathBuf::from(home).join(".dsh-tui");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("session-titles.json"))
}

fn load_titles() -> HashMap<String, String> {
    let Some(p) = titles_path() else {
        return HashMap::new();
    };
    let Ok(txt) = std::fs::read_to_string(p) else {
        return HashMap::new();
    };
    serde_json::from_str(&txt).unwrap_or_default()
}

fn save_titles(titles: &HashMap<String, String>) {
    if let Some(path) = titles_path() {
        let _ = std::fs::write(path, serde_json::to_string_pretty(titles).unwrap_or_default());
    }
}

/// Remember a short title for a session from its first user prompt.
fn note_session_title(titles: &mut HashMap<String, String>, session_id: &str, prompt: &str) {
    if session_id.is_empty() || prompt.trim().is_empty() {
        return;
    }
    if titles.contains_key(session_id) {
        return;
    }
    let one_line: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = one_line.chars().take(24).collect();
    if !title.is_empty() {
        titles.insert(session_id.to_string(), title);
        save_titles(titles);
    }
}

/// Resolve the Harness home directory (`$DSH_HOME` > `~/.dsh`), used for
/// reading shared host-side data (token stats, profile patch, …).
fn dsh_home() -> Option<PathBuf> {
    if let Ok(h) = std::env::var("DSH_HOME") {
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(PathBuf::from(home).join(".dsh"))
}

pub struct App {
    pub entries: Vec<Entry>,
    pub input: String,
    pub scroll_from_bottom: u16,
    pub dialog: Dialog,
    pub session_id: Option<String>,
    pub config: Vec<ConfigOptionState>,
    pub usage: Option<(u64, u64)>,
    pub state: RunState,
    pub fatal: Option<String>,
    /// When the in-flight prompt started (drives the elapsed timer + spinner).
    pub busy_since: Option<Instant>,
    /// Web GUI reachability (from `/web` probes): URL when up.
    pub web_url: Option<String>,
    /// Active color theme (default palette or ~/.dsh-tui/theme.json override).
    pub theme: crate::theme::Theme,
    /// Flattened, wrapped display lines (built incrementally from
    /// [`App::disp_cache`]; see [`App::ensure_display`]).
    pub display: Vec<Vec<Span<'static>>>,

    quit: bool,

    /// Per-entry wrapped display blocks (parallel to `entries`), so streaming
    /// only re-wraps the mutated tail instead of the whole transcript.
    disp_cache: Vec<Vec<Vec<Span<'static>>>>,
    /// `display` index where each entry's block begins (len == entries.len()+1).
    block_start: Vec<usize>,
    /// First entry index whose cache is stale; entries[..clean_from] are valid.
    clean_from: usize,

    /// Messages typed while a prompt is in flight; drained on settlement.
    queue: VecDeque<String>,
    /// Slash-command menu selection index.
    pub cmd_selected: usize,
    /// Persisted model / effort preferences, applied to each new session.
    pref: Prefs,

    history: Vec<String>,
    hist_cursor: Option<usize>,
    queued_permissions: Vec<(Value, String, Vec<PermOption>)>,
    tool_idx: HashMap<String, usize>,
    tool_meta: HashMap<String, ToolMeta>,
    /// Ctrl+O collapse state per tool_call_id (detail preview hidden).
    tool_collapsed: HashMap<String, bool>,
    /// Most recent tool_call_id (Ctrl+O toggles this one).
    last_tool_id: Option<String>,
    /// Pending typewriter reveals (FIFO; see [`Reveal`]).
    reveal_queue: VecDeque<Reveal>,
    /// Settle note deferred until the reveal drains (the kernel commits
    /// messages and settles in the same instant; showing "完成" while the
    /// text is still typing would read backwards).
    pending_settle: Option<String>,
    debug_log: VecDeque<String>,
    /// Locally generated session titles (first user prompt → short title),
    /// persisted in `~/.dsh-tui/session-titles.json`. The dsh acp profile
    /// disables model-generated titles, so the TUI keeps its own.
    titles: HashMap<String, String>,
    /// Auto-answer rules for kernel permission prompts (see `PermRule`).
    perm_rules: Vec<PermRule>,
    cwd: PathBuf,
    pub(crate) dirty: bool,
    last_width: u16,
}

impl App {
    pub(crate) fn new() -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let mut app = App {
            entries: Vec::new(),
            input: String::new(),
            scroll_from_bottom: 0,
            dialog: Dialog::None,
            session_id: None,
            config: Vec::new(),
            usage: None,
            state: RunState::Booting,
            fatal: None,
            busy_since: Some(Instant::now()),
            web_url: None,
            theme: crate::theme::load_theme(),
            display: Vec::new(),
            quit: false,
            disp_cache: Vec::new(),
            block_start: Vec::new(),
            clean_from: 0,
            queue: VecDeque::new(),
            cmd_selected: 0,
            pref: load_prefs(),
            history: load_history(),
            hist_cursor: None,
            queued_permissions: Vec::new(),
            tool_idx: HashMap::new(),
            tool_meta: HashMap::new(),
            tool_collapsed: HashMap::new(),
            last_tool_id: None,
            reveal_queue: VecDeque::new(),
            pending_settle: None,
            debug_log: VecDeque::new(),
            titles: load_titles(),
            perm_rules: load_permission_rules(),
            cwd,
            dirty: true,
            last_width: 0,
        };
        app.sysnote(&format!(
            "dsh-tui v{} — 正在连接 dsh 内核…",
            env!("CARGO_PKG_VERSION")
        ));
        app
    }

    fn sysnote(&mut self, msg: &str) {
        self.push_entry(EntryKind::System, msg);
    }

    /// Mark entry `from` (and everything after it) as needing a display
    /// rebuild, and request a redraw. Streaming only ever mutates the tail,
    /// so the incremental cache stays cheap even on long transcripts.
    fn invalidate(&mut self, from: usize) {
        self.clean_from = self.clean_from.min(from);
        self.dirty = true;
    }

    pub(crate) fn push_entry(&mut self, kind: EntryKind, text: &str) {
        self.entries.push(Entry {
            kind,
            text: text.to_string(),
            status: None,
            detail: None,
            tool_id: None,
        });
        // A non-chunk entry (tool card / user message / system note) breaks
        // the current reveal: later same-kind chunks must start a new entry.
        if let Some(back) = self.reveal_queue.back_mut() {
            back.sealed = true;
        }
        self.invalidate(self.entries.len() - 1);
    }

    pub(crate) fn append_chunk(&mut self, kind: EntryKind, text: &str) {
        match self.entries.last_mut() {
            Some(e) if e.kind == kind => e.text.push_str(text),
            _ => self.entries.push(Entry {
                kind,
                text: text.to_string(),
                status: None,
                detail: None,
                tool_id: None,
            }),
        }
        self.invalidate(self.entries.len() - 1);
    }

    /// Remember a sent input in the (persisted) history.
    fn push_history(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        if self.history.last().map(String::as_str) == Some(text) {
            self.hist_cursor = None;
            return;
        }
        self.history.push(text.to_string());
        self.hist_cursor = None;
        save_history(&self.history);
    }

    // -- typewriter reveal (committed chunk → streaming look) ---------------

    /// Queue a committed assistant/thought chunk for progressive reveal.
    /// Opt out with `DSH_TUI_NO_TYPEWRITER=1` (append directly).
    fn enqueue_reveal(&mut self, kind: EntryKind, text: &str) {
        if text.is_empty() {
            return;
        }
        if std::env::var("DSH_TUI_NO_TYPEWRITER").is_ok() {
            self.append_chunk(kind, text);
            return;
        }
        match self.reveal_queue.back_mut() {
            Some(back) if back.kind == kind && !back.sealed => back.text.push_str(text),
            _ => {
                let force_new = self
                    .reveal_queue
                    .back()
                    .is_some_and(|back| back.sealed && back.kind == kind);
                self.reveal_queue.push_back(Reveal {
                    kind,
                    text: text.to_string(),
                    ticks_left: 30,
                    target: None,
                    sealed: false,
                    force_new,
                })
            }
        }
        self.dirty = true;
    }

    /// Advance the head reveal by one scheduled step (called every event-loop
    /// iteration; the 33ms render tick paces it at ~30fps). When the queue
    /// drains, a deferred settle note (if any) is shown.
    fn tick_reveal(&mut self) {
        if self.reveal_queue.is_empty() {
            if let Some(note) = self.pending_settle.take() {
                self.sysnote(&note);
                self.dirty = true;
            }
            return;
        }
        // Phase 1: compute + consume from the head (queue borrow ends here).
        let action = {
            let Some(head) = self.reveal_queue.front_mut() else { return };
            let remaining = head.text.chars().count();
            if remaining == 0 {
                Some((head.kind, head.force_new, head.target, String::new(), true))
            } else {
                let step = std::cmp::min(
                    remaining,
                    std::cmp::max(1, remaining.div_ceil(head.ticks_left.max(1) as usize)),
                );
                let take = head
                    .text
                    .char_indices()
                    .nth(step)
                    .map(|(i, _)| i)
                    .unwrap_or(head.text.len());
                let slice = head.text[..take].to_string();
                head.text.drain(..take);
                head.ticks_left = (head.ticks_left.saturating_sub(1)).max(1);
                let done = head.text.is_empty();
                Some((head.kind, head.force_new, head.target, slice, done))
            }
        };
        let Some((kind, force_new, target, slice, done)) = action else { return };
        if done {
            self.reveal_queue.pop_front();
        }
        if slice.is_empty() {
            return;
        }
        // Phase 2: append to the target entry (create it on the first tick).
        let idx = match target {
            Some(i) => {
                if let Some(e) = self.entries.get_mut(i) {
                    e.text.push_str(&slice);
                }
                i
            }
            None if force_new => {
                self.entries.push(Entry {
                    kind,
                    text: slice,
                    status: None,
                    detail: None,
                    tool_id: None,
                });
                self.entries.len() - 1
            }
            None => {
                self.append_chunk(kind, &slice);
                self.entries.len() - 1
            }
        };
        if !done {
            if let Some(head) = self.reveal_queue.front_mut() {
                head.target = Some(idx);
            }
        }
        self.invalidate(idx);
    }

    /// Immediately show all pending reveal text (cancel / shutdown).
    fn flush_reveal(&mut self) {
        while let Some(head) = self.reveal_queue.pop_front() {
            if !head.text.is_empty() {
                let idx = match head.target {
                    Some(i) => {
                        if let Some(e) = self.entries.get_mut(i) {
                            e.text.push_str(&head.text);
                        }
                        i
                    }
                    None => {
                        self.append_chunk(head.kind, &head.text);
                        self.entries.len() - 1
                    }
                };
                self.invalidate(idx);
            }
        }
        self.dirty = true;
    }

    /// Whether a typewriter reveal is still playing.
    pub fn reveal_active(&self) -> bool {
        !self.reveal_queue.is_empty()
    }

    /// Clear the transcript and its display caches (new session / resume /
    /// /clear). The kernel-side conversation is unaffected.
    pub(crate) fn reset_transcript(&mut self) {
        self.entries.clear();
        self.disp_cache.clear();
        self.block_start.clear();
        self.clean_from = 0;
        self.tool_idx.clear();
        self.tool_meta.clear();
        self.tool_collapsed.clear();
        self.last_tool_id = None;
        self.reveal_queue.clear();
        self.usage = None;
        self.scroll_from_bottom = 0;
        self.dirty = true;
    }

    /// Pretty model name from the model selector's currentValue
    /// (`"[\"provider\",\"model\"]"` → `model`).
    pub fn model_label(&self) -> Option<String> {
        let c = self.config.iter().find(|c| c.id == "model")?;
        let cur = c.current.trim();
        if cur.is_empty() {
            return None;
        }
        if let Ok(Value::Array(parts)) = serde_json::from_str::<Value>(cur) {
            return parts.last().and_then(|v| v.as_str()).map(String::from);
        }
        Some(cur.to_string())
    }

    pub fn queue_len(&self) -> usize {
        self.queue.len()
    }

    /// Locally generated title for a session (if any).
    pub fn local_title(&self, session_id: &str) -> Option<String> {
        self.titles.get(session_id).cloned()
    }

    /// Slash commands matching the current input (menu is shown when the
    /// input is a bare `/prefix` with no space). Both canonical names and
    /// aliases participate in the filter.
    pub fn cmd_matches(&self) -> Vec<&'static Cmd> {
        let Some(q) = self.input.strip_prefix('/') else {
            return Vec::new();
        };
        if self.input.contains(' ') {
            return Vec::new();
        }
        COMMANDS
            .iter()
            .filter(|c| {
                c.name[1..].starts_with(q)
                    || c.aliases.iter().any(|a| a[1..].starts_with(q))
            })
            .collect()
    }

    fn note_line(&mut self, line: &str) {
        if line.starts_with("[dsh]") {
            self.debug_log.push_back(line.to_string());
            if self.debug_log.len() > 300 {
                self.debug_log.pop_front();
            }
        } else {
            self.sysnote(&crate::acp::clip(line, 200));
        }
    }

    fn scroll_by(&mut self, delta: i16) {
        if delta >= 0 {
            self.scroll_from_bottom = self.scroll_from_bottom.saturating_add(delta as u16);
        } else {
            self.scroll_from_bottom = self.scroll_from_bottom.saturating_sub((-delta) as u16);
        }
        self.dirty = true;
    }

    /// Rebuild the wrapped display lines when dirty or on resize.
    ///
    /// Each entry's wrapped block is cached in `disp_cache` and only rebuilt
    /// from `clean_from` onward — streaming appends to the last entry, so a
    /// normal chunk redraw re-wraps just that entry and splices it into the
    /// existing `display` (O(tail) instead of O(whole transcript)). Visual
    /// hints (hairline rule before a user turn) live inside the entry block;
    /// agent text goes through a markdown-lite pass.
    pub fn ensure_display(&mut self, width: u16) {
        let w = width.max(10) as usize;
        if !self.dirty && self.last_width == width {
            return;
        }
        if self.last_width != width {
            self.clean_from = 0; // width changed → everything re-wraps
        }
        self.last_width = width;

        if self.disp_cache.len() < self.entries.len() {
            self.disp_cache.resize(self.entries.len(), Vec::new());
            self.block_start.resize(self.entries.len() + 1, 0);
        }
        let clean = self.clean_from.min(self.entries.len());

        // Cut `display` back to the first stale block; everything before it
        // is reused as-is.
        let cut = self.block_start[clean];
        self.display.truncate(cut);

        let mut idx = cut;
        let mut seen_content = self.entries[..clean]
            .iter()
            .any(|e| matches!(e.kind, EntryKind::User | EntryKind::Agent | EntryKind::Tool));
        for i in clean..self.entries.len() {
            let e = &self.entries[i];
            let collapsed = e
                .tool_id
                .as_deref()
                .and_then(|id| self.tool_collapsed.get(id))
                .copied()
                .unwrap_or(false);
            let block = entry_block(e, w, seen_content, collapsed, &self.theme);
            seen_content |= matches!(e.kind, EntryKind::User | EntryKind::Agent | EntryKind::Tool);
            self.disp_cache[i] = block;
            self.block_start[i] = idx;
            idx += self.disp_cache[i].len();
            self.display.extend_from_slice(&self.disp_cache[i]);
        }
        self.block_start[self.entries.len()] = idx;
        self.clean_from = self.entries.len();
        self.dirty = false;
    }
}

/// Plain display-width-aware wrap (no styling) — used for tool-card borders.
fn wrap_plain(s: &str, max: usize) -> Vec<String> {
    use unicode_width::UnicodeWidthChar;
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut cur_w = 0usize;
    for ch in s.chars() {
        let cw = ch.width().unwrap_or(0);
        if cur_w + cw > max && cur_w > 0 {
            out.push(std::mem::take(&mut cur));
            cur_w = 0;
        }
        cur.push(ch);
        cur_w += cw;
    }
    if !cur.is_empty() || out.is_empty() {
        out.push(cur);
    }
    out
}

/// Char-level wrap that preserves per-span styling (CJK aware).
fn wrap_spans(spans: &[Span<'static>], max: usize) -> Vec<Vec<(char, Style)>> {
    use unicode_width::UnicodeWidthChar;
    let mut flat: Vec<(char, Style)> = Vec::new();
    for s in spans {
        for ch in s.content.chars() {
            flat.push((ch, s.style));
        }
    }
    let mut lines = Vec::new();
    let mut cur: Vec<(char, Style)> = Vec::new();
    let mut w = 0usize;
    for (ch, st) in flat {
        let cw = ch.width().unwrap_or(0);
        if w + cw > max && w > 0 {
            lines.push(std::mem::take(&mut cur));
            w = 0;
        }
        cur.push((ch, st));
        w += cw;
    }
    lines.push(cur);
    lines
}

// ---------------------------------------------------------------------------
// Markdown-lite for agent text: fenced code blocks, headings, bullets,
// quotes, inline `code` and **bold**. Deliberately conservative — anything
// unrecognized renders as plain text.
// ---------------------------------------------------------------------------

/// Wrap one entry into its display block (a list of span-lines), including
/// the trailing blank line and, for user turns after earlier content, the
/// hairline separator. `had_content` tells whether any previous entry was
/// content-bearing (User/Agent/Tool) — that decides the separator.
/// `collapsed` hides tool-call detail previews (Ctrl+O).
fn entry_block(
    e: &Entry,
    w: usize,
    had_content: bool,
    collapsed: bool,
    th: &crate::theme::Theme,
) -> Vec<Vec<Span<'static>>> {
    let mut out: Vec<Vec<Span<'static>>> = Vec::new();
    match e.kind {
        EntryKind::User => {
            if had_content {
                out.push(vec![Span::styled("─".repeat(w), t::plain(th.hairline))]);
                out.push(vec![]);
            }
            for (i, seg) in e.text.split('\n').enumerate() {
                let mut spans = Vec::new();
                if i == 0 {
                    spans.push(Span::styled("❯ ".to_string(), t::bold(th.accent)));
                } else {
                    spans.push(Span::styled("  ".to_string(), t::bold(th.fg)));
                }
                spans.push(Span::styled(seg.to_string(), t::bold(th.fg)));
                push_wrapped(&mut out, &spans, "  ", t::bold(th.fg), w);
            }
        }
        EntryKind::Agent => {
            for line in markdown_spans(&e.text, th) {
                if line.is_empty() {
                    out.push(vec![]);
                } else {
                    push_wrapped(&mut out, &line, "  ", t::plain(th.fg), w);
                }
            }
        }
        EntryKind::Thought => {
            for (i, seg) in e.text.split('\n').enumerate() {
                let mut spans = Vec::new();
                if i == 0 {
                    spans.push(Span::styled(
                        "✻ ".to_string(),
                        t::plain(th.dim).add_modifier(Modifier::ITALIC),
                    ));
                } else {
                    spans.push(Span::styled(
                        "  ".to_string(),
                        t::plain(th.dim).add_modifier(Modifier::ITALIC),
                    ));
                }
                spans.push(Span::styled(
                    seg.to_string(),
                    t::plain(th.dim).add_modifier(Modifier::ITALIC),
                ));
                push_wrapped(&mut out, &spans, "  ", t::plain(th.dim), w);
            }
        }
        EntryKind::Tool => {
            // Boxed tool card (pi ToolExecutionComponent style): a status-
            // colored rounded border, title + Chinese status label on the
            // top edge, optional rawInput preview inside (Ctrl+O collapses).
            let (label, color) = th.status_label(e.status.as_deref().unwrap_or("pending"));
            let cw = w.saturating_sub(4).max(2);
            let head = format!("{} ● {label}", e.text);
            let chunks = wrap_plain(&head, cw);
            let first = chunks.first().cloned().unwrap_or_default();
            let first_w = unicode_width::UnicodeWidthStr::width(first.as_str());

            out.push(vec![
                Span::styled("╭─".to_string(), t::plain(color)),
                Span::styled(first, t::plain(th.fg).add_modifier(Modifier::BOLD)),
                Span::styled("─".repeat(cw.saturating_sub(first_w)), t::plain(color)),
                Span::styled("─╮".to_string(), t::plain(color)),
            ]);
            for chunk in chunks.iter().skip(1) {
                let pad = cw.saturating_sub(unicode_width::UnicodeWidthStr::width(chunk.as_str()));
                out.push(vec![
                    Span::styled("│ ".to_string(), t::plain(color)),
                    Span::styled(chunk.clone(), t::plain(th.fg)),
                    Span::styled(" ".repeat(pad), t::plain(color)),
                    Span::styled(" │".to_string(), t::plain(color)),
                ]);
            }
            if !collapsed {
                if let Some(detail) = &e.detail {
                    for chunk in wrap_plain(detail, cw.saturating_sub(2).max(2)) {
                        let pad = cw
                            .saturating_sub(2)
                            .saturating_sub(unicode_width::UnicodeWidthStr::width(chunk.as_str()));
                        out.push(vec![
                            Span::styled("│ ⤷ ".to_string(), t::plain(th.hairline)),
                            Span::styled(chunk, t::plain(th.dim)),
                            Span::styled(" ".repeat(pad), t::plain(color)),
                            Span::styled(" │".to_string(), t::plain(color)),
                        ]);
                    }
                }
            }
            out.push(vec![
                Span::styled(format!("╰─{}─╯", "─".repeat(cw)), t::plain(color)),
            ]);
        }
        EntryKind::System => {
            for (i, seg) in e.text.split('\n').enumerate() {
                let mut spans = Vec::new();
                if i == 0 {
                    spans.push(Span::styled("· ".to_string(), t::plain(th.dim)));
                } else {
                    spans.push(Span::styled("  ".to_string(), t::plain(th.dim)));
                }
                spans.push(Span::styled(seg.to_string(), t::plain(th.dim)));
                push_wrapped(&mut out, &spans, "  ", t::plain(th.dim), w);
            }
        }
    }
    out.push(vec![]);
    out
}

fn markdown_spans(text: &str, th: &crate::theme::Theme) -> Vec<Vec<Span<'static>>> {
    let mut out: Vec<Vec<Span<'static>>> = Vec::new();
    let mut in_code = false;
    for raw in text.split('\n') {
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_code = !in_code;
            let lang = trimmed.trim_start_matches('`').trim();
            let edge = if in_code { "╭" } else { "╰" };
            let label = if in_code && !lang.is_empty() {
                format!("{edge}─── {lang} ", )
            } else {
                format!("{edge}───")
            };
            out.push(vec![Span::styled(label, t::plain(th.hairline))]);
            continue;
        }
        if in_code {
            out.push(vec![
                Span::styled("  │ ".to_string(), t::plain(th.hairline)),
                Span::styled(line.to_string(), t::plain(th.code_fg)),
            ]);
            continue;
        }
        if trimmed.starts_with('#') {
            let stripped = trimmed.trim_start_matches('#').trim_start();
            out.push(vec![
                Span::styled("  ".to_string(), t::plain(th.fg)),
                Span::styled(stripped.to_string(), t::bold(th.accent)),
            ]);
            continue;
        }
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            let indent_len = raw.len() - trimmed.len();
            let indent = " ".repeat(indent_len.min(6));
            out.push(inline_spans(
                &format!("{indent}• {}", &trimmed[2..]),
                t::plain(th.fg),
                th,
            ));
            continue;
        }
        if let Some(quoted) = trimmed.strip_prefix("> ") {
            out.push(inline_spans(
                &format!("▌ {quoted}"),
                t::plain(th.dim).add_modifier(Modifier::ITALIC),
                th,
            ));
            continue;
        }
        if trimmed.is_empty() {
            out.push(vec![]);
            continue;
        }
        out.push(inline_spans(line, t::plain(th.fg), th));
    }
    out
}

/// Inline markdown: `code` → accent, **bold** → bold. Unclosed markers stay
/// literal (streaming-friendly: partial chunks render as plain text).
fn inline_spans(s: &str, base: Style, th: &crate::theme::Theme) -> Vec<Span<'static>> {
    let chars: Vec<char> = s.chars().collect();
    let mut out: Vec<Span<'static>> = Vec::new();
    let mut cur = String::new();
    let mut i = 0usize;
    let flush = |cur: &mut String, out: &mut Vec<Span<'static>>, style: Style| {
        if !cur.is_empty() {
            out.push(Span::styled(std::mem::take(cur), style));
        }
    };
    while i < chars.len() {
        if chars[i] == '`' {
            if let Some(end) = (i + 1..chars.len()).find(|&j| chars[j] == '`') {
                flush(&mut cur, &mut out, base);
                let code: String = chars[i + 1..end].iter().collect();
                out.push(Span::styled(code, t::plain(th.code_fg)));
                i = end + 1;
                continue;
            }
        }
        if chars[i] == '*' && i + 1 < chars.len() && chars[i + 1] == '*' {
            if let Some(end) = (i + 2..chars.len()).find(|&j| j + 1 < chars.len() && chars[j] == '*' && chars[j + 1] == '*') {
                flush(&mut cur, &mut out, base);
                let bolded: String = chars[i + 2..end].iter().collect();
                if !bolded.is_empty() {
                    out.push(Span::styled(bolded, base.add_modifier(Modifier::BOLD)));
                }
                i = end + 2;
                continue;
            }
        }
        cur.push(chars[i]);
        i += 1;
    }
    flush(&mut cur, &mut out, base);
    out
}

/// Wrap `spans` to `max` display columns and coalesce adjacent same-style
/// chars back into styled spans; continuation lines get `cont` (style)
/// indented by `cont_prefix`.
fn push_wrapped(
    out: &mut Vec<Vec<Span<'static>>>,
    spans: &[Span<'static>],
    cont_prefix: &str,
    cont_style: Style,
    max: usize,
) {
    let lines = wrap_spans(spans, max);
    let mut iter = lines.into_iter().peekable();
    while let Some(line) = iter.next() {
        let coalesced = coalesce(line);
        if iter.peek().is_none() {
            // Last (wrapped) line always keeps the full span style.
            out.push(coalesced);
        } else {
            let mut l = vec![Span::styled(cont_prefix.to_string(), cont_style)];
            l.extend(coalesced);
            out.push(l);
        }
    }
}

fn coalesce(line: Vec<(char, Style)>) -> Vec<Span<'static>> {
    let mut out: Vec<Span<'static>> = Vec::new();
    let mut iter = line.into_iter().peekable();
    while let Some((ch, st)) = iter.next() {
        let mut s = String::new();
        s.push(ch);
        while let Some(&(c2, st2)) = iter.peek() {
            if st2 == st {
                s.push(c2);
                iter.next();
            } else {
                break;
            }
        }
        out.push(Span::styled(s, st));
    }
    out
}

// ---------------------------------------------------------------------------
// Event loop
// ---------------------------------------------------------------------------

pub async fn run(
    mut terminal: DefaultTerminal,
) -> Result<Option<String>, anyhow::Error> {
    let (client, mut acp_rx) = crate::acp::AcpClient::spawn().await?;

    let (key_tx, mut key_rx) = mpsc::unbounded_channel::<Event>();
    std::thread::spawn(move || {
        while let Ok(ev) = crossterm::event::read() {
            if key_tx.send(ev).is_err() {
                break;
            }
        }
    });

    let mut app = App::new();

    // Create the first session in the background.
    {
        let client2 = client.clone();
        let cwd = app.cwd.clone();
        tokio::spawn(async move {
            match client2.new_session(&cwd).await {
                Ok((sid, cfg)) => {
                    client2.emit(AcpEvent::ConfigUpdated(cfg));
                    client2.emit(AcpEvent::SessionCreated { session_id: sid });
                }
                Err(e) => client2.emit(AcpEvent::ServerGone(format!("创建会话失败: {e:#}"))),
            }
        });
    }

    // Background kernel version check (non-blocking; a short-lived `dsh
    // --version` process). Warns when the installed kernel predates the
    // ACP surface the TUI relies on.
    {
        let c2 = client.clone();
        tokio::spawn(async move {
            match tokio::time::timeout(std::time::Duration::from_secs(5), kernel_version()).await {
                Ok(Some(v)) if !version_ok(&v) => {
                    c2.emit(AcpEvent::Notice(format!(
                        "警告: dsh {v} 低于要求的 0.1.2-alpha.2（ACP 面可能不完整），请 npm i -g @deepseek-ai/dsh 升级"
                    )));
                }
                Ok(Some(_)) => {}
                _ => c2.emit(AcpEvent::Notice(
                    "警告: 无法获取 dsh 版本（dsh 不在 PATH？用 DSH_BIN 指定）".into(),
                )),
            }
        });
    }

    // Render cadence: while busy the spinner animates at ~30fps; idle frames
    // only happen on demand (dirty) — see the gate below.
    let mut render_tick = tokio::time::interval(std::time::Duration::from_millis(33));
    render_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_draw = Instant::now();

    ui::draw(&mut terminal, &mut app)?;
    loop {
        tokio::select! {
            k = key_rx.recv() => match k {
                Some(ev) => handle_key(&mut app, &client, ev).await?,
                None => break,
            },
            e = acp_rx.recv() => match e {
                Some(ev) => {
                    if handle_acp(&mut app, &client, ev) {
                        break;
                    }
                }
                None => break,
            },
            _ = render_tick.tick() => {}
        }
        // Advance the typewriter reveal (paced by the 33ms render tick).
        app.tick_reveal();
        if app.quit_requested() {
            // Cancel any in-flight prompt first: the prompt task holds a
            // client clone, so without cancellation the runtime would linger
            // until the (possibly very long) prompt settles.
            if app.state == RunState::Busy {
                if let Some(sid) = app.session_id.clone() {
                    client.cancel(&sid);
                }
            }
            break;
        }
        // Gate: redraw only when (a) something changed and enough time passed
        // to coalesce bursts of streaming chunks, or (b) busy — the spinner
        // is time-based and needs the ~30fps cadence. Idle + clean = zero
        // draw work per tick.
        let busy = matches!(app.state, RunState::Busy | RunState::Booting);
        let min_gap = if busy {
            std::time::Duration::from_millis(33)
        } else {
            std::time::Duration::from_millis(8)
        };
        if (app.dirty || busy) && last_draw.elapsed() >= min_gap {
            ui::draw(&mut terminal, &mut app)?;
            last_draw = Instant::now();
        }
    }

    Ok(app.fatal.take())
}

impl App {
    fn request_quit(&mut self) {
        self.quit = true;
    }

    fn quit_requested(&self) -> bool {
        self.quit
    }
}

// ---------------------------------------------------------------------------
// Keyboard / mouse handling
// ---------------------------------------------------------------------------

async fn handle_key(app: &mut App, client: &AcpClient, ev: Event) -> Result<(), anyhow::Error> {
    let key = match ev {
        Event::Mouse(m) => {
            match m.kind {
                MouseEventKind::ScrollUp => app.scroll_by(3),
                MouseEventKind::ScrollDown => app.scroll_by(-3),
                _ => {}
            }
            return Ok(());
        }
        Event::Key(k) if k.kind == KeyEventKind::Press => {
            app.dirty = true; // any keypress deserves immediate feedback
            k
        }
        Event::Resize(_, _) => {
            app.dirty = true;
            return Ok(());
        }
        _ => return Ok(()),
    };

    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        app.request_quit();
        return Ok(());
    }

    // --- permission dialog has top priority -------------------------------
    if let Dialog::Permission { request_id, options, selected, .. } = &mut app.dialog {
        match key.code {
            KeyCode::Up => {
                *selected = selected.saturating_sub(1);
            }
            KeyCode::Down => {
                if *selected + 1 < options.len() {
                    *selected += 1;
                }
            }
            KeyCode::Enter => {
                let rid = request_id.clone();
                let oid = options.get(*selected).map(|o| o.option_id.clone());
                client.respond_permission(rid, oid);
                app.dialog = Dialog::None;
                advance_permission_queue(app);
            }
            KeyCode::Esc => {
                client.respond_permission(request_id.clone(), None);
                app.dialog = Dialog::None;
                advance_permission_queue(app);
            }
            _ => {}
        }
        return Ok(());
    }

    // --- session list overlay ----------------------------------------------
    if let Dialog::Sessions { items, selected } = &mut app.dialog {
        match key.code {
            KeyCode::Up => {
                *selected = selected.saturating_sub(1);
            }
            KeyCode::Down => {
                if *selected + 1 < items.len() {
                    *selected += 1;
                }
            }
            KeyCode::Enter => {
                let Some(item) = items.get(*selected).cloned() else {
                    return Ok(());
                };
                app.dialog = Dialog::None;
                resume_session(app, client, item).await;
                advance_permission_queue(app);
            }
            KeyCode::Esc => {
                app.dialog = Dialog::None;
                advance_permission_queue(app);
            }
            _ => {}
        }
        return Ok(());
    }

    // --- config (model / effort) dialog ------------------------------------
    if let Dialog::Config { id, title, choices, selected, .. } = &mut app.dialog {
        match key.code {
            KeyCode::Up => {
                *selected = selected.saturating_sub(1);
            }
            KeyCode::Down => {
                if *selected + 1 < choices.len() {
                    *selected += 1;
                }
            }
            KeyCode::Enter => {
                let Some(choice) = choices.get(*selected).cloned() else {
                    return Ok(());
                };
                let (id, title) = (id.clone(), title.clone());
                app.dialog = Dialog::None;
                apply_config(app, client, &id, &title, choice).await;
                advance_permission_queue(app);
            }
            KeyCode::Esc => {
                app.dialog = Dialog::None;
                advance_permission_queue(app);
            }
            _ => {}
        }
        return Ok(());
    }

    // --- info panel (/help /status /cost) ----------------------------------
    if let Dialog::Info { lines, selected, .. } = &mut app.dialog {
        match key.code {
            KeyCode::Up => {
                *selected = selected.saturating_sub(1);
            }
            KeyCode::Down => {
                if *selected + 1 < lines.len() {
                    *selected += 1;
                }
            }
            KeyCode::PageUp => {
                *selected = selected.saturating_sub(10);
            }
            KeyCode::PageDown => {
                *selected = (*selected + 10).min(lines.len().saturating_sub(1));
            }
            KeyCode::Home => {
                *selected = 0;
            }
            KeyCode::End => {
                *selected = lines.len().saturating_sub(1);
            }
            KeyCode::Esc => {
                app.dialog = Dialog::None;
                advance_permission_queue(app);
            }
            _ => {}
        }
        return Ok(());
    }

    // --- slash command menu -------------------------------------------------
    let menu: Vec<&'static Cmd> = app.cmd_matches();
    let menu_active = app.input.starts_with('/') && !app.input.contains(' ') && !menu.is_empty();
    if menu_active {
        let rows = grouped_menu(&menu);
        // Snap the selection onto the first selectable command row (rows
        // begin with a group header).
        let sel = {
            let s = app.cmd_selected.min(rows.len() - 1);
            if matches!(rows[s], MenuRow::Cmd(_)) {
                s
            } else {
                rows.iter().position(|r| matches!(r, MenuRow::Cmd(_))).unwrap_or(0)
            }
        };
        match key.code {
            KeyCode::Up => {
                app.cmd_selected = nav_cmd(&rows, sel, -1);
                return Ok(());
            }
            KeyCode::Down => {
                app.cmd_selected = nav_cmd(&rows, sel, 1);
                return Ok(());
            }
            KeyCode::Tab => {
                if let MenuRow::Cmd(c) = rows[sel] {
                    app.input = c.name.to_string();
                }
                return Ok(());
            }
            KeyCode::Enter => {
                if let MenuRow::Cmd(cmd) = rows[sel] {
                    app.input.clear();
                    app.cmd_selected = 0;
                    run_command(app, client, cmd).await;
                }
                return Ok(());
            }
            KeyCode::Esc => {
                app.input.clear();
                app.cmd_selected = 0;
                return Ok(());
            }
            _ => {}
        }
    }

    // --- main mode ----------------------------------------------------------
    match key.code {
        KeyCode::Char('l') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            open_sessions(app, client).await;
        }
        KeyCode::Char('n') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            new_session(app, client).await;
        }
        KeyCode::Char('m') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            open_config(app, client, "model", "模型").await;
        }
        KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            open_config(app, client, "reasoning_effort", "推理档位").await;
        }
        KeyCode::Char('o') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            // Toggle the detail preview of the most recent tool call (pi
            // `tools.expand` analog).
            if let Some(id) = app.last_tool_id.clone() {
                let v = app.tool_collapsed.entry(id).or_insert(false);
                *v = !*v;
            }
        }
        KeyCode::PageUp => {
            app.scroll_by(10);
        }
        KeyCode::PageDown => {
            app.scroll_by(-10);
        }
        KeyCode::Home => {
            app.scroll_from_bottom = u16::MAX;
        }
        KeyCode::End => {
            app.scroll_from_bottom = 0;
        }
        KeyCode::Esc => {
            if app.state == RunState::Busy {
                if let Some(sid) = app.session_id.clone() {
                    client.cancel(&sid);
                    app.sysnote("已请求取消…");
                }
                app.flush_reveal(); // show whatever the kernel already sent
            } else if !app.input.is_empty() {
                app.input.clear();
            } else if app.queue_len() > 0 {
                app.queue.clear();
                app.sysnote("已清空排队消息");
            }
        }
        KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) => {
            // Multi-line editing (pi editor convention): Shift+Enter inserts
            // a newline, plain Enter submits.
            app.input.push('\n');
            app.cmd_selected = 0;
        }
        KeyCode::Enter => {
            let text = app.input.trim().to_string();
            if text.is_empty() {
                return Ok(());
            }
            // `!cmd` / `!!cmd` shell passthrough (pi-inspired): run the
            // command locally; `!` sends its output to the model as context,
            // `!!` just shows the result in the transcript.
            if let Some(rest) = text.strip_prefix('!') {
                let send = !rest.starts_with('!');
                let cmd = if send { rest } else { &rest[1..] };
                if !cmd.trim().is_empty() {
                    app.push_history(&text);
                    app.input.clear();
                    run_shell(app, client, cmd.trim().to_string(), send);
                    return Ok(());
                }
            }
            // Verbatim slash command (canonical name or alias); anything
            // unmatched is sent to the agent as a normal message (kimi-style).
            if let Some(cmd) = resolve_cmd(&text) {
                app.input.clear();
                run_command(app, client, cmd).await;
                return Ok(());
            }
            if app.state == RunState::Busy {
                // dsh allows one in-flight prompt per session; queue instead.
                if let Some(sid) = app.session_id.clone() {
                    note_session_title(&mut app.titles, &sid, &text);
                }
                app.queue.push_back(text.clone());
                app.push_history(&text);
                app.input.clear();
                app.sysnote(&format!("已排队（第 {} 条，完成后自动发送）", app.queue_len()));
                return Ok(());
            }
            let Some(sid) = app.session_id.clone() else {
                app.sysnote("会话尚未就绪，请稍候…");
                return Ok(());
            };
            note_session_title(&mut app.titles, &sid, &text);
            app.push_entry(EntryKind::User, &text);
            app.push_history(&text);
            app.input.clear();
            app.state = RunState::Busy;
            app.busy_since = Some(Instant::now());
            app.scroll_from_bottom = 0; // sending snaps the view to the latest
            client.prompt(sid, text);
        }
        KeyCode::Backspace => {
            app.input.pop();
            app.cmd_selected = 0;
        }
        KeyCode::Up => {
            if !app.history.is_empty() {
                let idx = match app.hist_cursor {
                    Some(i) => i.saturating_sub(1),
                    None => app.history.len() - 1,
                };
                app.hist_cursor = Some(idx);
                app.input = app.history[idx].clone();
            }
        }
        KeyCode::Down => {
            if let Some(i) = app.hist_cursor {
                if i + 1 < app.history.len() {
                    app.hist_cursor = Some(i + 1);
                    app.input = app.history[i + 1].clone();
                } else {
                    app.hist_cursor = None;
                    app.input.clear();
                }
            }
        }
        KeyCode::Char(ch) => {
            app.input.push(ch);
            app.cmd_selected = 0;
        }
        _ => {}
    }
    Ok(())
}

async fn open_sessions(app: &mut App, client: &AcpClient) {
    if app.state == RunState::Busy {
        app.sysnote("任务运行中，稍后再打开会话列表");
        return;
    }
    app.sysnote("正在获取会话列表…");
    match client.list_sessions().await {
        Ok(items) => app.dialog = Dialog::Sessions { items, selected: 0 },
        Err(e) => app.sysnote(&format!("获取会话列表失败: {e:#}")),
    }
}

/// Execute a slash command chosen from the menu (or typed verbatim).
async fn run_command(app: &mut App, client: &AcpClient, cmd: &Cmd) {
    if cmd.idle_only && app.state == RunState::Busy {
        app.sysnote(&format!("{} 忙时不可用（Esc 取消当前任务后再试）", cmd.name));
        return;
    }
    match cmd.name {
        "/quit" => app.request_quit(),
        "/new" => new_session(app, client).await,
        "/list" => open_sessions(app, client).await,
        "/model" => open_config(app, client, "model", "模型").await,
        "/effort" => open_config(app, client, "reasoning_effort", "推理档位").await,
        "/cost" => open_info(app, "今日用量与费用", cost_report()),
        "/usage" => open_info(app, "会话用量", usage_report(app)),
        "/status" => open_info(app, "状态", status_lines(app)),
        "/doctor" => open_info(app, "环境自检", doctor_report()),
        "/preset" => open_info(app, "Agent Presets", preset_report()),
        "/permission" => open_info(app, "本地权限规则", permission_report(app)),
        "/web" => start_web(client),
        "/clear" => {
            app.reset_transcript();
            app.sysnote("已清屏（会话上下文不受影响）");
        }
        "/help" => {
            let mut lines = vec![
                "斜杠命令（别名同样可匹配，如 /sessions=/list、/exit=/quit）".to_string(),
                format!("dsh-tui v{} — ACP v1 客户端（内核 dsh 只读复用）", env!("CARGO_PKG_VERSION")),
                String::new(),
            ];
            for group in CmdGroup::ORDER {
                let items: Vec<&Cmd> = COMMANDS.iter().filter(|c| c.group == group).collect();
                if items.is_empty() {
                    continue;
                }
                lines.push(format!("── {} ──", group.label()));
                for c in items {
                    lines.push(format!("  {:<8} — {}", c.name, c.desc));
                }
                lines.push(String::new());
            }
            lines.push("在输入框输入 !cmd 执行本地命令（!!cmd 只显示结果，不发给模型）".to_string());
            lines.push("忙时仅 /model /effort /cost /usage /status 等可用；Esc 取消任务后恢复".to_string());
            lines.push("按键：↑↓ 滚动 · Esc 关闭".to_string());
            open_info(app, "帮助", lines);
        }
        other => app.sysnote(&format!("未知命令 {other}（输入 / 查看命令菜单）")),
    }
}

/// Open the generic scrollable info panel.
fn open_info(app: &mut App, title: &str, lines: Vec<String>) {
    app.dialog = Dialog::Info { title: title.to_string(), lines, selected: 0 };
}

/// Open the model / reasoning-effort picker from the advertised config state.
///
/// The model catalog is refreshed first: `session/new` computes its
/// `configOptions` before the settings-backed pi-ai provider adapters have
/// registered, so the snapshot may advertise only the built-in DeepSeek
/// route. A no-op `set_config_option` pulls the current full state, keeping
/// the picker in sync with the web GUI's model list.
async fn open_config(app: &mut App, client: &AcpClient, id: &str, title: &str) {
    if let Some(sid) = app.session_id.clone() {
        let current = app
            .config
            .iter()
            .find(|c| c.id == "model")
            .map(|c| c.current.clone())
            .unwrap_or_default();
        if !current.is_empty() {
            app.sysnote("正在刷新模型列表…");
            if let Ok(cfg) = client.refresh_config(&sid, &current).await {
                if !cfg.is_empty() {
                    app.config = cfg;
                }
            }
        }
    }
    let Some(opt) = app.config.iter().find(|c| c.id == id) else {
        app.sysnote("配置尚未就绪（会话还在初始化？）");
        return;
    };
    if opt.options.is_empty() {
        app.sysnote(&format!("{title}：没有可选项"));
        return;
    }
    // Same-named models from different providers are distinguishable by their
    // provider group (`my-api · DeepSeek V4 Flash` vs `deepseek-official · …`).
    let has_groups = opt.options.iter().any(|c| c.group.is_some());
    let display: Vec<ConfigChoice> = opt
        .options
        .iter()
        .map(|ch| {
            let mut c = ch.clone();
            if has_groups {
                if let Some(g) = &c.group {
                    c.name = format!("{g} · {}", c.name);
                }
            }
            c
        })
        .collect();
    app.dialog = Dialog::Config {
        id: opt.id.clone(),
        title: title.to_string(),
        current: opt.current.clone(),
        choices: display,
        selected: 0,
    };
}

async fn apply_config(app: &mut App, client: &AcpClient, id: &str, title: &str, choice: ConfigChoice) {
    let Some(sid) = app.session_id.clone() else {
        app.sysnote("会话尚未就绪");
        return;
    };
    app.sysnote(&format!("正在切换{title} → {}…", choice.name));
    match client.set_config_option(&sid, id, &choice.value).await {
        Ok(cfg) => {
            if !cfg.is_empty() {
                app.config = cfg;
            }
            app.sysnote(&format!("{title}已切换 → {}", choice.name));
            // Persist the choice so future sessions start with it.
            if id == "model" {
                app.pref.model = Some(choice.value.clone());
            }
            if id == "reasoning_effort" {
                app.pref.effort = Some(choice.value.clone());
            }
            save_prefs(&app.pref);
        }
        Err(e) => app.sysnote(&format!("切换失败: {e:#}")),
    }
}

async fn new_session(app: &mut App, client: &AcpClient) {
    if app.state == RunState::Busy {
        app.sysnote("任务运行中，无法新建会话");
        return;
    }
    app.sysnote("正在创建新会话…");
    let old = app.session_id.clone();
    match client.new_session(&app.cwd).await {
        Ok((sid, cfg)) => {
            // Guard against the stale snapshot clobbering the already-synced
            // catalog (see catalog_is_richer).
            if !cfg.is_empty() && catalog_is_richer(&cfg, &app.config) {
                app.config = cfg;
            }
            if let Some(o) = old {
                let _ = client.close_session(&o).await;
            }
            app.session_id = Some(sid.clone());
            app.reset_transcript();
            app.busy_since = None;
            app.sysnote(&format!("新会话已创建 {}", short_id(&sid)));
        }
        Err(e) => app.sysnote(&format!("创建会话失败: {e:#}")),
    }
}

async fn resume_session(app: &mut App, client: &AcpClient, item: ListedSession) {
    if app.state == RunState::Busy {
        app.sysnote("当前会话有任务运行中，无法切换");
        return;
    }
    app.sysnote(&format!("正在恢复会话 {}…", short_id(&item.session_id)));
    let cwd = if item.cwd.is_empty() {
        app.cwd.to_string_lossy().to_string()
    } else {
        item.cwd.clone()
    };
    match client.resume_session(&item.session_id, &cwd).await {
        Ok(sid) => {
            if let Some(old) = app.session_id.clone() {
                let _ = client.close_session(&old).await;
            }
            app.session_id = Some(sid.clone());
            app.reset_transcript();
            app.busy_since = None;
            app.sysnote(&format!(
                "已恢复会话 {}（ACP 不回放历史内容，但对话上下文已在内核恢复，可继续对话）",
                short_id(&sid)
            ));
        }
        Err(e) => app.sysnote(&format!("恢复失败: {e:#}")),
    }
}

/// Start (or reveal) the web GUI from inside the TUI.
///
/// `dsh web` serves the browser UI on the composed port (default 3080,
/// override with `DSH_TUI_WEB_PORT`). If the port is already listening we
/// just print the URL; otherwise the web profile is spawned detached (it
/// opens the default browser itself) and we poll until it accepts TCP.
fn start_web(client: &AcpClient) {
    let port: u16 = std::env::var("DSH_TUI_WEB_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3080);
    let url = format!("http://127.0.0.1:{port}");
    let addr = format!("127.0.0.1:{port}");

    let c = client.clone();
    tokio::spawn(async move {
        use std::time::Duration;
        if tokio::net::TcpStream::connect(&addr).await.is_ok() {
            c.emit(AcpEvent::WebStatus { up: true, url: url.clone() });
            c.emit(AcpEvent::Notice(format!("web 已在运行：{url}")));
            return;
        }
        c.emit(AcpEvent::Notice("正在启动 dsh web（后台）…".into()));
        match spawn_web(port) {
            Ok(_) => {
                for i in 0..45u32 {
                    tokio::time::sleep(Duration::from_millis(1000)).await;
                    if tokio::net::TcpStream::connect(&addr).await.is_ok() {
                        c.emit(AcpEvent::WebStatus { up: true, url: url.clone() });
                        c.emit(AcpEvent::Notice(format!(
                            "web 已启动：{url}（浏览器已打开；退出 TUI 不影响 web）"
                        )));
                        return;
                    }
                    if i > 0 && i % 5 == 0 {
                        c.emit(AcpEvent::Notice(format!("等待 web 就绪…（{}s）", i)));
                    }
                }
                c.emit(AcpEvent::WebStatus { up: false, url: url.clone() });
                c.emit(AcpEvent::Notice(format!(
                    "web 启动超时：{url} 未监听。请手动运行 `dsh web` 查看原因"
                )));
            }
            Err(e) => {
                c.emit(AcpEvent::WebStatus { up: false, url: url.clone() });
                c.emit(AcpEvent::Notice(format!(
                    "启动 dsh web 失败: {e:#}（请手动运行 `dsh web`）"
                )));
            }
        }
    });
}

/// Spawn `dsh web --port <port>` detached from the TUI. On Windows the npm
/// `dsh` shim is a .cmd file, so we route through `cmd /C start` (new
/// console; the intermediate cmd exits immediately). On Unix a background
/// shell job is used.
#[cfg(target_os = "windows")]
fn spawn_web(port: u16) -> std::io::Result<std::process::Child> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", "dsh", "web", "--port", &port.to_string()])
        .spawn()
}

#[cfg(not(target_os = "windows"))]
fn spawn_web(port: u16) -> std::io::Result<std::process::Child> {
    std::process::Command::new("sh")
        .args(["-c", &format!("nohup dsh web --port {port} >/dev/null 2>&1 &")])
        .spawn()
}

// ---------------------------------------------------------------------------
// `!` / `!!` shell passthrough (pi-inspired): commands run locally with the
// TUI's cwd; `!cmd` also forwards the captured output to the model as a
// prompt (context), `!!cmd` only prints the result in the transcript.
// ---------------------------------------------------------------------------

const SHELL_OUTPUT_LIMIT: usize = 8000;

struct ShellResult {
    output: String,
    truncated: bool,
    exit_code: Option<i32>,
}

/// Kick off a local shell command in the background; the result arrives as
/// [`AcpEvent::ShellDone`] so the UI keeps rendering while it runs.
fn run_shell(app: &mut App, client: &AcpClient, cmd: String, send: bool) {
    app.sysnote(&format!("$ {cmd}（运行中…）"));
    let c = client.clone();
    tokio::spawn(async move {
        let r = run_shell_cmd(&cmd).await;
        c.emit(AcpEvent::ShellDone {
            cmd,
            output: r.output,
            truncated: r.truncated,
            exit_code: r.exit_code,
            send,
        });
    });
}

async fn run_shell_cmd(cmd: &str) -> ShellResult {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;

    let mut builder = if cfg!(target_os = "windows") {
        let mut b = tokio::process::Command::new("cmd");
        b.args(["/C", cmd]);
        b
    } else {
        let mut b = tokio::process::Command::new("sh");
        b.args(["-c", cmd]);
        b
    };
    builder
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match builder.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ShellResult {
                output: format!("无法启动 shell: {e}"),
                truncated: false,
                exit_code: None,
            };
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut out_buf = Vec::new();
    let mut err_buf = Vec::new();
    let out_task = async {
        if let Some(mut s) = stdout {
            let _ = s.read_to_end(&mut out_buf).await;
        }
    };
    let err_task = async {
        if let Some(mut s) = stderr {
            let _ = s.read_to_end(&mut err_buf).await;
        }
    };
    let (status, _, _) = tokio::join!(child.wait(), out_task, err_task);

    let mut text = String::from_utf8_lossy(&out_buf).into_owned();
    let err = String::from_utf8_lossy(&err_buf).into_owned();
    if !err.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&err);
    }
    let truncated = text.chars().count() > SHELL_OUTPUT_LIMIT;
    if truncated {
        text = crate::acp::clip(&text, SHELL_OUTPUT_LIMIT);
    }
    ShellResult {
        output: text,
        truncated,
        exit_code: status.as_ref().ok().and_then(|s| s.code()),
    }
}

/// Version of the installed kernel (`dsh --version` first line), if any.
async fn kernel_version() -> Option<String> {
    let out = if cfg!(target_os = "windows") {
        tokio::process::Command::new("cmd")
            .args(["/C", "dsh --version"])
            .output()
            .await
            .ok()?
    } else {
        tokio::process::Command::new("dsh")
            .arg("--version")
            .output()
            .await
            .ok()?
    };
    let s = String::from_utf8_lossy(&out.stdout);
    s.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

/// Whether the kernel version satisfies the TUI's contract (>= 0.1.2).
fn version_ok(v: &str) -> bool {
    let nums: Vec<u32> = v
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|s| s.parse().ok())
        .collect();
    let maj = nums.first().copied().unwrap_or(0);
    let min = nums.get(1).copied().unwrap_or(0);
    let pat = nums.get(2).copied().unwrap_or(0);
    (maj, min, pat) >= (0, 1, 2)
}

fn advance_permission_queue(app: &mut App) {
    if !app.queued_permissions.is_empty() {
        let (request_id, tool_title, options) = app.queued_permissions.remove(0);
        app.dialog = Dialog::Permission { request_id, tool_title, options, selected: 0 };
    }
}

/// Whether `incoming` should replace `current` as the config state.
///
/// The `session/new` snapshot computes its `configOptions` before the
/// settings-backed pi-ai adapters register, so it may advertise only the
/// built-in DeepSeek route; the `config_option_update` notification that
/// follows carries the full multi-provider catalog. Because the two can
/// arrive in either order, a smaller catalog must never clobber a larger
/// one — the model catalog only grows as providers register, so comparing
/// the flattened model-choice count is a safe guard (a later provider
/// removal is reflected on the next explicit refresh from `/model`).
fn catalog_is_richer(incoming: &[ConfigOptionState], current: &[ConfigOptionState]) -> bool {
    let models = |cfg: &[ConfigOptionState]| {
        cfg.iter()
            .find(|c| c.id == "model")
            .map(|m| m.options.len())
            .unwrap_or(0)
    };
    models(incoming) >= models(current)
}

/// Number of distinct provider groups advertised by the model selector.
/// One group = only the built-in DeepSeek route; more than one = the
/// settings-backed pi-ai adapters have registered (catalog synced with web).
fn provider_group_count(cfg: &[ConfigOptionState]) -> usize {
    let mut seen = std::collections::HashSet::new();
    if let Some(m) = cfg.iter().find(|c| c.id == "model") {
        for ch in &m.options {
            if let Some(g) = &ch.group {
                seen.insert(g.clone());
            }
        }
    }
    seen.len()
}

// ---------------------------------------------------------------------------
// /status — current session / configuration summary
// ---------------------------------------------------------------------------

fn status_lines(app: &App) -> Vec<String> {
    let mut out = Vec::new();
    out.push(format!("工作目录: {}", app.cwd.display()));
    match &app.session_id {
        Some(sid) => {
            out.push(format!("会话: {}（{}）", short_id(sid), sid));
            out.push(format!(
                "本地标题: {}",
                app.local_title(sid).unwrap_or_else(|| "（未记录，发送首条消息后生成）".into())
            ));
        }
        None => out.push("会话: （尚未创建）".into()),
    }
    if let Some(m) = app.model_label() {
        out.push(format!("模型: {m}"));
    }
    if let Some(opt) = app.config.iter().find(|c| c.id == "reasoning_effort") {
        if !opt.current.is_empty() {
            out.push(format!("推理档位: {}", opt.current));
        }
    }
    if let Some((used, size)) = app.usage {
        let pct = if size > 0 { (used as f64 / size as f64) * 100.0 } else { 0.0 };
        out.push(format!("上下文: {} / {} tokens（{pct:.0}%）", used, size));
    } else {
        out.push("上下文: （尚无 usage 事件）".into());
    }
    let models = app
        .config
        .iter()
        .find(|c| c.id == "model")
        .map(|m| m.options.len())
        .unwrap_or(0);
    out.push(format!("模型目录: {} 个提供商分组 / {} 个模型", provider_group_count(&app.config), models));
    out.push(format!(
        "状态: {} · 排队 {} 条",
        match app.state {
            RunState::Booting => "启动中",
            RunState::Idle => "就绪",
            RunState::Busy => "运行中",
        },
        app.queue_len()
    ));
    out.push(format!("内核: dsh（ACP v1，要求 >= 0.1.2-alpha.2，可用 DSH_BIN 指定）"));
    out.push(String::new());
    out.push("提示: /cost 看今日用量 · !cmd 执行本地命令 · /web 打开 web".into());
    out
}

// ---------------------------------------------------------------------------
// /cost — today's token usage and estimated cost from the shared token-stats
// plugin storage (`$DSH_HOME/storages/token-stats.json`, same file the web
// GUI's token stats read). Prices: built-in reference table, overridable via
// `~/.dsh-tui/prices.json` (keys are model ids, prefix matching).
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Price {
    input: f64,
    cache_read: f64,
    cache_write: f64,
    output: f64,
}

fn cost_report() -> Vec<String> {
    let mut out = Vec::new();
    let Some(home) = dsh_home() else {
        return vec!["无法解析 DSH home（$DSH_HOME 或 ~/.dsh）".into()];
    };
    let path = home.join("storages").join("token-stats.json");
    let Ok(txt) = std::fs::read_to_string(&path) else {
        return vec![
            "未找到 token-stats.json".into(),
            format!("期望位置: {}", path.display()),
            "需要 dsh-token-stats 插件（已挂载在 acp profile 的 cordis.patch.yml）".into(),
        ];
    };
    let Ok(v) = serde_json::from_str::<Value>(&txt) else {
        return vec!["token-stats.json 解析失败".into()];
    };

    let today = today_iso();
    let day = v.get("days").and_then(|d| d.get(&today)).and_then(|d| d.as_object());
    let Some(day) = day else {
        return vec![
            format!("今日（{today}）暂无用量记录"),
            "提示: token 统计由 dsh-token-stats 插件写入，TUI/web 共用".into(),
        ];
    };

    let prices = load_prices();
    struct Row {
        provider: String,
        model: String,
        requests: u64,
        input: u64,
        output: u64,
        cache_read: u64,
        cache_write: u64,
        cost: f64,
    }
    let mut rows: Vec<Row> = Vec::new();
    for (provider, models) in day {
        for (model, stats) in models.as_object().unwrap_or(&serde_json::Map::new()) {
            let get = |k: &str| stats.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            let (input, output, cache_read, cache_write) = (get("inputTokens"), get("outputTokens"), get("cacheReadTokens"), get("cacheWriteTokens"));
            let price = price_for(&prices, model);
            let cost = match price {
                Some(p) => {
                    input as f64 * p.input
                        + output as f64 * p.output
                        + cache_read as f64 * p.cache_read
                        + cache_write as f64 * if p.cache_write > 0.0 { p.cache_write } else { p.input }
                }
                None => 0.0,
            };
            rows.push(Row {
                provider: provider.clone(),
                model: model.clone(),
                requests: get("requests"),
                input,
                output,
                cache_read,
                cache_write,
                cost,
            });
        }
    }
    rows.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    out.push(format!("今日 {} 用量（dsh-token-stats）", today));
    out.push(String::new());
    let mut total_cost = 0.0f64;
    let mut total_req = 0u64;
    for r in &rows {
        total_cost += r.cost;
        total_req += r.requests;
        out.push(format!(
            "  {} · {}  req={}  ↑{} ↓{}  cache {}  ≈{}",
            r.provider,
            r.model,
            r.requests,
            fmt_tokens(r.input),
            fmt_tokens(r.output),
            fmt_tokens(r.cache_read),
            if r.cost > 0.0 { fmt_usd(r.cost) } else { "—".to_string() }
        ));
    }
    if rows.is_empty() {
        out.push("  （今日无记录）".into());
    }
    out.push(String::new());
    let total_tokens = rows.iter().map(|r| r.input + r.output + r.cache_read + r.cache_write).sum::<u64>();
    out.push(format!(
        "合计: {} 次请求 · {} tokens · ≈{}",
        total_req,
        fmt_tokens(total_tokens),
        fmt_usd(total_cost)
    ));
    out.push("价格: 内置参考价，可被 ~/.dsh-tui/prices.json 覆盖（模型 id 前缀匹配）".into());
    out
}

/// /usage — per-session token statistics from the shared token-stats storage
/// (`sessions[date][sessionId]`). The storage keys may carry a "session-"
/// prefix, so match exact id, then 8-char suffix both ways.
fn usage_report(app: &App) -> Vec<String> {
    let Some(sid) = app.session_id.clone() else {
        return vec!["（尚未创建会话）".into()];
    };
    let Some(home) = dsh_home() else {
        return vec!["无法解析 DSH home（$DSH_HOME 或 ~/.dsh）".into()];
    };
    let path = home.join("storages").join("token-stats.json");
    let Ok(txt) = std::fs::read_to_string(&path) else {
        return vec![
            "未找到 token-stats.json（dsh-token-stats 插件未启用？）".into(),
            format!("期望位置: {}", path.display()),
        ];
    };
    let Ok(v) = serde_json::from_str::<Value>(&txt) else {
        return vec!["token-stats.json 解析失败".into()];
    };

    let short = short_id(&sid);
    let mut out = Vec::new();
    out.push(format!("当前会话 {}（{}）", short, sid));
    let Some(sessions) = v.get("sessions").and_then(|s| s.as_object()) else {
        out.push("（token-stats 中暂无会话级记录——由 dsh-token-stats 插件写入）".into());
        out.push("提示: /cost 查看今日全局用量；会话 id 在存储中可能有 session- 前缀差异".into());
        return out;
    };

    let mut req = 0u64;
    let mut input = 0u64;
    let mut output = 0u64;
    let mut cr = 0u64;
    let mut cw = 0u64;
    let mut reasoning = 0u64;
    let mut found = false;
    for (_date, day) in sessions {
        let Some(day) = day.as_object() else { continue };
        for (key, stats) in day {
            let key_matches = key == &sid
                || key.ends_with(short.as_str())
                || sid.ends_with(key.as_str());
            if !key_matches {
                continue;
            }
            let get = |k: &str| stats.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            req += get("requests");
            input += get("inputTokens");
            output += get("outputTokens");
            cr += get("cacheReadTokens");
            cw += get("cacheWriteTokens");
            reasoning += get("reasoningTokens");
            found = true;
        }
    }
    if !found {
        out.push("（token-stats 中暂无本会话记录）".into());
        out.push("提示: 会话 id 在存储中可能有 session- 前缀差异；/cost 查看今日全局用量".into());
        return out;
    }
    out.push(format!("请求: {req} 次"));
    out.push(format!("输入: {} tokens", fmt_tokens(input)));
    out.push(format!("输出: {} tokens", fmt_tokens(output)));
    out.push(format!("缓存读: {} tokens", fmt_tokens(cr)));
    out.push(format!("缓存写: {} tokens", fmt_tokens(cw)));
    out.push(format!("推理: {} tokens", fmt_tokens(reasoning)));
    out.push(format!("合计: {} tokens", fmt_tokens(input + output + cr + cw)));
    out
}

// ---------------------------------------------------------------------------
// /doctor — local environment diagnostics: dsh binary, shared ~/.dsh state,
// acp profile patch, TUI prefs. Everything is read-only local checks; the
// kernel is never touched. Run when the TUI misbehaves to locate the gap.
// ---------------------------------------------------------------------------

fn doctor_report() -> Vec<String> {
    let mut out = Vec::new();
    out.push(format!("dsh-tui v{} 环境自检", env!("CARGO_PKG_VERSION")));
    out.push(String::new());

    match std::env::var("DSH_BIN").ok().filter(|s| !s.is_empty()) {
        Some(b) => out.push(format!("DSH_BIN: {b}（自定义 dsh 路径）")),
        None => out.push("dsh 解析: PATH（Windows 经 cmd /C 包装）".into()),
    }
    let version = {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("cmd")
                .args(["/C", "dsh --version"])
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default()
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::process::Command::new("dsh")
                .arg("--version")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default()
        }
    };
    let v = version.trim().lines().next().unwrap_or("（无输出）").to_string();
    if v.is_empty() {
        out.push("✘ dsh --version 无输出 — dsh 不在 PATH？（npm i -g @deepseek-ai/dsh）".into());
    } else {
        out.push(format!("dsh --version: {v}"));
    }
    out.push(String::new());

    let Some(home) = dsh_home() else {
        out.push("✘ 无法解析 DSH home（DSH_HOME 或 USERPROFILE/HOME 缺失）".into());
        return out;
    };
    let mut mark = |name: &str, sub: &str| {
        let p = home.join(sub);
        out.push(if p.exists() {
            format!("✔ {name}: {}", p.display())
        } else {
            format!("✘ {name}: {}（缺失）", p.display())
        });
    };
    mark("settings.yaml", "settings.yaml");
    mark("acp profile", "profiles/acp");
    mark("cordis.patch.yml", "profiles/acp/cordis.patch.yml");
    mark("token-stats.json", "storages/token-stats.json");
    mark("workspace.json", "storages/workspace.json");

    let patch = home.join("profiles/acp/cordis.patch.yml");
    if let Ok(txt) = std::fs::read_to_string(&patch) {
        let ids: Vec<&str> = txt
            .lines()
            .map(|l| l.trim())
            .filter(|l| l.starts_with("- id:"))
            .map(|l| l.trim_start_matches("- id:").trim())
            .collect();
        if ids.is_empty() {
            out.push("acp patch: 无 insert 插件行".into());
        } else {
            out.push(format!("acp patch 插件行: {}", ids.join(", ")));
        }
    }
    out.push(String::new());

    let tui_dir = {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .ok();
        home.map(|h| PathBuf::from(h).join(".dsh-tui"))
    };
    if let Some(dir) = tui_dir {
        for f in ["prefs.json", "session-titles.json", "prices.json", "permission.json"] {
            let p = dir.join(f);
            out.push(if p.exists() {
                format!("✔ ~/.dsh-tui/{f}")
            } else {
                format!("· ~/.dsh-tui/{f}（可选，未创建）")
            });
        }
    }
    out.push(String::new());
    out.push("全部 ✔ 即环境就绪；✘ 项参考 install.ps1 / install.sh 与 README 安装与启动".into());
    out
}

/// /preset — list agent presets discovered in the Harness home roster
/// (`$DSH_HOME/.agent-presets/*/preset.yml`). Informational only: the ACP
/// surface has no preset-selection method, so switching presets happens on
/// the web/headless side (or via a custom profile composition).
fn preset_report() -> Vec<String> {
    let Some(home) = dsh_home() else {
        return vec!["无法解析 DSH home（$DSH_HOME 或 ~/.dsh）".into()];
    };
    let dir = home.join(".agent-presets");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return vec![format!("未找到 agent presets 目录: {}", dir.display())];
    };
    let mut presets: Vec<(String, String)> = Vec::new();
    for e in entries.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let yml = e.path().join("preset.yml");
        let Ok(txt) = std::fs::read_to_string(&yml) else { continue };
        let name = txt
            .lines()
            .find_map(|l| l.strip_prefix("name:").map(|s| s.trim().trim_matches('"').to_string()))
            .unwrap_or_else(|| e.file_name().to_string_lossy().into_owned());
        let desc = txt
            .lines()
            .find_map(|l| {
                l.strip_prefix("description:")
                    .map(|s| s.trim().trim_matches('"').to_string())
            })
            .unwrap_or_default();
        presets.push((name, desc));
    }
    presets.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = Vec::new();
    if presets.is_empty() {
        out.push(format!("{} 下没有 preset.yml", dir.display()));
    } else {
        out.push(format!("发现 {} 个 agent preset：", presets.len()));
        for (n, d) in presets {
            if d.is_empty() {
                out.push(format!("  {n}"));
            } else {
                out.push(format!("  {n} — {d}"));
            }
        }
    }
    out.push(String::new());
    out.push("ACP 面无 preset 切换方法；preset 由 web/headless 端的 profile 组合决定。".into());
    out
}

/// /permission — show the locally loaded auto-answer rules.
fn permission_report(app: &App) -> Vec<String> {
    let mut out = Vec::new();
    if app.perm_rules.is_empty() {
        out.push("未配置本地权限规则（内核权限弹窗全部手动确认）".into());
        out.push(String::new());
        out.push("在 ~/.dsh-tui/permission.json 添加规则：".into());
        out.push(r#"  { "rules": [ { "pattern": "read", "decision": "allow" } ] }"#.into());
        out.push("pattern 对工具标题做不区分大小写子串匹配；decision 为 allow/deny".into());
        out.push("allow 自动选择允许选项，deny 直接取消——纯客户端行为，内核无感知".into());
        return out;
    }
    out.push(format!("已加载 {} 条规则：", app.perm_rules.len()));
    for r in &app.perm_rules {
        let d = match r.decision {
            PermDecision::Allow => "allow",
            PermDecision::Deny => "deny",
        };
        out.push(format!("  {:<20} → {}", r.pattern, d));
    }
    out.push(String::new());
    out.push("编辑 ~/.dsh-tui/permission.json 后重启生效".into());
    out
}

fn load_prices() -> Vec<(String, Price)> {
    let mut v: Vec<(String, Price)> = vec![
        ("deepseek-v4-flash".into(), Price { input: 0.14, cache_read: 0.028, cache_write: 0.14, output: 0.28 }),
        ("deepseek-v4-flash-0731".into(), Price { input: 0.14, cache_read: 0.028, cache_write: 0.14, output: 0.28 }),
        ("deepseek-v4-flash-vision-exp".into(), Price { input: 0.14, cache_read: 0.028, cache_write: 0.14, output: 0.28 }),
        ("MiniMaxAI/MiniMax-M2.5".into(), Price { input: 0.30, cache_read: 0.03, cache_write: 0.30, output: 1.20 }),
        ("MiniMaxAI/MiniMax-M2.7".into(), Price { input: 0.30, cache_read: 0.06, cache_write: 0.30, output: 1.20 }),
        ("MiniMaxAI/MiniMax-M3".into(), Price { input: 0.30, cache_read: 0.06, cache_write: 0.30, output: 1.20 }),
        ("minimax-m3".into(), Price { input: 0.30, cache_read: 0.06, cache_write: 0.30, output: 1.20 }),
        ("glm-5.2".into(), Price { input: 0.10, cache_read: 0.02, cache_write: 0.10, output: 0.20 }),
        ("glm-5.3-flash".into(), Price { input: 0.10, cache_read: 0.02, cache_write: 0.10, output: 0.20 }),
        ("gpt-5.6".into(), Price { input: 1.25, cache_read: 0.125, cache_write: 1.25, output: 10.0 }),
        ("qwen3.8-max".into(), Price { input: 0.40, cache_read: 0.08, cache_write: 0.40, output: 0.80 }),
    ];
    // Overrides: ~/.dsh-tui/prices.json
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok();
    if let Some(home) = home {
        let p = PathBuf::from(home).join(".dsh-tui").join("prices.json");
        if let Ok(txt) = std::fs::read_to_string(p) {
            if let Ok(obj) = serde_json::from_str::<Value>(&txt) {
                if let Some(map) = obj.as_object() {
                    for (k, pv) in map {
                        let get = |f: &str| pv.get(f).and_then(|x| x.as_f64()).unwrap_or(0.0);
                        v.push((
                            k.clone(),
                            Price {
                                input: get("input"),
                                cache_read: get("cacheRead"),
                                cache_write: get("cacheWrite"),
                                output: get("output"),
                            },
                        ));
                    }
                }
            }
        }
    }
    v
}

fn price_for<'a>(prices: &'a [(String, Price)], model: &str) -> Option<&'a Price> {
    if let Some((_, p)) = prices.iter().find(|(k, _)| k == model) {
        return Some(p);
    }
    prices
        .iter()
        .filter(|(k, _)| model.starts_with(k.as_str()))
        .max_by_key(|(k, _)| k.len())
        .map(|(_, p)| p)
}

fn fmt_tokens(n: u64) -> String {
    if n >= 1_000_000_000 {
        format!("{:.1}B", n as f64 / 1e9)
    } else if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1e6)
    } else if n >= 1_000 {
        format!("{:.1}K", n as f64 / 1e3)
    } else {
        n.to_string()
    }
}

fn fmt_usd(v: f64) -> String {
    if v <= 0.0 {
        "$0".to_string()
    } else if v < 0.01 {
        format!("${:.4}", v)
    } else {
        format!("${:.3}", v)
    }
}

/// Local calendar date `YYYY-MM-DD` (Howard Hinnant civil algorithms; no
/// chrono dependency needed).
fn today_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(secs.div_euclid(86400));
    format!("{y:04}-{m:02}-{d:02}")
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Human-friendly relative time for a session's `updated_at` (RFC3339 string
/// or epoch milliseconds), falling back to the raw value.
pub(crate) fn rel_time(s: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let s = s.trim();
    let epoch = if let Ok(ms) = s.parse::<i64>() {
        Some(ms / 1000)
    } else if s.len() >= 19 && s.as_bytes().get(4) == Some(&b'-') {
        let parse = |a: usize, b: usize| s.get(a..b).and_then(|v| v.parse::<i64>().ok());
        let y = parse(0, 4).unwrap_or(0);
        let mo = parse(5, 7).unwrap_or(1);
        let d = parse(8, 10).unwrap_or(1);
        let h = parse(11, 13).unwrap_or(0);
        let mi = parse(14, 16).unwrap_or(0);
        let sec = parse(17, 19).unwrap_or(0);
        Some(days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + sec)
    } else {
        None
    };
    let Some(epoch) = epoch else {
        return s.to_string();
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let diff = now - epoch;
    if diff < 60 {
        "刚刚".to_string()
    } else if diff < 3600 {
        format!("{} 分钟前", diff / 60)
    } else if diff < 86400 {
        format!("{} 小时前", diff / 3600)
    } else if diff < 86400 * 7 {
        format!("{} 天前", diff / 86400)
    } else {
        let (y, m, d) = civil_from_days(epoch.div_euclid(86400));
        format!("{y:04}-{m:02}-{d:02}")
    }
}

// ---------------------------------------------------------------------------
// ACP event handling — returns true when the loop should exit
// ---------------------------------------------------------------------------

fn handle_acp(app: &mut App, client: &AcpClient, ev: AcpEvent) -> bool {
    match ev {
        AcpEvent::SessionCreated { session_id } => {
            app.session_id = Some(session_id.clone());
            app.busy_since = None;
            if app.state == RunState::Booting {
                app.state = RunState::Idle;
            }
            app.sysnote(&format!("会话就绪 {}", short_id(&session_id)));
            app.sysnote("输入 / 打开命令菜单 · /model 切模型 · /web 打开 web · Ctrl+C 退出");

            // The session/new snapshot advertises only the built-in DeepSeek
            // route (the settings-backed pi-ai adapters register a moment
            // later); the config_option_update notification carries the full
            // catalog and the ConfigUpdated guard keeps it. When the
            // notification was missed (catalog still stale here), pull the
            // catalog via a no-op set; then apply persisted model / effort
            // preferences against the complete list.
            let prefs = app.pref.clone();
            let snapshot = app.config.clone();
            let sid = session_id.clone();
            let c2 = client.clone();
            tokio::spawn(async move {
                let mut latest = snapshot;
                let mut current = latest
                    .iter()
                    .find(|c| c.id == "model")
                    .map(|c| c.current.clone())
                    .unwrap_or_default();
                let stale = provider_group_count(&latest) <= 1;
                let mut synced = !stale;
                if stale && !current.is_empty() {
                    for attempt in 0..4u32 {
                        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                        if let Ok(fresh) = c2.refresh_config(&sid, &current).await {
                            if !fresh.is_empty() {
                                if let Some(m) = fresh.iter().find(|c| c.id == "model") {
                                    current = m.current.clone();
                                }
                                latest = fresh;
                                // More than one provider group means the
                                // settings-backed adapters have registered.
                                if provider_group_count(&latest) > 1 || attempt >= 3 {
                                    synced = true;
                                    break;
                                }
                            }
                        }
                    }
                }
                c2.emit(AcpEvent::ConfigUpdated(latest.clone()));
                if synced {
                    c2.emit(AcpEvent::Notice("模型列表已与 web 端同步".into()));
                }
                // Re-apply persisted model / effort preferences to the fresh
                // session (dsh starts acp sessions on the profile's default).
                for (id, want) in
                    [("model", prefs.model.clone()), ("reasoning_effort", prefs.effort.clone())]
                {
                    let Some(want) = want else { continue };
                    let Some(opt) = latest.iter().find(|c| c.id == id) else {
                        continue;
                    };
                    if opt.current == want || !opt.options.iter().any(|ch| ch.value == want) {
                        continue;
                    }
                    if let Ok(newcfg) = c2.set_config_option(&sid, id, &want).await {
                        if !newcfg.is_empty() {
                            c2.emit(AcpEvent::ConfigUpdated(newcfg));
                            c2.emit(AcpEvent::Notice(format!("已应用上次选择的 {id} 偏好")));
                        }
                    }
                }
            });
            false
        }
        AcpEvent::MessageChunk(t) => {
            app.enqueue_reveal(EntryKind::Agent, &t);
            false
        }
        AcpEvent::ThoughtChunk(t) => {
            app.enqueue_reveal(EntryKind::Thought, &t);
            false
        }
        AcpEvent::ToolCall { tool_call_id, title, kind, status, raw } => {
            let text = if kind.is_empty() {
                title.clone()
            } else {
                format!("{title} [{kind}]")
            };
            app.entries.push(Entry {
                kind: EntryKind::Tool,
                text,
                status: Some(status.clone()),
                detail: raw,
                tool_id: Some(tool_call_id.clone()),
            });
            app.last_tool_id = Some(tool_call_id.clone());
            app.tool_idx.insert(tool_call_id.clone(), app.entries.len() - 1);
            app.tool_meta.insert(
                tool_call_id,
                ToolMeta { title, kind, status },
            );
            app.dirty = true;
            false
        }
        AcpEvent::ToolCallUpdate { tool_call_id, title, status } => {
            if let Some(&idx) = app.tool_idx.get(&tool_call_id) {
                if let Some(meta) = app.tool_meta.get_mut(&tool_call_id) {
                    if let Some(t) = title {
                        meta.title = t;
                    }
                    if let Some(s) = status {
                        meta.status = s;
                    }
                    let text = if meta.kind.is_empty() {
                        meta.title.clone()
                    } else {
                        format!("{} [{}]", meta.title, meta.kind)
                    };
                    app.entries[idx].text = text;
                    app.entries[idx].status = Some(meta.status.clone());
                    app.invalidate(idx);
                }
            }
            false
        }
        AcpEvent::Usage { used, size } => {
            app.usage = Some((used, size));
            app.dirty = true; // top-bar context bar + status line
            false
        }
        AcpEvent::ConfigUpdated(cfg) => {
            if !cfg.is_empty() && catalog_is_richer(&cfg, &app.config) {
                app.config = cfg;
                app.dirty = true; // model pill / picker
            }
            false
        }
        AcpEvent::PermissionRequest { request_id, tool_title, options } => {
            // Local auto-answer rules (kimi permission.rules style): a
            // matching rule responds immediately instead of popping the
            // dialog. Allow picks the first allow-kind option; deny cancels.
            let rule = app.perm_rules.iter().find(|r| {
                tool_title.to_lowercase().contains(&r.pattern.to_lowercase())
            });
            if let Some(rule) = rule {
                match rule.decision {
                    PermDecision::Allow => {
                        let oid = options
                            .iter()
                            .find(|o| o.kind.starts_with("allow"))
                            .map(|o| o.option_id.clone());
                        client.respond_permission(request_id, oid);
                        app.sysnote(&format!("[权限规则] 自动允许：{tool_title}"));
                    }
                    PermDecision::Deny => {
                        client.respond_permission(request_id, None);
                        app.sysnote(&format!("[权限规则] 自动拒绝：{tool_title}"));
                    }
                }
                app.dirty = true;
                return false;
            }
            if matches!(app.dialog, Dialog::None) {
                app.dialog = Dialog::Permission { request_id, tool_title, options, selected: 0 };
            } else {
                app.queued_permissions.push((request_id, tool_title, options));
            }
            app.dirty = true; // the permission dialog must appear immediately
            false
        }
        AcpEvent::PromptSettled { stop_reason, error } => {
            app.state = RunState::Idle;
            app.busy_since = None;
            // Defer the settle note until the typewriter reveal drains: the
            // kernel commits messages and settles in the same instant, and
            // "完成" above still-typing text reads backwards.
            app.pending_settle = Some(match &error {
                Some(err) => format!("请求失败: {err}"),
                None if stop_reason == "cancelled" => "已取消".to_string(),
                None => format!("— 完成（{stop_reason}）—"),
            });
            app.dirty = true;
            // Drain the queue: send the next queued message, if any.
            if error.is_none() && !app.queue.is_empty() {
                if let Some(sid) = app.session_id.clone() {
                    // The previous turn's note lands between the turns.
                    if let Some(note) = app.pending_settle.take() {
                        app.sysnote(&note);
                    }
                    let next = app.queue.pop_front().expect("checked non-empty");
                    app.push_entry(EntryKind::User, &next);
                    app.state = RunState::Busy;
                    app.busy_since = Some(Instant::now());
                    app.scroll_from_bottom = 0;
                    client.prompt(sid, next);
                }
            }
            false
        }
        AcpEvent::ShellDone { cmd, output, truncated, exit_code, send } => {
            if truncated {
                app.sysnote(&format!("$ {cmd}（输出过长，已截断）"));
            } else {
                app.sysnote(&format!("$ {cmd}"));
            }
            if !output.is_empty() {
                for line in output.lines() {
                    app.sysnote(line);
                }
            } else {
                app.sysnote("（无输出）");
            }
            if let Some(code) = exit_code {
                if code != 0 {
                    app.sysnote(&format!("exit {code}"));
                }
            }
            if send {
                // `!cmd`: hand the captured output to the model as context
                // (pi-style BashExecutionMessage mapping).
                let prompt_text = format!("[shell] $ {cmd}\n\n{output}");
                if app.state == RunState::Busy {
                    app.queue.push_back(prompt_text.clone());
                    app.sysnote(&format!("shell 输出已排队（第 {} 条，完成后自动发送）", app.queue_len()));
                } else if let Some(sid) = app.session_id.clone() {
                    app.push_entry(EntryKind::User, &prompt_text);
                    app.state = RunState::Busy;
                    app.busy_since = Some(Instant::now());
                    app.scroll_from_bottom = 0;
                    client.prompt(sid, prompt_text);
                } else {
                    app.sysnote("会话尚未就绪，shell 输出未发送");
                }
            }
            false
        }
        AcpEvent::WebStatus { up, url } => {
            app.web_url = up.then_some(url);
            app.dirty = true;
            false
        }
        AcpEvent::ServerGone(reason) => {
            if app.quit_requested() {
                false
            } else {
                app.fatal = Some(reason);
                true
            }
        }
        AcpEvent::Notice(line) => {
            app.note_line(&line);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialize tests that mutate process env vars (DSH_HOME / USERPROFILE).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn block_text(block: &[Vec<Span<'static>>]) -> String {
        block
            .iter()
            .map(|l| l.iter().map(|s| s.content.as_ref()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn today_iso_is_date_shaped() {
        let s = today_iso();
        assert_eq!(s.len(), 10);
        assert_eq!(s.as_bytes()[4], b'-');
        assert_eq!(s.as_bytes()[7], b'-');
        let (y, m, d) = (&s[0..4], &s[5..7], &s[8..10]);
        let y: i64 = y.parse().unwrap();
        let m: i64 = m.parse().unwrap();
        let d: i64 = d.parse().unwrap();
        assert!((2024..=2100).contains(&y));
        assert!((1..=12).contains(&m));
        assert!((1..=31).contains(&d));
    }

    #[test]
    fn rel_time_formats_epoch_and_rfc3339() {
        assert_eq!(rel_time("刚刚"), "刚刚"); // unknown → raw
        // epoch milliseconds ~1 minute ago
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let s = rel_time(&(now_ms - 90_000).to_string());
        assert!(s.contains("分钟前"), "got {s}");
        // RFC3339 today
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let (y, m, d) = civil_from_days(secs.div_euclid(86400));
        let rfc = format!("{y:04}-{m:02}-{d:02}T00:00:00Z");
        assert!(!rel_time(&rfc).is_empty());
        // ancient epoch → calendar date
        let old = rel_time("1000000");
        assert_eq!(old.len(), 10, "got {old}");
    }

    #[test]
    fn price_for_matches_exact_and_prefix() {
        let prices = load_prices();
        assert!(price_for(&prices, "deepseek-v4-flash").is_some());
        assert!(price_for(&prices, "gpt-5.6-sol").is_some()); // prefix "gpt-5.6"
        assert!(price_for(&prices, "unknown-model-xyz").is_none());
    }

    #[test]
    fn fmt_tokens_scales() {
        assert_eq!(fmt_tokens(0), "0");
        assert_eq!(fmt_tokens(999), "999");
        assert_eq!(fmt_tokens(12_345), "12.3K");
        assert_eq!(fmt_tokens(2_000_000), "2.0M");
    }

    #[test]
    fn cost_report_reads_token_stats() {
        let _guard = ENV_LOCK.lock().unwrap();
        // Point DSH_HOME at a temp dir with a synthetic token-stats.json.
        let tmp = std::env::temp_dir().join(format!("dsh-tui-test-{}", std::process::id()));
        let storages = tmp.join("storages");
        std::fs::create_dir_all(&storages).unwrap();
        let stats = serde_json::json!({
            "days": {
                today_iso(): {
                    "my-api": {
                        "deepseek-v4-flash": {
                            "requests": 2, "inputTokens": 1000, "outputTokens": 500,
                            "cacheReadTokens": 9000, "cacheWriteTokens": 0, "reasoningTokens": 0
                        }
                    }
                }
            },
            "sessions": {}
        });
        std::fs::write(storages.join("token-stats.json"), serde_json::to_string(&stats).unwrap()).unwrap();
        std::env::set_var("DSH_HOME", &tmp);

        let lines = cost_report();
        let joined = lines.join("\n");
        assert!(joined.contains("my-api · deepseek-v4-flash"), "{joined}");
        assert!(joined.contains("合计"), "{joined}");
        assert!(joined.contains("$"), "{joined}");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn shell_cmd_captures_output_and_exit_code() {
        let r = run_shell_cmd("echo hello-from-dsh-tui").await;
        assert!(r.output.contains("hello-from-dsh-tui"), "{}", r.output);
        assert_eq!(r.exit_code, Some(0));

        let fail = run_shell_cmd("exit 3").await;
        assert_eq!(fail.exit_code, Some(3));
    }

    #[test]
    fn commands_resolve_aliases_and_group() {
        // Canonical names and aliases both resolve.
        assert_eq!(resolve_cmd("/list").unwrap().name, "/list");
        assert_eq!(resolve_cmd("/sessions").unwrap().name, "/list");
        assert_eq!(resolve_cmd("/s").unwrap().name, "/list");
        assert_eq!(resolve_cmd("/exit").unwrap().name, "/quit");
        assert_eq!(resolve_cmd("/?").unwrap().name, "/help");
        assert!(resolve_cmd("/not-a-command").is_none());
        // Unmatched lines fall through to the agent (kimi-style).
        assert!(resolve_cmd("/mymessage").is_none());

        // Grouping: headers only between groups, canonical order.
        let all: Vec<&Cmd> = COMMANDS.iter().collect();
        let rows = grouped_menu(&all);
        let mut group_order = Vec::new();
        for r in &rows {
            match r {
                MenuRow::Header(h) => group_order.push(*h),
                MenuRow::Cmd(_) => {}
            }
        }
        assert_eq!(group_order, vec!["会话", "模型", "信息", "系统"]);

        // Navigation skips headers.
        let header = rows.iter().position(|r| matches!(r, MenuRow::Header(_))).unwrap();
        assert_eq!(nav_cmd(&rows, header, 1), header + 1);
        let last_cmd = rows.iter().rposition(|r| matches!(r, MenuRow::Cmd(_))).unwrap();
        assert_eq!(nav_cmd(&rows, last_cmd, 1), last_cmd); // clamps
    }

    #[test]
    fn permission_rules_load_and_report() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("dsh-tui-perm-{}", std::process::id()));
        let dsh_tui = tmp.join(".dsh-tui");
        std::fs::create_dir_all(&dsh_tui).unwrap();
        std::fs::write(
            dsh_tui.join("permission.json"),
            r#"{"rules": [{"pattern": "read", "decision": "allow"}, {"pattern": "bash", "decision": "deny"}]}"#,
        )
        .unwrap();
        std::env::set_var("USERPROFILE", &tmp);
        std::env::set_var("HOME", &tmp);

        let rules = load_permission_rules();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].pattern, "read");
        assert_eq!(rules[0].decision, PermDecision::Allow);
        assert_eq!(rules[1].decision, PermDecision::Deny);

        // Case-insensitive matching helper used by the handler.
        let title = "Bash(rm -rf *)";
        let hit = rules.iter().find(|r| title.to_lowercase().contains(&r.pattern.to_lowercase()));
        assert_eq!(hit.map(|r| &r.decision), Some(&PermDecision::Deny));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn doctor_report_is_shaped() {
        let lines = doctor_report();
        assert!(!lines.is_empty());
        assert!(lines[0].contains("环境自检"), "{lines:?}");
    }

    #[test]
    fn tool_card_renders_status_and_collapse() {
        let e = Entry {
            kind: EntryKind::Tool,
            text: "edit [write]".into(),
            status: Some("completed".into()),
            detail: Some("path/to/file.txt".into()),
            tool_id: Some("t1".into()),
        };
        let th = crate::theme::Theme::default();
        let open = block_text(&entry_block(&e, 60, true, false, &th));
        assert!(open.contains("已完成"), "{open}");
        assert!(open.contains("path/to/file.txt"), "{open}");
        assert!(open.starts_with("╭─"), "{open}");

        let closed = block_text(&entry_block(&e, 60, true, true, &th));
        assert!(closed.contains("已完成"), "{closed}");
        assert!(!closed.contains("path/to/file.txt"), "{closed}");
    }

    #[test]
    fn wrap_plain_respects_display_width() {
        use unicode_width::UnicodeWidthStr;
        let text = "你好world测试一二三";
        let lines = wrap_plain(text, 6);
        assert_eq!(lines.join(""), text);
        assert!(lines.iter().all(|l| UnicodeWidthStr::width(l.as_str()) <= 6), "{lines:?}");
    }

    #[test]
    fn preset_report_lists_presets() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("dsh-tui-preset-{}", std::process::id()));
        let preset = tmp.join(".agent-presets/liangshen");
        std::fs::create_dir_all(&preset).unwrap();
        std::fs::write(
            preset.join("preset.yml"),
            "name: 梁神模式\ndescription: 主 Agent 与子 Agent 首轮 Minimal\n",
        )
        .unwrap();
        std::env::set_var("DSH_HOME", &tmp);

        let lines = preset_report();
        let joined = lines.join("\n");
        assert!(joined.contains("梁神模式"), "{joined}");
        assert!(joined.contains("1 个 agent preset"), "{joined}");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn theme_override_loads_and_applies() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("dsh-tui-theme-{}", std::process::id()));
        let dsh_tui = tmp.join(".dsh-tui");
        std::fs::create_dir_all(&dsh_tui).unwrap();
        std::fs::write(
            dsh_tui.join("theme.json"),
            r##"{"accent": "#ff0000", "violet": "#00ff00", "bogus": "not-a-color"}"##,
        )
        .unwrap();
        std::env::set_var("USERPROFILE", &tmp);
        std::env::set_var("HOME", &tmp);

        let th = crate::theme::load_theme();
        assert_eq!(th.accent, ratatui::style::Color::Rgb(255, 0, 0));
        assert_eq!(th.violet, ratatui::style::Color::Rgb(0, 255, 0));
        // Untouched tokens keep the default palette.
        assert_eq!(th.ok, ratatui::style::Color::Rgb(74, 222, 128));
        // Invalid keys are ignored (parse failure), no panic.

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn typewriter_reveal_drains_to_full_text() {
        std::env::remove_var("DSH_TUI_NO_TYPEWRITER");
        let mut app = App::new();
        app.state = RunState::Idle;
        app.enqueue_reveal(EntryKind::Agent, "你好世界 hello");
        assert!(app.reveal_active());
        for _ in 0..60 {
            app.tick_reveal();
        }
        assert!(!app.reveal_active());
        let agent: String = app
            .entries
            .iter()
            .filter(|e| e.kind == EntryKind::Agent)
            .map(|e| e.text.clone())
            .collect();
        assert_eq!(agent, "你好世界 hello");
    }

    #[test]
    fn reveal_flush_shows_everything_instantly() {
        std::env::remove_var("DSH_TUI_NO_TYPEWRITER");
        let mut app = App::new();
        app.enqueue_reveal(EntryKind::Thought, "思考内容");
        app.enqueue_reveal(EntryKind::Agent, "回复内容");
        app.flush_reveal();
        assert!(!app.reveal_active());
        let thought: String = app
            .entries
            .iter()
            .filter(|e| e.kind == EntryKind::Thought)
            .map(|e| e.text.clone())
            .collect();
        assert_eq!(thought, "思考内容");
        let agent: String = app
            .entries
            .iter()
            .filter(|e| e.kind == EntryKind::Agent)
            .map(|e| e.text.clone())
            .collect();
        assert_eq!(agent, "回复内容");
    }

    #[test]
    fn reveal_seals_on_entry_push() {
        std::env::remove_var("DSH_TUI_NO_TYPEWRITER");
        let mut app = App::new();
        app.enqueue_reveal(EntryKind::Agent, "第一段");
        app.push_entry(EntryKind::Tool, "edit"); // seals the running reveal
        app.enqueue_reveal(EntryKind::Agent, "第二段");
        for _ in 0..80 {
            app.tick_reveal();
        }
        let agent_entries: Vec<&Entry> =
            app.entries.iter().filter(|e| e.kind == EntryKind::Agent).collect();
        assert_eq!(agent_entries.len(), 2, "tool card must break the reveal");
        assert_eq!(agent_entries[0].text, "第一段");
        assert_eq!(agent_entries[1].text, "第二段");
    }
}