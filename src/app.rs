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
}

#[derive(Clone)]
struct ToolMeta {
    title: String,
    kind: String,
    status: String,
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

pub struct Cmd {
    pub name: &'static str,
    pub desc: &'static str,
}

pub const COMMANDS: &[Cmd] = &[
    Cmd { name: "/help", desc: "显示所有命令" },
    Cmd { name: "/new", desc: "新建会话" },
    Cmd { name: "/list", desc: "历史会话列表" },
    Cmd { name: "/model", desc: "切换模型" },
    Cmd { name: "/effort", desc: "切换推理档位" },
    Cmd { name: "/cost", desc: "今日 token 用量与费用" },
    Cmd { name: "/status", desc: "当前会话 / 配置信息" },
    Cmd { name: "/web", desc: "启动/打开 web 界面" },
    Cmd { name: "/clear", desc: "清屏（不影响会话上下文）" },
    Cmd { name: "/quit", desc: "退出" },
];

/// Persisted user preferences (`~/.dsh-tui/prefs.json`): the last model /
/// effort choice is re-applied automatically to every new session, because
/// dsh creates acp sessions with the profile's default route.
#[derive(Clone, Default)]
pub struct Prefs {
    pub model: Option<String>,
    pub effort: Option<String>,
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
    /// Flattened, wrapped display lines (rebuilt lazily on change/resize).
    pub display: Vec<Vec<Span<'static>>>,

