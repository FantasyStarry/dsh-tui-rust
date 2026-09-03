/**
 * PTY probe: boots the real orca profile in a ConPTY and drives the exact
 * user-reported repro (model switch + `/` menu) while interpreting the ANSI
 * stream with a minimal terminal emulator (grid + cursor + scroll). After
 * every step it snapshots the visible screen and asserts the input box is
 * intact and the cursor sits inside it.
 *
 * Zero API cost: no prompt is ever submitted to the model.
 *
 * Usage: node scripts/probe-pty.mjs [--dump]   (exit 0 = pass, 1 = fail)
 */

import { createRequire } from 'node:module'
import { writeFileSync, readFileSync } from 'node:fs'

const DSH_PKG = 'C:/Users/Mayn/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json'
const DSH_BIN = 'C:/Users/Mayn/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js'
const CWD = process.env['ORCA_E2E_CWD'] ?? 'C:/Users/Mayn/Desktop/File_Manager_Legacy'
const COLS = 110
const ROWS = 45
const STEP_TIMEOUT_MS = 30_000
const GLOBAL_TIMEOUT_MS = 150_000
const DUMP = process.argv.includes('--dump')

const require = createRequire(DSH_PKG)
const pty = require('node-pty')

// ── mini terminal emulator ───────────────────────────────────────────────────

