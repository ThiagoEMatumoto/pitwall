import { describe, expect, it } from 'vitest'
import { buildPromptBytes } from './prompt-bytes'

const OPEN = '\x1b[200~'
const CLOSE = '\x1b[201~'

describe('buildPromptBytes', () => {
  it('wraps the text in bracketed-paste markers when bracketed', () => {
    expect(buildPromptBytes('hello', true)).toBe(`${OPEN}hello${CLOSE}`)
  })

  it('returns the bare text when not bracketed', () => {
    expect(buildPromptBytes('hello', false)).toBe('hello')
  })

  it('normalizes \\n and \\r\\n to \\r when bracketed', () => {
    expect(buildPromptBytes('a\nb\r\nc', true)).toBe(`${OPEN}a\rb\rc${CLOSE}`)
  })

  it('normalizes newlines even when not bracketed', () => {
    expect(buildPromptBytes('a\nb', false)).toBe('a\rb')
  })

  it('does not append a trailing carriage return (submit is handled by sendPrompt)', () => {
    expect(buildPromptBytes('hello', true).endsWith('\r')).toBe(false)
    // A trailing newline collapses to a single \r INSIDE the envelope, never after it.
    expect(buildPromptBytes('hello\n', true)).toBe(`${OPEN}hello\r${CLOSE}`)
  })

  it('strips ESC so a pasted end marker cannot close the envelope early', () => {
    const bytes = buildPromptBytes('abc\x1b[201~\r1', true)
    expect(bytes).toBe(`${OPEN}abc[201~\r1${CLOSE}`)
    expect(bytes.match(/\x1b/g)).toHaveLength(2)
    expect(buildPromptBytes('a\x1b[Ab\x9b2~\x03', false)).toBe('a[Ab2~')
  })

  it('keeps tabs inside the paste', () => {
    expect(buildPromptBytes('a\tb', true)).toBe(`${OPEN}a\tb${CLOSE}`)
  })

  it('keeps an empty string as just the envelope (or nothing)', () => {
    expect(buildPromptBytes('', true)).toBe(`${OPEN}${CLOSE}`)
    expect(buildPromptBytes('', false)).toBe('')
  })
})
