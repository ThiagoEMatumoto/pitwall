import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import xtermHeadless from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { gateMenuByStatus, menuFingerprint, parseTuiMenu, parseTuiMenuFull, type TuiMenu } from './tui-menu-parser'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

// Capturas reais (e2e/scenarios/probe-chat-plan-2317.ts, PTY 120x45) do claude 2.1.317 e
// 2.1.318 — o 2.1.318 desenha as mesmas telas. O .ansi só traz a tela inteira no 1º dump
// de cada sessão; os seguintes são lidos pelo .txt.
function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `claude-${name}`), 'utf8')
}
const txt = (name: string) => parseTuiMenu(fixture(`${name}.txt`))

async function parseAnsi(name: string): Promise<TuiMenu | null> {
  const term = new Terminal({ cols: 120, rows: 45, allowProposedApi: true, scrollback: 2000 })
  await new Promise<void>((resolve) => term.write(fixture(`${name}.ansi`), resolve))
  const readTail = (n: number) => {
    const buf = term.buffer.active
    let text = ''
    for (let y = Math.max(0, buf.length - n); y < buf.length; y++)
      text += (buf.getLine(y)?.translateToString(true) ?? '') + '\n'
    return text
  }
  return parseTuiMenuFull(readTail, term.buffer.active.length)
}

const opts = (m: TuiMenu | null) =>
  m?.options.map((o) => ({
    label: o.label,
    ...(o.sentinel ? { sentinel: o.sentinel } : {}),
    ...(o.checked != null ? { checked: o.checked } : {}),
  }))

describe('multi-select do AskUserQuestion (2.1.317/318)', () => {
  it('a linha Submit não vira descrição nem opção; a régua também não', async () => {
    const menu = await parseAnsi('2.1.317-question-multi-other')
    expect(menu?.kind).toBe('question')
    expect(menu?.multiSelect).toBe(true)
    expect(menu?.submitRow).toEqual({ afterIndex: 3, focused: false })
    expect(menu?.cursorIndex).toBe(0)
    expect(opts(menu)).toEqual([
      { label: 'Azul', checked: false },
      { label: 'Verde', checked: false },
      { label: 'Vermelho', checked: false },
      { label: 'Type something', sentinel: 'other', checked: false },
      { label: 'Chat about this', sentinel: 'chat' },
    ])
    expect(menu?.options[3].description).toBeUndefined()
  })

  it('Other com texto: continua sentinela other, com o texto em otherText', () => {
    const menu = txt('2.1.317-question-multi-other-typed')
    expect(menu?.options[3]).toMatchObject({
      label: 'verde agua',
      sentinel: 'other',
      otherText: 'verde agua',
      checked: true,
    })
    expect(menu?.cursorIndex).toBe(3)
    expect(menu?.tabs?.[0]).toEqual({ label: 'Cores', done: true })
  })

  it('cursor na linha Submit: sem cursorIndex, submitRow focado', () => {
    for (const name of ['2.1.317-question-multi-other-cursor-submit', '2.1.318-question-multi-submit-line']) {
      const menu = txt(name)
      expect(menu?.kind, name).toBe('question')
      expect(menu?.cursorIndex, name).toBeUndefined()
      expect(menu?.submitRow, name).toEqual({ afterIndex: 3, focused: true })
    }
  })

  it('o checkbox segue o que a tela mostra depois de dígito e Enter', () => {
    expect(txt('2.1.318-question-multi-digit-toggle')?.options[0].checked).toBe(true)
    const enter = txt('2.1.318-question-multi-enter-toggle')
    expect(enter?.options.map((o) => o.checked)).toEqual([true, false, false, false, undefined])
    // Dígito do Other marca "Type something" vazio, sem mover o cursor.
    const other = txt('2.1.318-question-multi-digit-other')
    expect(other?.options[3]).toMatchObject({ label: 'Type something', checked: true })
    expect(other?.options[3].otherText).toBeUndefined()
    expect(other?.cursorIndex).toBe(1)
  })

  it('revisão do multi-select', () => {
    const review = txt('2.1.318-question-multi-review-no-other')
    expect(review?.kind).toBe('question_review')
    expect(review?.context).toMatch(/→ Morango/)
  })
})

describe('single-select: Other e sentinela chat (2.1.317/318)', () => {
  it('Other com texto digitado: sentinela other com otherText, cursor nele', () => {
    const menu = txt('2.1.318-question-single-other-typed')
    expect(menu?.multiSelect).toBe(false)
    expect(menu?.options[3]).toMatchObject({ label: 'Rust 2', sentinel: 'other', otherText: 'Rust 2' })
    expect(menu?.cursorIndex).toBe(3)
    expect(menu?.submitRow).toBeUndefined()
  })

  it('dígito do Other foca o campo vazio: cursor no Other', () => {
    const menu = txt('2.1.318-question-single-digit-other')
    expect(menu?.cursorIndex).toBe(3)
    expect(menu?.options[3]).toMatchObject({ label: 'Type something.', sentinel: 'other' })
  })

  it('cursor na sentinela chat', () => {
    const menu = txt('2.1.317-question-chat-sentinel-cursor')
    expect(menu?.kind).toBe('question')
    expect(menu?.cursorIndex).toBe(4)
    expect(menu?.options[4].sentinel).toBe('chat')
  })
})

