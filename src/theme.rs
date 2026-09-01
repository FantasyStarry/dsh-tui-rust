//! Design tokens shared by all rendering. Palette follows the generated
//! mockups (design/01-chat.png, design/02-permission.png): near-black
//! background, sky-blue + soft-violet accents, youthful but trustworthy.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;

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

pub fn bold(c: Color) -> Style {
    Style::new().fg(c).add_modifier(Modifier::BOLD)
}

pub fn plain(c: Color) -> Style {
    Style::new().fg(c)
}

/// Map a tool status word to its status-dot color.
pub fn status_color(status: &str) -> Color {
    match status {
        "completed" | "success" | "done" | "finished" => OK,
        "failed" | "error" | "errored" => ERR,
        "pending" | "running" | "in_progress" | "started" => WARN,
        _ => MUTED,
    }
}

/// Tool status → (Chinese label, color) for the tool-call cards.
pub fn status_label(status: &str) -> (String, Color) {
    match status {
        "completed" | "success" | "done" | "finished" => ("已完成".to_string(), OK),
        "failed" | "error" | "errored" => ("失败".to_string(), ERR),
        "pending" | "running" | "in_progress" | "started" => ("进行中".to_string(), WARN),
        other => (other.to_string(), MUTED),
    }
}

/// Per-character accent→violet gradient for the wordmark.
pub fn gradient_word(text: &str) -> Vec<Span<'static>> {
    let n = text.chars().count().saturating_sub(1).max(1);
    text.chars()
        .enumerate()
        .map(|(i, ch)| {
            let t = i as f32 / n as f32;
            let r = 97.0 + (167.0 - 97.0) * t;
            let g = 175.0 + (139.0 - 175.0) * t;
            let b = 239.0 + (250.0 - 239.0) * t;
            Span::styled(
                ch.to_string(),
                Style::new().fg(Color::Rgb(r as u8, g as u8, b as u8)).add_modifier(Modifier::BOLD),
            )
        })
        .collect()
}

/// Segmented context bar: filled part colored by pressure.
pub fn ctx_bar(used: u64, size: u64, cells: usize) -> Vec<Span<'static>> {
    let pct = if size > 0 { used as f64 / size as f64 } else { 0.0 };
    let filled = ((pct * cells as f64).round() as usize).min(cells);
    let color = if pct >= 0.9 {
        ERR
    } else if pct >= 0.7 {
        WARN
    } else {
        ACCENT
    };
    let mut spans = vec![Span::raw(" ")];
    if filled > 0 {
        spans.push(Span::styled("▰".repeat(filled), plain(color)));
    }
    if filled < cells {
        spans.push(Span::styled("▱".repeat(cells - filled), plain(HAIRLINE)));
    }
    spans.push(Span::styled(format!(" {:.0}%", pct * 100.0), plain(FG)));
    spans
}

/// Keycap + label pair, e.g. `[Esc] 清空`.
pub fn keycap(key: &str, label: &str) -> Vec<Span<'static>> {
    vec![
        Span::styled(format!(" {key} "), Style::new().bg(PILL_BG).fg(MUTED)),
        Span::styled(format!(" {label} "), plain(MUTED)),
    ]
}

/// An elevated pill, e.g. the model name.
pub fn pill(text: &str, fg: Color) -> Span<'static> {
    Span::styled(format!(" {text} "), Style::new().bg(PILL_BG).fg(fg))
}

pub const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