    quit: bool,

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
    debug_log: VecDeque<String>,
    /// Locally generated session titles (first user prompt → short title),
    /// persisted in `~/.dsh-tui/session-titles.json`. The dsh acp profile
    /// disables model-generated titles, so the TUI keeps its own.
    titles: HashMap<String, String>,
    cwd: PathBuf,
    dirty: bool,
    last_width: u16,
}

impl App {
    fn new() -> Self {
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
            display: Vec::new(),
            quit: false,
            queue: VecDeque::new(),
            cmd_selected: 0,
            pref: load_prefs(),
            history: Vec::new(),
            hist_cursor: None,
            queued_permissions: Vec::new(),
            tool_idx: HashMap::new(),
            tool_meta: HashMap::new(),
            debug_log: VecDeque::new(),
            titles: load_titles(),
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

    fn push_entry(&mut self, kind: EntryKind, text: &str) {
        self.entries.push(Entry { kind, text: text.to_string(), status: None, detail: None });
        self.dirty = true;
    }

    fn append_chunk(&mut self, kind: EntryKind, text: &str) {
        match self.entries.last_mut() {
            Some(e) if e.kind == kind => e.text.push_str(text),
            _ => self.entries.push(Entry {
                kind,
                text: text.to_string(),
                status: None,
                detail: None,
            }),
        }
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
    /// input is a bare `/prefix` with no space).
    pub fn cmd_matches(&self) -> Vec<&'static Cmd> {
        let Some(q) = self.input.strip_prefix('/') else {
            return Vec::new();
        };
        if self.input.contains(' ') {
            return Vec::new();
        }
        COMMANDS
            .iter()
            .filter(|c| c.name[1..].starts_with(q))
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
    }

    /// Rebuild the wrapped display lines when dirty or on resize.
    /// Each entry becomes a set of span lines; visual hints (hairline rule
    /// before a user turn) are inserted here too. Agent text goes through a
    /// markdown-lite pass (fences, headings, bullets, inline code/bold).
    pub fn ensure_display(&mut self, width: u16) {
        let w = width.max(10) as usize;
        if !self.dirty && self.last_width == width {
            return;
        }
        let mut out: Vec<Vec<Span<'static>>> = Vec::new();
        let mut seen_content = false;
        for e in &self.entries {
            match e.kind {
                EntryKind::User => {
                    if seen_content {
                        out.push(vec![Span::styled("─".repeat(w), t::plain(t::HAIRLINE))]);
                        out.push(vec![]);
                    }
                    seen_content = true;
                    for (i, seg) in e.text.split('\n').enumerate() {
                        let mut spans = Vec::new();
                        if i == 0 {
                            spans.push(Span::styled("❯ ".to_string(), t::bold(t::ACCENT)));
                        } else {
                            spans.push(Span::styled("  ".to_string(), t::bold(t::FG)));
                        }
                        spans.push(Span::styled(seg.to_string(), t::bold(t::FG)));
                        push_wrapped(&mut out, &spans, "  ", t::bold(t::FG), w);
                    }
                }
                EntryKind::Agent => {
                    seen_content = true;
                    for line in markdown_spans(&e.text) {
                        if line.is_empty() {
                            out.push(vec![]);
                        } else {
                            push_wrapped(&mut out, &line, "  ", t::plain(t::FG), w);
                        }
                    }
                }
                EntryKind::Thought => {
                    for (i, seg) in e.text.split('\n').enumerate() {
                        let mut spans = Vec::new();
                        if i == 0 {
                            spans.push(Span::styled(
                                "✻ ".to_string(),
                                t::plain(t::DIM).add_modifier(Modifier::ITALIC),
                            ));
                        } else {
                            spans.push(Span::styled(
                                "  ".to_string(),
                                t::plain(t::DIM).add_modifier(Modifier::ITALIC),
                            ));
                        }
                        spans.push(Span::styled(
                            seg.to_string(),
                            t::plain(t::DIM).add_modifier(Modifier::ITALIC),
                        ));
                        push_wrapped(&mut out, &spans, "  ", t::plain(t::DIM), w);
                    }
                }
                EntryKind::Tool => {
                    seen_content = true;
                    let mut spans = vec![
                        Span::styled("❯ ".to_string(), t::plain(t::ACCENT)),
                        Span::styled(format!("{} ", e.text), t::plain(t::FG)),
                    ];
                    match &e.status {
                        Some(s) => spans.push(Span::styled(
                            format!("● {s}"),
                            t::plain(t::status_color(s)),
                        )),
                        None => spans.push(Span::styled("● …", t::plain(t::MUTED))),
                    }
                    push_wrapped(&mut out, &spans, "  ", t::plain(t::FG), w);
                    if let Some(detail) = &e.detail {
                        let d = vec![
                            Span::styled("  ⤷ ".to_string(), t::plain(t::HAIRLINE)),
                            Span::styled(detail.clone(), t::plain(t::DIM)),
                        ];
                        push_wrapped(&mut out, &d, "    ", t::plain(t::DIM), w);
                    }
                }
                EntryKind::System => {
                    for (i, seg) in e.text.split('\n').enumerate() {
                        let mut spans = Vec::new();
                        if i == 0 {
                            spans.push(Span::styled("· ".to_string(), t::plain(t::DIM)));
                        } else {
                            spans.push(Span::styled("  ".to_string(), t::plain(t::DIM)));
                        }
                        spans.push(Span::styled(seg.to_string(), t::plain(t::DIM)));
                        push_wrapped(&mut out, &spans, "  ", t::plain(t::DIM), w);
                    }
                }
            }
            out.push(vec![]);
        }
        self.display = out;
        self.dirty = false;
        self.last_width = width;
    }
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

fn markdown_spans(text: &str) -> Vec<Vec<Span<'static>>> {
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
            out.push(vec![Span::styled(label, t::plain(t::HAIRLINE))]);
            continue;
        }
        if in_code {
            out.push(vec![
                Span::styled("  │ ".to_string(), t::plain(t::HAIRLINE)),
                Span::styled(line.to_string(), t::plain(t::CODE_FG)),
            ]);
            continue;
        }
        if trimmed.starts_with('#') {
            let stripped = trimmed.trim_start_matches('#').trim_start();
            out.push(vec![
                Span::styled("  ".to_string(), t::plain(t::FG)),
                Span::styled(stripped.to_string(), t::bold(t::ACCENT)),
            ]);
            continue;
        }
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            let indent_len = raw.len() - trimmed.len();
            let indent = " ".repeat(indent_len.min(6));
            out.push(inline_spans(
                &format!("{indent}• {}", &trimmed[2..]),
                t::plain(t::FG),
            ));
            continue;
        }
        if let Some(quoted) = trimmed.strip_prefix("> ") {
            out.push(inline_spans(
                &format!("▌ {quoted}"),
                t::plain(t::DIM).add_modifier(Modifier::ITALIC),
            ));
            continue;
        }
        if trimmed.is_empty() {
            out.push(vec![]);
            continue;
        }
        out.push(inline_spans(line, t::plain(t::FG)));
    }
    out
}

