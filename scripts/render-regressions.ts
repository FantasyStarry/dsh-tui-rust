import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

import { Channel, type TranscriptRow } from '../src/adapter/channel.js'
import { buildFrame, type FrameContext } from '../src/tui/chat.js'
import { cleanText } from '../src/tui/sanitize.js'
import { stringWidth, wrapWidth } from '../src/tui/width.js'

function context(channel: Channel, overrides: Partial<FrameContext> = {}): FrameContext {
  return {
    channel,
    sealedFrom: 0,
    editorText: '',
    width: 80,
    height: 24,
    cwd: 'C:\\work',
    sessionId: 'session-test',
    route: null,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, messages: 0 },
    now: 1_000,
    picker: null,
    fullscreen: true,
    ...overrides,
  }
}

function visible(lines: readonly string[]): string {
  return cleanText(lines.join('\n'))
}

// External data becomes plain text before Orca adds its own SGR. Complete
// sequences preserve following text; unterminated strings consume the tail.
assert.equal(cleanText('a\x1b[31mred\x1b[0mz'), 'aredz')
assert.equal(cleanText('a\x1b]52;c;secret\x07z'), 'az')
assert.equal(cleanText('a\x1bPpayload\x1b\\z'), 'az')
assert.equal(cleanText('a\u009b2Jz'), 'az')
assert.equal(cleanText('a\u009dtitle\u009cz'), 'az')
assert.equal(cleanText('safe\x1b[31'), 'safe')
assert.equal(cleanText('safe\x1b]52;c;payload'), 'safe')
assert.equal(cleanText('a\r\b\tb\nline'), 'a b\nline')

const wrapped = wrapWidth('a abcdefghij', 5)
assert.deepEqual(wrapped, ['a ', 'abcde', 'fghij'])
assert.ok(wrapped.every((line) => stringWidth(line) <= 5))
assert.equal(wrapped.join('').replaceAll(' ', ''), 'aabcdefghij')

const hostile = new Channel()
hostile.rows.push(
  { id: 1, kind: 'user', text: 'user\x1b[2J still', seq: 1 },
  { id: 2, kind: 'assistant', text: 'answer\x1b]0;owned\x07 suffix', seq: 2 },
  { id: 3, kind: 'tool', tool: 'tool\x1bPbad\x1b\\', text: 'result\u009b2J ok', status: 'ok', seq: 3 },
  { id: 4, kind: 'system', text: 'partial\x1b]52;c;payload', seq: 4 },
)
hostile.sealedRowCount = hostile.rows.length
const hostileFrame = buildFrame(context(hostile, {
  editorText: 'edit\x1b[31m red',
  attachments: ['image\x1b]0;bad\x07.png'],
  route: { provider: 'provider\x1b[2J', model: 'model\x1b]0;x\x07' },
  title: 'title\x1bPbad\x1b\\',
}))
const hostileOutput = [...hostileFrame.stream, ...hostileFrame.live].join('\n')
assert.ok(!hostileOutput.includes('\x1b[2J'))
assert.ok(!hostileOutput.includes('\x1b]'))
assert.ok(!hostileOutput.includes('\x1bP'))
assert.ok(!hostileOutput.includes('\u009b'))
assert.match(visible(hostileFrame.live), /answer suffix/)
assert.doesNotMatch(visible(hostileFrame.live), /owned|secret|payload/)

const cursorChannel = new Channel()
const cursorFrame = buildFrame(context(cursorChannel, {
  editorText: 'hello',
  editorCursor: 2,
  attachments: ['first.png', 'second.png'],
}))
assert.equal(cursorFrame.live.length, 24)
assert.equal(cursorFrame.cursor.fromEnd, 3)
assert.equal(cursorFrame.cursor.col, 10)
const cursorRow = cursorFrame.live.length - 1 - cursorFrame.cursor.fromEnd
assert.match(visible([cursorFrame.live[cursorRow] ?? '']), /> he/)

const narrowCursor = buildFrame(context(cursorChannel, { editorText: 'x'.repeat(200), width: 20 }))
assert.equal(narrowCursor.cursor.col, 19)

// The open row changes in place without touching seq. The next frame must
// invalidate that row while reusing the immutable prefix.
const mutable = new Channel()
mutable.rows.push({ id: 1, kind: 'system', text: 'sealed', seq: 1 })
const open: TranscriptRow = { id: 2, kind: 'assistant', text: 'first', seq: 2 }
mutable.rows.push(open)
mutable.sealedRowCount = 1
buildFrame(context(mutable))
open.text = 'first suffix'
const changed = buildFrame(context(mutable))
assert.match(visible(changed.live), /first suffix/)
mutable.rows.splice(0, mutable.rows.length, { id: 3, kind: 'system', text: 'new session projection', seq: 3 })
mutable.sealedRowCount = 1
const reset = buildFrame(context(mutable))
assert.match(visible(reset.live), /new session projection/)
assert.doesNotMatch(visible(reset.live), /first suffix/)

// Benchmark the path that previously formatted and flattened every historical
// row per tick. The warm frame should only inspect the live boundary and copy
// the visible tail; keep the threshold loose enough for shared CI machines.
const history = new Channel()
for (let i = 0; i < 4_000; i++) {
  history.rows.push({
    id: i + 1,
    kind: 'assistant',
    text: `**row ${i}** with a long markdown body and inline \`code\` for wrapping`,
    seq: i + 1,
  })
}
history.sealedRowCount = history.rows.length
const historyContext = context(history)
const coldStart = performance.now()
const coldFrame = buildFrame(historyContext)
const coldMs = performance.now() - coldStart
const warmStart = performance.now()
const warmFrame = buildFrame(historyContext)
const warmMs = performance.now() - warmStart
assert.deepEqual(warmFrame, coldFrame)
assert.ok(warmMs < coldMs * 0.5, `cached frame ${warmMs.toFixed(2)}ms vs cold ${coldMs.toFixed(2)}ms`)

process.stderr.write(`render regressions passed; fullscreen cache cold=${coldMs.toFixed(2)}ms warm=${warmMs.toFixed(2)}ms\n`)