/** Mirror of src/tui/width.ts policy: CJK + …/⋯ are double-cell. */
function isWide(code) {
  if (code === 0x2026 || code === 0x22ef) return true
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

class Screen {
  constructor(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.grid = []
    for (let r = 0; r < rows; r++) this.grid.push(new Array(cols).fill(' '))
    this.cx = 0
    this.cy = 0
    // Escape sequences may split across ConPTY chunks — buffer until each
    // one is complete before interpreting (same design as the app's parser).
    this.buf = ''
  }

  text(row) {
    return (this.grid[row] ?? []).join('').replaceAll('\x00', '').replace(/\s+$/, '')
  }

  plain() {
    return this.grid.map((_, r) => this.text(r)).join('\n')
  }

  feed(data) {
    this.buf += data
    this.consume()
  }

  consume() {
    for (;;) {
      if (this.buf === '') return
      const ch = this.buf[0]
      if (ch === '\x1b') {
        const csi = /^\x1b\[([0-9;:?<>=]*)([A-Za-z~])/.exec(this.buf)
        if (csi) {
          this.buf = this.buf.slice(csi[0].length)
          this.csi(csi[1], csi[2])
          continue
        }
        const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(this.buf)
        if (osc) {
          this.buf = this.buf.slice(osc[0].length)
          continue
        }
        // Incomplete escape (lone ESC, partial CSI/OSC) — wait for more data.
        if (/^\x1b(\[[0-9;:?<>=]*|\][^\x07\x1b]*)?$/.test(this.buf)) return
        this.buf = this.buf.slice(2) // unknown 2-char escape — drop
        continue
      }
      const next = this.buf.indexOf('\x1b', 1)
      const run = next === -1 ? this.buf : this.buf.slice(0, next)
      this.buf = next === -1 ? '' : this.buf.slice(next)
      for (const c of run) this.handleChar(c)
    }
  }

  handleChar(c) {
    if (c === '\r') {
      this.cx = 0
    } else if (c === '\n') {
      this.lineFeed()
    } else if (c === '\b') {
      if (this.cx > 0) this.cx--
    } else if (c === '\t') {
      this.cx = Math.min(this.cols - 1, (Math.floor(this.cx / 8) + 1) * 8)
    } else if (c < ' ') {
      // other control — ignore
    } else {
      this.put(c)
    }
  }

  put(ch) {
    if (this.cx >= this.cols) {
      this.cx = 0
      this.lineFeed()
    }
    const row = this.grid[this.cy]
    if (row) row[this.cx] = ch
    this.cx++
    if (isWide(ch.codePointAt(0))) {
      // Wide glyph: the follower cell is claimed by an invisible filler so
      // column math matches what a real CJK terminal shows.
      if (this.cx >= this.cols) {
        this.cx = 0
        this.lineFeed()
      }
      if (row && this.cy === this.grid.indexOf(row)) row[this.cx] = '\x00'
      this.cx++
    }
  }

  lineFeed() {
    if (this.cy >= this.rows - 1) {
      this.grid.shift()
      this.grid.push(new Array(this.cols).fill(' '))
    } else {
      this.cy++
    }
  }

  csi(params, final) {
    const nums = params
      .split(';')
      .map((p) => (p === '' || p === '?' ? 0 : parseInt(p, 10) || 0))
    const n = nums[0] ?? 0
    switch (final) {
      case 'A':
        this.cy = Math.max(0, this.cy - Math.max(1, n))
        break
      case 'B':
        this.cy = Math.min(this.rows - 1, this.cy + Math.max(1, n))
        break
      case 'C':
        this.cx = Math.min(this.cols - 1, this.cx + Math.max(1, n))
        break
      case 'D':
        this.cx = Math.max(0, this.cx - Math.max(1, n))
        break
      case 'G':
        this.cx = Math.max(0, Math.min(this.cols - 1, n - 1))
        break
      case 'H':
      case 'f': {
        const row = (nums[0] || 1) - 1
        const col = (nums[1] || 1) - 1
        this.cy = Math.max(0, Math.min(this.rows - 1, row))
        this.cx = Math.max(0, Math.min(this.cols - 1, col))
        break
      }
      case 'J':
        if (n === 0) {
          const row = this.grid[this.cy]
          if (row) row.fill(' ', this.cx)
          for (let r = this.cy + 1; r < this.rows; r++) this.grid[r].fill(' ')
        } else if (n === 2) {
          for (const row of this.grid) row.fill(' ')
        }
        break
      case 'K': {
        const row = this.grid[this.cy]
        if (!row) break
        if (n === 0) row.fill(' ', this.cx)
        else row.fill(' ')
        break
      }
      default:
        break // ?2026 sync, SGR 'm', etc. — ignored
    }
  }
}

// ── driver ───────────────────────────────────────────────────────────────────

// Replay mode: feed recorded app-level writes (an ORCA_LOG file) through the
// emulator offline and print the resulting screen + cursor. Diagnostic for
// frame-geometry regressions without booting the kernel.
const replayFile = process.env['PROBE_REPLAY']
if (replayFile) {
  const log = readFileSync(replayFile, 'utf8')
  const bodies = [...log.matchAll(/^--- boot#\d+ write#\d+ [^\n]*---\n([\s\S]*?)\n(?=--- boot#|\n?$)/gm)].map((m) => m[1])
  const screen = new Screen(COLS, ROWS)
  for (const body of bodies) {
    const before = `${screen.cy},${screen.cx}`
    screen.feed(body)
    console.error(`write rows=${bodies.indexOf(body)} cursor ${before} -> ${screen.cy},${screen.cx}`)
  }
  console.log(screen.plain())
  process.exit(0)
}

// Assertions run against the APP-level byte stream (ORCA_LOG), not ConPTY's
// re-rendering: ConPTY rewrites cursor motion and reflows rows with its own
// width policy, which is un-emulatable noise. The app stream is the contract
// Orca owns — if the app-level grid is correct, any conforming terminal
// (including ConPTY with matching width tables) renders it correctly.
const APP_LOG = 'C:/Users/Mayn/Desktop/dsh-orca/probe-orca-app.log'
try {
  writeFileSync(APP_LOG, '')
} catch {}

const screen = new Screen(COLS, ROWS)
let raw = ''
let logOffset = 0
let logTail = ''
const SEG_RE = /--- boot#\d+ write#\d+ [^\n]*---\n/

let lastGrow = 0

/** Poll the app log and feed newly completed writes into the app screen. */
function pollAppLog() {
  let text
  try {
    text = readFileSync(APP_LOG, 'utf8')
  } catch {
    return
  }
  if (text.length <= logOffset) {
    // Quiet file: the LAST write never gets a successor header, so flush a
    // pending body once the log has been still for a moment.
    if (logTail && Date.now() - lastGrow > 100 && SEG_RE.test(logTail)) {
      const head = SEG_RE.exec(logTail)
      const body = logTail.slice(head.index + head[0].length)
      logTail = ''
      // Strip the log wrapper's trailing newline — it is metadata, not bytes
      // the app wrote to the terminal.
      screen.feed(body.endsWith('\n') ? body.slice(0, -1) : body)
    }
    return
  }
  lastGrow = Date.now()
  const fresh = text.slice(logOffset)
  logOffset = text.length
  logTail += fresh
  for (;;) {
    const head = SEG_RE.exec(logTail)
    if (!head) break
    const bodyStart = head.index + head[0].length
    const next = SEG_RE.exec(logTail.slice(bodyStart))
    if (!next) break // body not complete yet
    const body = logTail.slice(bodyStart, bodyStart + next.index)
    logTail = logTail.slice(bodyStart + next.index)
    screen.feed(body.endsWith('\n') ? body.slice(0, -1) : body)
  }
}

const proc = pty.spawn(process.execPath, [DSH_BIN, '--profile', 'orca'], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: CWD,
  env: { ...process.env, ORCA_LOG: APP_LOG },
})
proc.onData((data) => {
  raw += data
})
proc.onExit(({ exitCode }) => {
  raw += `\n\n<<< PROCESS EXITED code=${exitCode} >>>`
})

const fail = (message) => {
  console.error(`probe 失败：${message}`)
  try {
    pollAppLog()
    writeFileSync('C:/Users/Mayn/Desktop/dsh-orca/probe-last-screen.txt', screen.plain())
    writeFileSync('C:/Users/Mayn/Desktop/dsh-orca/probe-last-raw.log', raw)
    console.error('最终屏幕已写入 probe-last-screen.txt；原始字节已写入 probe-last-raw.log')
  } catch {}
  try {
    proc.kill()
  } catch {}
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitMarker(name, regex, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      pollAppLog()
      if (regex.test(screen.plain())) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`等待「${name}」超时`))
      }
    }, 100)
  })
}

