import xtermHeadless from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { deriveAttentionReason, isUnparsedWaiting } from '../../../shared/tui/attention-reason'
import { readBufferTail } from '../../../shared/tui/read-tail'
import {
  gateMenuByStatus,
  isKnownMenu,
  parseTuiMenuFull,
} from '../../../shared/tui/tui-menu-parser'
import { fixture, scanOf } from './test-support/screen-scans'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

// Telas do app buildado (drive-app, claude 2.1.318, PTY 167x37) com `"tui": "fullscreen"`
// no settings do usuário: a CLI abre o diálogo com uma régua de ▔ (U+2594), não de ─.
// As fixtures populated-* vieram de uma sonda com --setting-sources project,local, que
// deixa esse settings de fora; no app o /hooks e o /permissions caíam no banner.
const SIZE = { cols: 167, rows: 37 }
const raw = (name: string) =>
  fixture(`claude-2.1.318-fullscreen-${name}.txt`).replace(/\n$/, '').split('\n').join('\r\n')

async function rendererMenu(name: string) {
  return rendererMenuOf(raw(name))
}

async function rendererMenuOf(data: string) {
  const term = new Terminal({ ...SIZE, allowProposedApi: true, scrollback: 2000 })
  await new Promise<void>((resolve) => term.write(data, resolve))
  const menu = parseTuiMenuFull((n) => readBufferTail(term, n), term.buffer.active.length)
  term.dispose()
  return gateMenuByStatus(menu, 'waiting')
}

describe('diálogos em tui fullscreen (régua ▔)', () => {
  it('/hooks: o renderer lê o menu genérico', async () => {
    const menu = (await rendererMenu('hooks'))!
    expect(menu).toMatchObject({
      kind: 'menu',
      question: 'Hooks',
      cursorIndex: 0,
      moreBelow: true,
      footer: 'Enter to view · Esc to close',
    })
    expect(isKnownMenu(menu)).toBe(true)
    expect(menu.options[0]).toMatchObject({
      label: '[User] · ~/.claude/hooks/prompt-linter.sh · Agent · command',
      group: 'PreToolUse — before tool execution',
    })
  })

  it('/permissions: o renderer lê abas e regras', async () => {
    const menu = (await rendererMenu('permissions'))!
    expect(menu).toMatchObject({ kind: 'menu', question: 'Permissions', tabSwitch: true })
    expect(isKnownMenu(menu)).toBe(true)
    expect(menu.tabs?.map((t) => t.label)).toEqual([
      'Recently blocked',
      'Allow',
      'Ask',
      'Deny',
      'Auto mode',
      'Workspace',
    ])
    expect(menu.options.map((o) => o.label).slice(0, 2)).toEqual([
      'Add a new rule…',
      'Bash(aws sts *)',
    ])
  })

  it.each(['hooks', 'permissions'])(
    '%s: o espelho do main vira "dialog", não drift',
    async (name) => {
      const scan = await scanOf(raw(name), SIZE)
      expect(scan.menu?.kind).toBe('menu')
      expect(isUnparsedWaiting('waiting', scan)).toBe(false)
      expect(deriveAttentionReason({ status: 'waiting', scan, handoffAsking: false })).toBe(
        'dialog',
      )
    },
  )

  // Logo depois de abrir o diálogo a régua ▔ carrega o aviso de esforço ("○ low · /effort"),
  // que some sozinho em 1 a 8 s. Com a régua só de ▔ aceita, o banner ficava na tela e o
  // espelho contava drift até o aviso sumir (drive-app: /permissions 8,1 s, 1 contagem).
  it.each([
    ['hooks', 'Hooks'],
    ['permissions', 'Permissions'],
  ])('%s com o aviso de esforço na régua: lido de primeira', async (name, title) => {
    const screen = raw(`${name}-effort-label`)
    expect(screen).toMatch(/▔ ○ low · \/effort ▔/)
    expect((await rendererMenuOf(screen))?.question).toBe(title)
    const scan = await scanOf(screen, SIZE)
    expect(scan.menu?.question).toBe(title)
    expect(isUnparsedWaiting('waiting', scan)).toBe(false)
  })

  // A régua ▔ entra como topo de diálogo: transcript comum sob ela (lista numerada, saída
  // de ferramenta com ❯, diff) não pode virar menu. O topo e a caixa de input vêm das
  // capturas reais (fullscreen-hooks e compact-done); só o miolo é montado.
  it.each([
    ['lista numerada', ['⏺ Opções:', '  1. Primeira', '  2. Segunda', '  3. Terceira']],
    ['saída com ❯', ['⏺ Bash(ls)', '  ⎿  ❯ item a', '     item b', '     Esc to cancel']],
    ['diff', ['⏺ Update(a.ts)', '  ⎿  Updated a.ts', '      1 - old', '      1 + new', '      2   ❯ x']],
  ])('transcript com %s sob a régua ▔ segue sem menu', async (_, body) => {
    const fs = fixture('claude-2.1.318-fullscreen-hooks.txt').split('\n')
    const top = fs.slice(0, fs.findIndex((l) => /^▔{10,}/.test(l)) + 1)
    const idle = fixture('claude-2.1.317-compact-done.txt').split('\n').slice(21, 25)
    const screen = [...top, ...body, '', ...idle].join('\r\n')
    expect(await rendererMenuOf(screen)).toBeNull()
    const scan = await scanOf(screen, SIZE)
    expect(scan.menu).toBeNull()
    expect(scan.inputPrompt).toBe(true)
  })
})
