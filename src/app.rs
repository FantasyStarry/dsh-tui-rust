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

use crate::acp::{short_id, AcpClient, AcpEvent, ListedSession, PermOption};
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
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Booting,
    Idle,
    Busy,
}

pub struct App {
    pub entries: Vec<Entry>,
    pub input: String,
    pub scroll_from_bottom: u16,
    pub dialog: Dialog,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub usage: Option<(u64, u64)>,
    pub state: RunState,
    pub fatal: Option<String>,
    /// When the in-flight prompt started (drives the elapsed timer + spinner).
    pub busy_since: Option<Instant>,
    /// Flattened, wrapped display lines (rebuilt lazily on change/resize).
    pub display: Vec<Vec<Span<'static>>>,

    quit: bool,

    history: Vec<String>,
    hist_cursor: Option<usize>,
    queued_permissions: Vec<(Value, String, Vec<PermOption>)>,
    tool_idx: HashMap<String, usize>,
    tool_meta: HashMap<String, ToolMeta>,
    debug_log: VecDeque<String>,
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
            model: None,
            usage: None,
            state: RunState::Booting,
            fatal: None,
            busy_since: Some(Instant::now()),
            display: Vec::new(),
            quit: false,
            history: Vec::new(),
            hist_cursor: None,
            queued_permissions: Vec::new(),
            tool_idx: HashMap::new(),
            tool_meta: HashMap::new(),
            debug_log: VecDeque::new(),
            cwd,
            dirty: true,
            last_width: 0,
        };
        app.sysnote("dsh-tui v0.1.0 — 正在连接 dsh 内核…");
        app
    }

    fn sysnote(&mut self, msg: &str) {
        self.push_entry(EntryKind::System, msg);
    }

    fn push_entry(&mut self, kind: EntryKind, text: &str) {
        self.entries.push(Entry { kind, text: text.to_string(), status: None });
        self.dirty = true;
    }

    fn append_chunk(&mut self, kind: EntryKind, text: &str) {
        match self.entries.last_mut() {
            Some(e) if e.kind == kind => e.text.push_str(text),
            _ => self.entries.push(Entry { kind, text: text.to_string(), status: None }),
        }
        self.dirty = true;
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
    /// before a user turn) are inserted here too.
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
                    let spans = vec![
                        Span::styled("❯ ".to_string(), t::bold(t::ACCENT)),
                        Span::styled(e.text.clone(), t::bold(t::FG)),
                    ];
                    push_wrapped(&mut out, &spans, "  ", t::bold(t::FG), w);
                }
                EntryKind::Agent => {
                    seen_content = true;
                    let spans = vec![Span::styled(e.text.clone(), t::plain(t::FG))];
                    push_wrapped(&mut out, &spans, "  ", t::plain(t::FG), w);
                }
                EntryKind::Thought => {
                    let spans = vec![Span::styled(
                        e.text.clone(),
                        t::plain(t::DIM).add_modifier(Modifier::ITALIC),
                    )];
                    push_wrapped(&mut out, &spans, "✻ ", t::plain(t::DIM), w);
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
                }
                EntryKind::System => {
                    let spans = vec![Span::styled(e.text.clone(), t::plain(t::DIM))];
                    push_wrapped(&mut out, &spans, "· ", t::plain(t::DIM), w);
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
                Ok(sid) => client2.emit(AcpEvent::SessionCreated { session_id: sid }),
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
                    if handle_acp(&mut app, ev) {
                        break;
                    }
                }
                None => break,
            },
            _ = tick.tick() => {}
        }
        if app.quit_requested() {
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

    // --- main mode ----------------------------------------------------------
    match key.code {
        KeyCode::Char('l') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            open_sessions(app, client).await;
        }
        KeyCode::Char('n') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            new_session(app, client).await;
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
            }
        }
        KeyCode::Enter => {
            let text = app.input.trim().to_string();
            if text.is_empty() {
                return Ok(());
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
                _ => {}
            }
            if app.state == RunState::Busy {
                app.sysnote("请等待当前任务完成，或按 Esc 取消");
                return Ok(());
            }
            let Some(sid) = app.session_id.clone() else {
                app.sysnote("会话尚未就绪，请稍候…");
                return Ok(());
            };
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

async fn new_session(app: &mut App, client: &AcpClient) {
    if app.state == RunState::Busy {
        app.sysnote("任务运行中，无法新建会话");
        return;
    }
    app.sysnote("正在创建新会话…");
    let old = app.session_id.clone();
    match client.new_session(&app.cwd).await {
        Ok(sid) => {
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

fn advance_permission_queue(app: &mut App) {
    if !app.queued_permissions.is_empty() {
        let (request_id, tool_title, options) = app.queued_permissions.remove(0);
        app.dialog = Dialog::Permission { request_id, tool_title, options, selected: 0 };
    }
}

// ---------------------------------------------------------------------------
// ACP event handling — returns true when the loop should exit
// ---------------------------------------------------------------------------

fn handle_acp(app: &mut App, ev: AcpEvent) -> bool {
    match ev {
        AcpEvent::SessionCreated { session_id } => {
            app.session_id = Some(session_id.clone());
            app.busy_since = None;
            if app.state == RunState::Booting {
                app.state = RunState::Idle;
            }
            app.sysnote(&format!("会话就绪 {}", short_id(&session_id)));
            app.sysnote("输入消息后回车发送 · /list 会话 · /new 新建 · Ctrl+C 退出");
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
        AcpEvent::ToolCall { tool_call_id, title, kind, status } => {
            let text = if kind.is_empty() {
                title.clone()
            } else {
                format!("{title} [{kind}]")
            };
            app.entries.push(Entry { kind: EntryKind::Tool, text, status: Some(status.clone()) });
            app.tool_idx.insert(tool_call_id.clone(), app.entries.len() - 1);
            app.tool_meta.insert(tool_call_id, ToolMeta { title, kind, status });
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
        AcpEvent::ModelChanged(m) => {
            if m.is_some() {
                app.model = m;
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
            if let Some(err) = error {
                app.sysnote(&format!("请求失败: {err}"));
            } else if stop_reason == "cancelled" {
                app.sysnote("已取消");
            } else {
                app.sysnote(&format!("— 完成（{stop_reason}）—"));
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