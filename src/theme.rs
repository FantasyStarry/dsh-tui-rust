//! Design tokens shared by all rendering. Palette follows the generated
//! mockups (design/01-chat.png, design/02-permission.png): near-black
//! background, sky-blue + soft-violet accents, youthful but trustworthy.
//!
//! The palette is a [`Theme`] with an optional per-user override file at
//! `~/.dsh-tui/theme.json` (pi `themes/*.json`-style): each key maps a token
//! name to a `#RRGGBB` hex color. Unknown keys are ignored; the file is
//! read once at startup.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;

// Default palette (also the Theme::default values).
pub const ACCENT: Color = Color::Rgb(97, 175, 239); // sky blue  #61afef
pub const VIOLET: Color = Color::Rgb(167, 139, 250); // soft violet #a78bfa
pub const OK: Color = Color::Rgb(74, 222, 128); // green
pub const WARN: Color = Color::Rgb(250, 204, 21); // amber
pub const ERR: Color = Color::Rgb(248, 113, 113); // red
pub const FG: Color = Color::Rgb(226, 232, 240); // main text
pub const MUTED: Color = Color::Rgb(148, 163, 184); // hints
pub const DIM: Color = Color::Rgb(100, 116, 139); // thinking / de-emphasis
pub const CODE_FG: Color = Color::Rgb(125, 211, 252); // inline/fenced code
pub const HAIRLINE: Color = Color::Rgb(48, 54, 66); // separators
pub const PILL_BG: Color = Color::Rgb(30, 38, 52); // pill / keycap background
pub const BAR_BG: Color = Color::Rgb(13, 17, 23); // selection bar text

/// Semantic color tokens (pi themes.md-inspired subset). Every render path
/// reads colors from this struct — never from the consts directly — so a
/// user theme override lights up the whole UI.
#[derive(Clone, Debug)]
pub struct Theme {
    pub accent: Color,
    pub violet: Color,
    pub ok: Color,
    pub warn: Color,
    pub err: Color,
    pub fg: Color,
    pub muted: Color,
    pub dim: Color,
    pub code_fg: Color,
    pub hairline: Color,
    pub pill_bg: Color,
    pub bar_bg: Color,
}

impl Default for Theme {
    fn default() -> Self {
        Theme {
            accent: ACCENT,
            violet: VIOLET,
            ok: OK,
            warn: WARN,
            err: ERR,
            fg: FG,
            muted: MUTED,
            dim: DIM,
            code_fg: CODE_FG,
            hairline: HAIRLINE,
            pill_bg: PILL_BG,
            bar_bg: BAR_BG,
        }
    }
}

/// Load the user theme override (`~/.dsh-tui/theme.json`), falling back to
/// the default palette. Format: `{ "accent": "#61afef", "violet": "#a78bfa", … }`
/// with any subset of token names.
pub fn load_theme() -> Theme {
    let mut t = Theme::default();
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok();
    let Some(home) = home else { return t };
    let p = std::path::PathBuf::from(home).join(".dsh-tui").join("theme.json");
    let Ok(txt) = std::fs::read_to_string(&p) else {
        return t;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
        return t;
    };
    let get = |key: &str| {
        v.get(key)
            .and_then(|x| x.as_str())
            .and_then(parse_hex)
    };
    if let Some(c) = get("accent") { t.accent = c; }
    if let Some(c) = get("violet") { t.violet = c; }
    if let Some(c) = get("ok") { t.ok = c; }
    if let Some(c) = get("warn") { t.warn = c; }
    if let Some(c) = get("err") { t.err = c; }
    if let Some(c) = get("fg") { t.fg = c; }
    if let Some(c) = get("muted") { t.muted = c; }
    if let Some(c) = get("dim") { t.dim = c; }
    if let Some(c) = get("codeFg") { t.code_fg = c; }
    if let Some(c) = get("hairline") { t.hairline = c; }
    if let Some(c) = get("pillBg") { t.pill_bg = c; }
    if let Some(c) = get("barBg") { t.bar_bg = c; }
    t
}