/**
 * Wait out the app's render tick, then poll twice: the first poll feeds
 * complete segments, the second (after a quiet window) flushes the LAST
 * write's body — it never gets a successor header in the log.
 */
async function settle(ms = 220) {
  await sleep(ms)
  pollAppLog()
  await sleep(160)
  pollAppLog()
}

/** Bottom-anchored input box check: exactly one editor line, cursor inside. */
function assertInputBox(step, expectedEditor = null) {
  pollAppLog()
  const lines = []
  for (let r = 0; r < ROWS; r++) lines.push(screen.text(r))
  const editorRows = []
  for (let r = 0; r < ROWS; r++) {
    if (/^│ > /.test(lines[r]) || (lines[r].startsWith('│ >') && expectedEditor === '')) editorRows.push(r)
  }
  // Placeholder variant: `│ > 说点什么…` also matches `│ > `.
  if (editorRows.length !== 1) {
    fail(`[${step}] 输入框内容行数量异常：${editorRows.length}（行号 ${editorRows.join(',')}）\n${screen.plain()}`)
  }
  const editorRow = editorRows[0]
  // Cursor must sit on the editor row, right of the text.
  if (screen.cy !== editorRow) {
    fail(`[${step}] 光标不在输入框行：cursor=(${screen.cy},${screen.cx}) editor 行=${editorRow}\n${screen.plain()}`)
  }
  if (expectedEditor !== null) {
    const raw = lines[editorRow] ?? ''
    const m = /^│ > (.*?) *│ *$/.exec(raw)
    const shown = m ? m[1] : raw.replace(/^│ > /, '').replace(/ *│ *$/, '').replace(/ +$/, '')
    if (expectedEditor !== '' && !shown.startsWith(expectedEditor)) {
      fail(`[${step}] 输入框内容不符：期望以「${expectedEditor}」开头，实际「${shown}」`)
    }
    if (expectedEditor === '' && shown !== '' && shown !== '说点什么…') {
      fail(`[${step}] 输入框应为空/占位符，实际「${shown}」`)
    }
  }
  if (DUMP) console.log(`--- ${step} (cursor=${screen.cy},${screen.cx}) ---\n${screen.plain()}\n`)
}

try {
  const globalTimer = setTimeout(() => {
    if (!globalTimer.settled) fail(`全局超时 ${GLOBAL_TIMEOUT_MS}ms`)
  }, GLOBAL_TIMEOUT_MS)
  const markSettled = () => {
    globalTimer.settled = true
    clearTimeout(globalTimer)
  }

  await waitMarker('TUI 启动', /DeepSeek Harness 终端前端/)
  await waitMarker('session 已连接', /session 已连接：session-[0-9a-f-]+/)
  await settle()
  assertInputBox('启动')

  // ── step 1: `/` menu shows and dismisses without breaking the editor ──
  proc.write('/')
  await waitMarker('/ 菜单出现', /命令/)
  await settle()
  assertInputBox('输入 /', '/')
  proc.write('\x1b[B') // ↓ cycle menu
  await sleep(150)
  proc.write('\x1b') // Esc dismiss menu (also clears editor)
  await settle()
  assertInputBox('Esc 关菜单后', '')

  // ── step 2: /model picker full flow ──
  proc.write('/model')
  await waitMarker('菜单补全提示', /切换模型/)
  proc.write('\r')
  await waitMarker('选择 Provider', /选择 Provider/)
  await settle()
  // Pick the provider of the live route (first listed usually) — just take item 1.
  proc.write('\r')
  await waitMarker('选择模型', /选择模型（/)
  await settle(400)
  proc.write('\r') // first model
  await waitMarker('选择思考强度', /选择思考强度（/)
  await waitMarker('思考档位加载完成', /默认（模型默认行为）/)
  await settle(120)
  proc.write('\r') // 默认
  await settle(200)
  await waitMarker('模型已切换', /模型已切换：/)
  await settle()
  assertInputBox('模型切换完成后', '')

  // ── step 3: reopen the / menu mid-conversation, then Esc ──
  proc.write('/')
  await waitMarker('/ 菜单再次出现', /命令/)
  await settle()
  assertInputBox('对话后输入 /', '/')
  proc.write('\x1b')
  await settle()
  assertInputBox('二次 Esc 后', '')

  // ── step 4: CJK typing keeps the cursor math honest ──
  proc.write('你好orca')
  await settle()
  assertInputBox('中文输入', '你好orca')
  proc.write('\x1b') // clear editor
  await settle()
  assertInputBox('清空后', '')

  // ── step 5: reopen /model, abort mid-flow with Esc, editor must recover ──
  proc.write('/model\r')
  await waitMarker('选择 Provider 2', /选择 Provider/)
  await settle(300)
  proc.write('\x1b')
  await settle()
  assertInputBox('picker 中途 Esc', '')

  markSettled()
  proc.write('\x03')
  await sleep(500)
  try {
    proc.kill()
  } catch {}
  console.log('probe 通过 ✔（输入框在菜单/模型切换全流程后保持正确）')
  process.exit(0)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