describe('diálogos da CLI nunca são pergunta (2.1.317)', () => {
  it('nudge do auto mode: kind nudge, 3 opções numeradas, e passa no gate em idle', async () => {
    for (const name of ['2.1.317-auto-mode-env-nudge', '2.1.317-question-multi-other-after-submit']) {
      const menu = txt(name)
      expect(menu?.kind, name).toBe('nudge')
      expect(menu?.question, name).toBe('Teach auto mode about your environment?')
      expect(menu?.options.map((o) => o.label), name).toEqual(['Yes', 'Not now', "Don't show again"])
      expect(menu?.cursorIndex, name).toBe(0)
      expect(menu?.navigation, name).toBeUndefined()
      expect(gateMenuByStatus(menu, 'idle')?.kind, name).toBe('nudge')
    }
  })

  it('submenu de restaurar do /rewind: menu genérico, "Summarize from here" abre campo', () => {
    const menu = txt('2.1.317-rewind-restore-menu')
    expect(menu?.kind).toBe('menu')
    expect(menu?.question).toBe('Rewind')
    expect(menu?.context).toMatch(/^Confirm you want to restore/)
    expect(menu?.options.map((o) => [o.label, o.opensInput ?? false])).toEqual([
      ['Restore conversation', false],
      ['Summarize from here', true],
      ['Summarize up to here', false],
      ['Never mind', false],
    ])
    for (const name of ['2.1.317-rewind-restore-menu-down', '2.1.317-rewind-digit-into-input']) {
      const m = txt(name)
      expect(m?.kind, name).toBe('menu')
      expect(m?.cursorIndex, name).toBe(1)
      expect(m?.options[1].opensInput, name).toBe(true)
    }
  })

  it('genérico só passa no gate em waiting; o nudge também em idle', () => {
    const menu = txt('2.1.317-rewind-restore-menu')
    expect(gateMenuByStatus(menu, 'waiting')?.kind).toBe('menu')
    expect(gateMenuByStatus(menu, 'idle')).toBeNull()
    expect(gateMenuByStatus(menu, 'working')).toBeNull()
    expect(gateMenuByStatus(txt('2.1.317-auto-mode-env-nudge'), 'working')).toBeNull()
  })
})

describe('parser tolerante: menus que nenhum parser dedicado conhece (2.1.317)', () => {
  it('/permissions: título, abas, foco na busca e a opção numerada', async () => {
    const menu = await parseAnsi('2.1.317-unknown-permissions')
    expect(menu).toMatchObject({
      kind: 'menu',
      question: 'Permissions',
      context: "Claude Code won't ask before using allowed tools.",
      tabSwitch: true,
      listFocusKey: true,
      footer: '←/→ to switch · ↓ to select · Esc to cancel',
    })
    expect(menu?.tabs?.map((t) => t.label)).toEqual([
      'Recently blocked',
      'Allow',
      'Ask',
      'Deny',
      'Auto mode',
      'Workspace',
    ])
    expect(menu?.options.map((o) => o.label)).toEqual(['Add a new rule…'])
    expect(menu?.cursorIndex).toBeUndefined()
    const down = txt('2.1.317-unknown-permissions-down')
    expect(down?.cursorIndex).toBe(0)
    expect(down?.listFocusKey).toBeUndefined()
  })

  it('/hooks: opção sem número com o cursor, rodapé Enter to view', async () => {
    const menu = await parseAnsi('2.1.317-unknown-hooks')
    expect(menu).toMatchObject({
      kind: 'menu',
      question: 'Hooks',
      navigation: 'arrows',
      cursorIndex: 0,
      footer: 'Enter to view · Esc to close',
    })
    expect(menu?.options.map((o) => o.label)).toEqual(['All events'])
  })

  it('seletor do /rewind: uma parada por mensagem, "No code changes" é descrição', () => {
    const menu = txt('2.1.317-rewind-picker')
    expect(menu?.kind).toBe('menu')
    expect(menu?.navigation).toBe('arrows')
    expect(menu?.options.map((o) => [o.label, o.description ?? ''])).toEqual([
      ['diga a', 'No code changes'],
      ['diga b', 'No code changes'],
      ['diga c', 'No code changes'],
      ['(current)', ''],
    ])
    expect(menu?.cursorIndex).toBe(3)
    const selected = txt('2.1.317-rewind-picker-selected')
    expect(selected?.cursorIndex).toBe(1)
    // O cursor não entra na identidade: andar não troca o menu.
    expect(menuFingerprint(selected!)).toBe(menuFingerprint(menu!))
  })

  it('/permissions depois de → (sonda e2e-generic-menus, 2.1.318): outra aba, mesmo diálogo', () => {
    const before = txt('2.1.317-unknown-permissions')
    const after = txt('2.1.318-unknown-permissions-tab-next')
    expect(after?.kind).toBe('menu')
    expect(after?.question).toBe('Permissions')
    expect(after?.context).toMatch(/^Claude Code will always ask/)
    // A aba ativa só aparece no texto do corpo: o fingerprint muda, então o card relê.
    expect(menuFingerprint(after!)).not.toBe(menuFingerprint(before!))
  })

  it('"Add allow permission rule": diálogo de campo, só Esc (nenhuma opção)', () => {
    const menu = txt('2.1.318-unknown-permissions-add-rule')
    expect(menu?.kind).toBe('menu')
    expect(menu?.question).toBe('Add allow permission rule')
    expect(menu?.options).toEqual([])
    expect(menu?.footer).toBe('Enter to submit · Esc to cancel')
  })

  it('telas sem diálogo continuam sem menu', () => {
    for (const name of [
      '2.1.317-compact-done',
      '2.1.317-compact-running',
      '2.1.317-history-search-results',
      '2.1.317-plan-auto-after-approve',
      '2.1.318-question-multi-keys',
    ]) {
      const menu = txt(name)
      if (name.endsWith('multi-keys')) expect(menu?.kind, name).toBe('question')
      else expect(menu?.kind ?? null, name).not.toBe('menu')
    }
  })
})