fn parse_hex(s: &str) -> Option<Color> {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&s[0..2], 16).ok()?;
    let g = u8::from_str_radix(&s[2..4], 16).ok()?;
    let b = u8::from_str_radix(&s[4..6], 16).ok()?;
    Some(Color::Rgb(r, g, b))
}

pub fn bold(c: Color) -> Style {
    Style::new().fg(c).add_modifier(Modifier::BOLD)
}

pub fn plain(c: Color) -> Style {
    Style::new().fg(c)
}

impl Theme {
    /// Map a tool status word to its status-dot color.
    pub fn status_color(&self, status: &str) -> Color {
        match status {
            "completed" | "success" | "done" | "finished" => self.ok,
            "failed" | "error" | "errored" => self.err,
            "pending" | "running" | "in_progress" | "started" => self.warn,
            _ => self.muted,
        }
    }

    /// Tool status → (Chinese label, color) for the tool-call cards.
    pub fn status_label(&self, status: &str) -> (String, Color) {
        match status {
            "completed" | "success" | "done" | "finished" => ("已完成".to_string(), self.ok),
            "failed" | "error" | "errored" => ("失败".to_string(), self.err),
            "pending" | "running" | "in_progress" | "started" => ("进行中".to_string(), self.warn),
            other => (other.to_string(), self.muted),
        }
    }
}

/// Per-character accent→violet gradient for the wordmark.
pub fn gradient_word(text: &str, from: Color, to: Color) -> Vec<Span<'static>> {
    let n = text.chars().count().saturating_sub(1).max(1);
    text.chars()
        .enumerate()
        .map(|(i, ch)| {
            let t = i as f32 / n as f32;
            let lerp = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t) as u8;
            let (fr, fg, fb) = rgb_of(from);
            let (tr, tg, tb) = rgb_of(to);
            Span::styled(
                ch.to_string(),
                Style::new()
                    .fg(Color::Rgb(lerp(fr, tr), lerp(fg, tg), lerp(fb, tb)))
                    .add_modifier(Modifier::BOLD),
            )
        })
        .collect()
}

fn rgb_of(c: Color) -> (u8, u8, u8) {
    match c {
        Color::Rgb(r, g, b) => (r, g, b),
        _ => (97, 175, 239),
    }
}

/// Segmented context bar: filled part colored by pressure.
pub fn ctx_bar(used: u64, size: u64, cells: usize, th: &Theme) -> Vec<Span<'static>> {
    let pct = if size > 0 { used as f64 / size as f64 } else { 0.0 };
    let filled = ((pct * cells as f64).round() as usize).min(cells);
    let color = if pct >= 0.9 {
        th.err
    } else if pct >= 0.7 {
        th.warn
    } else {
        th.accent
    };
    let mut spans = vec![Span::raw(" ")];
    if filled > 0 {
        spans.push(Span::styled("▰".repeat(filled), plain(color)));
    }
    if filled < cells {
        spans.push(Span::styled("▱".repeat(cells - filled), plain(th.hairline)));
    }
    spans.push(Span::styled(format!(" {:.0}%", pct * 100.0), plain(th.fg)));
    spans
}

/// Keycap + label pair, e.g. `[Esc] 清空`.
pub fn keycap(key: &str, label: &str, th: &Theme) -> Vec<Span<'static>> {
    vec![
        Span::styled(format!(" {key} "), Style::new().bg(th.pill_bg).fg(th.muted)),
        Span::styled(format!(" {label} "), plain(th.muted)),
    ]
}

/// An elevated pill, e.g. the model name.
pub fn pill(text: &str, fg: Color, th: &Theme) -> Span<'static> {
    Span::styled(format!(" {text} "), Style::new().bg(th.pill_bg).fg(fg))
}

pub const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
