import { afterEach, describe, expect, it } from 'vitest'
import { attentionKeyAction, attentionKeysBlocked } from './attention-keys'

const ev = (over: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  }) as KeyboardEvent

describe('attentionKeyAction', () => {
  it('Alt+A / Alt+Shift+A / Alt+Q fora do Design', () => {
    expect(attentionKeyAction(ev({ key: 'a', code: 'KeyA', altKey: true }), {}, 'projects')).toBe(
      'next',
    )
    expect(
      attentionKeyAction(ev({ key: 'A', code: 'KeyA', altKey: true, shiftKey: true }), {}, 'home'),
    ).toBe('prev')
    expect(attentionKeyAction(ev({ key: 'q', code: 'KeyQ', altKey: true }), {}, 'projects')).toBe(
      'back',
    )
  })

  it('casa pela tecla física: Option+A do mac (å) e layout russo (ф)', () => {
    expect(attentionKeyAction(ev({ key: 'å', code: 'KeyA', altKey: true }), {}, 'projects')).toBe(
      'next',
    )
    expect(attentionKeyAction(ev({ key: 'ф', code: 'KeyA', altKey: true }), {}, 'projects')).toBe(
      'next',
    )
    expect(attentionKeyAction(ev({ key: 'œ', code: 'KeyQ', altKey: true }), {}, 'projects')).toBe(
      'back',
    )
  })

  it('na área de Design cede a tecla ao canvas (Alt+A = Alinhar à esquerda)', () => {
    expect(
      attentionKeyAction(ev({ key: 'a', code: 'KeyA', altKey: true }), {}, 'design'),
    ).toBeNull()
    expect(
      attentionKeyAction(ev({ key: 'q', code: 'KeyQ', altKey: true }), {}, 'design'),
    ).toBeNull()
  })

  it('respeita override do usuário', () => {
    const overrides = { 'attention.next': { mod: true, key: 'y' } }
    expect(
      attentionKeyAction(ev({ key: 'a', code: 'KeyA', altKey: true }), overrides, 'projects'),
    ).toBeNull()
    expect(
      attentionKeyAction(ev({ key: 'y', code: 'KeyY', ctrlKey: true }), overrides, 'projects'),
    ).toBe('next')
  })
})

describe('formatCombo com code de letra', () => {
  it('mostra a letra, não o code', async () => {
    const { formatCombo } = await import('@/lib/keybindings')
    expect(formatCombo({ alt: true, code: 'KeyA' })).toMatch(/A$/)
    expect(formatCombo({ alt: true, code: 'KeyA' })).not.toMatch(/Key/)
  })
})

describe('attentionKeysBlocked', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const mount = (html: string) => {
    document.body.innerHTML = html
  }

  it('livre sem overlay', () => {
    mount('<main><div class="dv-tab">aba</div></main>')
    expect(attentionKeysBlocked()).toBe(false)
  })

  it('bloqueia com Dialog/palette/switcher/nova sessão abertos', () => {
    mount('<div data-modal-overlay><div>Settings</div></div>')
    expect(attentionKeysBlocked()).toBe(true)
  })

  it('bloqueia com qualquer diálogo modal que não seja o peek', () => {
    mount('<div role="dialog" aria-modal="true">x</div>')
    expect(attentionKeysBlocked()).toBe(true)
  })

  it('bloqueia enquanto o gravador de atalho captura', () => {
    mount('<button data-keybinding-capture>Pressione…</button>')
    expect(attentionKeysBlocked()).toBe(true)
  })

  it('o quick look da crew não bloqueia: o próprio ciclo abre e fecha o peek', () => {
    mount('<div role="dialog" aria-modal="true" data-peek-mode="view">peek</div>')
    expect(attentionKeysBlocked()).toBe(false)
  })
})