/// Inline markdown: `code` → accent, **bold** → bold. Unclosed markers stay
/// literal (streaming-friendly: partial chunks render as plain text).
fn inline_spans(s: &str, base: Style) -> Vec<Span<'static>> {
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
                out.push(Span::styled(code, t::plain(t::CODE_FG)));
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

    let mut tick = tokio::time::interval(std::time::Duration::from_millis(120));

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
            _ = tick.tick() => {}
        }
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
        ui::draw(&mut terminal, &mut app)?;
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
        Event::Key(k) if k.kind == KeyEventKind::Press => k,
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
        let sel = app.cmd_selected.min(menu.len() - 1);
        match key.code {
            KeyCode::Up => {
                app.cmd_selected = sel.saturating_sub(1);
                return Ok(());
            }
            KeyCode::Down => {
                if sel + 1 < menu.len() {
                    app.cmd_selected = sel + 1;
                }
                return Ok(());
            }
            KeyCode::Tab => {
                if let Some(c) = menu.get(sel) {
                    app.input = c.name.to_string();
                }
                return Ok(());
            }
            KeyCode::Enter => {
                let name = menu[sel].name;
                app.input.clear();
                app.cmd_selected = 0;
                run_command(app, client, name).await;
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
            } else if !app.input.is_empty() {
                app.input.clear();
            } else if app.queue_len() > 0 {
                app.queue.clear();
                app.sysnote("已清空排队消息");
            }
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
                    app.input.clear();
                    run_shell(app, client, cmd.trim().to_string(), send);
                    return Ok(());
                }
            }
            match text.as_str() {
                "/quit" => {
                    app.request_quit();
                    return Ok(());
                }
                "/new" => {
                    app.input.clear();
                    new_session(app, client).await;
                    return Ok(());
                }
                "/list" => {
                    app.input.clear();
                    open_sessions(app, client).await;
                    return Ok(());
                }
                "/model" => {
                    app.input.clear();
                    open_config(app, client, "model", "模型").await;
                    return Ok(());
                }
                "/effort" => {
                    app.input.clear();
                    open_config(app, client, "reasoning_effort", "推理档位").await;
                    return Ok(());
                }
                "/cost" => {
                    app.input.clear();
                    open_info(app, "今日用量与费用", cost_report());
                    return Ok(());
                }
                "/status" => {
                    app.input.clear();
                    open_info(app, "状态", status_lines(app));
                    return Ok(());
                }
                "/web" => {
                    app.input.clear();
                    start_web(client);
                    return Ok(());
                }
                _ => {}
            }
            if app.state == RunState::Busy {
                // dsh allows one in-flight prompt per session; queue instead.
                if let Some(sid) = app.session_id.clone() {
                    note_session_title(&mut app.titles, &sid, &text);
                }
                app.queue.push_back(text.clone());
                app.history.push(text.clone());
                app.hist_cursor = None;
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
            app.history.push(text.clone());
            app.hist_cursor = None;
            app.input.clear();
            app.state = RunState::Busy;
            app.busy_since = Some(Instant::now());
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
async fn run_command(app: &mut App, client: &AcpClient, name: &str) {
    match name {
        "/quit" => app.request_quit(),
        "/new" => new_session(app, client).await,
        "/list" => open_sessions(app, client).await,
        "/model" => open_config(app, client, "model", "模型").await,
        "/effort" => open_config(app, client, "reasoning_effort", "推理档位").await,
        "/cost" => open_info(app, "今日用量与费用", cost_report()),
        "/status" => open_info(app, "状态", status_lines(app)),
        "/web" => start_web(client),
        "/clear" => {
            app.entries.clear();
            app.tool_idx.clear();
            app.tool_meta.clear();
            app.dirty = true;
            app.sysnote("已清屏（会话上下文不受影响）");
        }
        "/help" => {
            let mut lines = vec![
                "斜杠命令".to_string(),
                format!("dsh-tui v{} — ACP v1 客户端（内核 dsh 只读复用）", env!("CARGO_PKG_VERSION")),
                String::new(),
            ];
            for c in COMMANDS {
                lines.push(format!("  {:<8} — {}", c.name, c.desc));
            }
            lines.push(String::new());
            lines.push("在输入框输入 !cmd 执行本地命令（!!cmd 只显示结果，不发给模型）".to_string());
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
            app.entries.clear();
            app.tool_idx.clear();
            app.tool_meta.clear();
            app.usage = None;
            app.scroll_from_bottom = 0;
            app.busy_since = None;
            app.dirty = true;
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
            app.entries.clear();
            app.tool_idx.clear();
            app.tool_meta.clear();
            app.scroll_from_bottom = 0;
            app.usage = None;
            app.busy_since = None;
            app.dirty = true;
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
            c.emit(AcpEvent::Notice(format!("web 已在运行：{url}")));
            return;
        }
        c.emit(AcpEvent::Notice("正在启动 dsh web（后台）…".into()));
        match spawn_web(port) {
            Ok(_) => {
                for i in 0..45u32 {
                    tokio::time::sleep(Duration::from_millis(1000)).await;
                    if tokio::net::TcpStream::connect(&addr).await.is_ok() {
                        c.emit(AcpEvent::Notice(format!(
                            "web 已启动：{url}（浏览器已打开；退出 TUI 不影响 web）"
                        )));
                        return;
                    }
                    if i > 0 && i % 5 == 0 {
                        c.emit(AcpEvent::Notice(format!("等待 web 就绪…（{}s）", i)));
                    }
                }
                c.emit(AcpEvent::Notice(format!(
                    "web 启动超时：{url} 未监听。请手动运行 `dsh web` 查看原因"
                )));
            }
            Err(e) => c.emit(AcpEvent::Notice(format!(
                "启动 dsh web 失败: {e:#}（请手动运行 `dsh web`）"
            ))),
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
            app.append_chunk(EntryKind::Agent, &t);
            false
        }
        AcpEvent::ThoughtChunk(t) => {
            app.append_chunk(EntryKind::Thought, &t);
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
            });
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
                    app.dirty = true;
                }
            }
            false
        }
        AcpEvent::Usage { used, size } => {
            app.usage = Some((used, size));
            false
        }
        AcpEvent::ConfigUpdated(cfg) => {
            if !cfg.is_empty() && catalog_is_richer(&cfg, &app.config) {
                app.config = cfg;
            }
            false
        }
        AcpEvent::PermissionRequest { request_id, tool_title, options } => {
            if matches!(app.dialog, Dialog::None) {
                app.dialog = Dialog::Permission { request_id, tool_title, options, selected: 0 };
            } else {
                app.queued_permissions.push((request_id, tool_title, options));
            }
            false
        }
        AcpEvent::PromptSettled { stop_reason, error } => {
            app.state = RunState::Idle;
            app.busy_since = None;
            match &error {
                Some(err) => app.sysnote(&format!("请求失败: {err}")),
                None if stop_reason == "cancelled" => app.sysnote("已取消"),
                None => app.sysnote(&format!("— 完成（{stop_reason}）—")),
            }
            // Drain the queue: send the next queued message, if any.
            if error.is_none() && !app.queue.is_empty() {
                if let Some(sid) = app.session_id.clone() {
                    let next = app.queue.pop_front().expect("checked non-empty");
                    app.push_entry(EntryKind::User, &next);
                    app.state = RunState::Busy;
                    app.busy_since = Some(Instant::now());
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
                    client.prompt(sid, prompt_text);
                } else {
                    app.sysnote("会话尚未就绪，shell 输出未发送");
                }
            }
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
}