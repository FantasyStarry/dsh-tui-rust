/**
 * Raw-mode keyboard input. Uses node:readline keypress events (works on
 * Windows ConPTY without extra native deps). The skeleton parses the keys
 * the editor needs; Kitty keyboard protocol and mouse events are roadmap
 * items (see docs/adr/0001).
 */

import { emitKeypressEvents } from 'node:readline'

export interface KeyPress {
  /** Printable character for text keys, else the named key. */
  readonly name: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly sequence: string
}

export type KeyHandler = (key: KeyPress) => void

export class Keyboard {
  private readonly handler: KeyHandler
  private active = false

  constructor(
    private readonly stdin: NodeJS.ReadStream,
    handler: KeyHandler,
  ) {
    this.handler = handler
  }

  start(): void {
    if (this.active || !this.stdin.isTTY) return
    emitKeypressEvents(this.stdin)
    this.stdin.setRawMode(true)
    this.stdin.resume()
    this.stdin.on('keypress', this.onKeypress)
    this.active = true
  }

  stop(): void {
    if (!this.active) return
    this.stdin.removeListener('keypress', this.onKeypress)
    this.stdin.setRawMode(false)
    this.stdin.pause()
    this.active = false
  }

  private readonly onKeypress = (ch: string, key?: { name?: string; ctrl?: boolean; alt?: boolean; shift?: boolean; sequence?: string }): void => {
    if (!key) return
    this.handler({
      name: key.name ?? ch,
      ctrl: key.ctrl ?? false,
      alt: key.alt ?? false,
      shift: key.shift ?? false,
      sequence: key.sequence ?? ch,
    })
  }
}

/** Submit / cancel / text-entry classification used by the editor. */
export function classify(key: KeyPress): 'submit' | 'cancel' | 'exit' | 'backspace' | 'navigate' | 'text' | 'ignore' {
  if (key.ctrl && key.name === 'c') return 'exit'
  if (key.ctrl && key.name === 'd') return 'exit'
  if (key.name === 'escape') return 'cancel'
  if (key.name === 'return' && !key.ctrl && !key.alt) return 'submit'
  if (key.name === 'backspace') return 'backspace'
  // Navigation keys carry escape sequences as their `sequence`; inserting
  // them into the editor would smear raw CSI garbage into the prompt line.
  // Proper cursor movement is a later milestone — for now they no-op.
  if (['up', 'down', 'left', 'right', 'home', 'end', 'delete', 'pageup', 'pagedown', 'insert'].includes(key.name)) {
    return 'navigate'
  }
  if (!key.ctrl && !key.alt && key.sequence.length > 0 && key.sequence.codePointAt(0)! >= 0x20) {
    return 'text'
  }
  return 'ignore'
}
