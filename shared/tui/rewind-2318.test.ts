import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import xtermHeadless from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { keysForAction } from './menu-actions'
import {
  buildGenericInputKeys,
  buildGenericScrollKeys,
  buildGenericSelectKeys,
} from './respond-keys'
import { readInputBox } from './input-draft'
import { isRewindPicker, rewindCursorOnTarget, rewindLabelMatches, rewindNavKeys } from './rewind'
import { gateMenuByStatus, isKnownMenu, parseTuiMenu, type TuiMenu } from './tui-menu-parser'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

// Capturas reais do claude 2.1.318 (e2e/scenarios/probe-chat-plan-2317.ts, cenários
// rewind-populated, e2e-rewind-restore e e2e-rewind-never-mind; PTY 120x45). Sessão de
// 10 mensagens, 5 com edição de arquivo. "fullscreen-" = settings real do usuário
// ("tui": "fullscreen"): o seletor rola e mostra "↑ N more"/"↓ N more".
const fixture = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', `claude-2.1.318-${name}`), 'utf8')
const menu = (name: string): TuiMenu => parseTuiMenu(fixture(`${name}.txt`))!

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const EXTRA = 'Crie o arquivo extra.txt contendo só a linha: quatro. Não faça mais nada.'

async function replay(...names: string[]) {
  const term = new Terminal({ cols: 120, rows: 45, allowProposedApi: true, scrollback: 2000 })
  for (const n of names) await new Promise<void>((r) => term.write(fixture(n), r))
  return term
}

describe('seletor do /rewind com edições (2.1.318)', () => {
  it('sem fullscreen: as 10 mensagens + (current), descrição com o arquivo editado', () => {
    const m = menu('rewind-picker-populated')
    expect(isRewindPicker(m)).toBe(true)
    expect(m.options).toHaveLength(11)
    expect(m.options[4]).toMatchObject({ label: EXTRA, description: 'extra.txt +1' })
    expect(m.cursorIndex).toBe(10)
    expect(m.moreAbove).toBeUndefined()
  })

  it('fullscreen: janela de 3 paradas com as contagens de fora', () => {
    const open = menu('fullscreen-rewind-picker-populated')
    expect(open.options.map((o) => o.label)).toEqual([
      "Acrescente a linha 'oito' ao final de extra.txt. Não faça mais nada.",
      'Responda só: ok nove.',
      '(current)',
    ])
    expect(open).toMatchObject({ moreAbove: true, moreAboveCount: 8, cursorIndex: 2 })
    const mid = menu('fullscreen-rewind-picker-code')
    expect(mid).toMatchObject({ moreAboveCount: 2, moreBelowCount: 6 })
    expect(mid.options.find((o) => o.index === mid.cursorIndex)?.label).toBe(EXTRA)
  })

  it('setas a partir de (current) até a mensagem, nas duas telas', () => {
    expect(rewindNavKeys(menu('rewind-picker-populated'), { text: EXTRA, fromEnd: 6 })).toEqual(
      Array(6).fill(UP),
    )
    expect(
      rewindNavKeys(menu('fullscreen-rewind-picker-populated'), { text: EXTRA, fromEnd: 6 }),
    ).toEqual(Array(6).fill(UP))
    // Cursor já no meio da lista rolada: anda o que falta.
    expect(
      rewindNavKeys(menu('fullscreen-rewind-picker-code'), {
        text: 'Responda só: ok cinco.',
        fromEnd: 5,
      }),
    ).toEqual([DOWN])
    expect(rewindNavKeys(menu('rewind-picker-populated'), { text: 'x', fromEnd: 11 })).toBeNull()
  })

  it('Enter só com o cursor na parada certa e o texto batendo', () => {
    const code = menu('rewind-picker-code')
    expect(rewindCursorOnTarget(code, { text: EXTRA, fromEnd: 6 })).toBe(true)
    expect(rewindCursorOnTarget(code, { text: EXTRA, fromEnd: 5 })).toBe(false)
    expect(rewindCursorOnTarget(code, { text: 'outra mensagem', fromEnd: 6 })).toBe(false)
    expect(
      rewindCursorOnTarget(menu('fullscreen-rewind-picker-code'), { text: EXTRA, fromEnd: 6 }),
    ).toBe(true)
    // Em (current), nunca.
    expect(
      rewindCursorOnTarget(menu('rewind-picker-populated'), { text: '(current)', fromEnd: 0 }),
    ).toBe(false)
  })

  it('o chat mostra mensagens que o terminal desfez: o texto bate, mas as vizinhas não', () => {
    const code = menu('rewind-picker-code')
    const labels = code.options.slice(0, -1).map((o) => o.label)
    expect(rewindCursorOnTarget(code, { text: EXTRA, fromEnd: 6, chat: labels })).toBe(true)
    // Mesmo texto e mesma distância do fim, mas o chat tem uma mensagem a mais antes dele
    // (ramo que um Restore conversation desfez e o disco ainda não tirou do chat).
    const stale = [...labels.slice(0, 4), 'faz o setup', ...labels.slice(4)]
    expect(stale[stale.length - 6]).toBe(EXTRA)
    expect(rewindCursorOnTarget(code, { text: EXTRA, fromEnd: 6, chat: stale })).toBe(false)
    // Fullscreen: só as paradas visíveis entram na conferência.
    const full = menu('fullscreen-rewind-picker-code')
    expect(rewindCursorOnTarget(full, { text: EXTRA, fromEnd: 6, chat: labels })).toBe(true)
    expect(rewindCursorOnTarget(full, { text: EXTRA, fromEnd: 6, chat: stale })).toBe(false)
  })

  it('lista rolada sem a contagem não tem posição: nada de setas', () => {
    const m = { ...menu('fullscreen-rewind-picker-populated'), moreAboveCount: undefined }
    expect(rewindNavKeys(m, { text: EXTRA, fromEnd: 6 })).toBeNull()
  })

  it('label cortado com reticências casa pelo começo; sem reticências, inteiro', () => {
    expect(
      rewindLabelMatches(
        'Liste três cores separadas por vírgula, nada ma…',
        'Liste três cores separadas por vírgula, nada mais.',
      ),
    ).toBe(true)
    expect(rewindLabelMatches('diga a', 'diga alfa')).toBe(false)
    expect(rewindLabelMatches('diga  alfa', 'diga\nalfa')).toBe(true)
  })

  it('submenu não é o seletor', () => {
    expect(isRewindPicker(menu('rewind-submenu-code'))).toBe(false)
  })
})

describe('submenu do /rewind com código a restaurar (2.1.318)', () => {
  it('seis opções numa janela de cinco, aviso embaixo, sem rodapé', () => {
    for (const name of ['rewind-submenu-code', 'fullscreen-rewind-submenu-code']) {
      const m = menu(name)
      expect(m.kind, name).toBe('menu')
      expect(m.question, name).toBe('Rewind')
      expect(
        m.options.map((o) => [o.label, o.opensInput ?? false]),
        name,
      ).toEqual([
        ['Restore code and conversation', false],
        ['Restore conversation', false],
        ['Restore code', false],
        ['Summarize from here', true],
        ['Summarize up to here', true],
      ])
      expect(m.moreBelow, name).toBe(true)
      expect(m.warning, name).toMatch(/^⚠ Restored files go back whole/)
      expect(m.context, name).toMatch(/The code will be restored -3 in notas\.txt and extra\.txt\./)
      expect(isKnownMenu(m), name).toBe(true)
      expect(gateMenuByStatus(m, 'waiting')?.kind, name).toBe('menu')
    }
  })

  it('dígito escolhe as opções sem campo; o campo vai por setas', () => {
    const m = menu('rewind-submenu-code')
    expect(buildGenericSelectKeys(m, 0)).toEqual(['1'])
    expect(buildGenericSelectKeys(m, 1)).toEqual(['2'])
    expect(buildGenericSelectKeys(m, 3)).toEqual([DOWN, DOWN, DOWN, '\r'])
  })

  it('"Summarize from here" com contexto: setas, texto, Enter; campo com texto não recebe mais', () => {
    expect(buildGenericInputKeys(menu('rewind-submenu-code'), 3, 'foco nas notas')).toEqual([
      DOWN,
      DOWN,
      DOWN,
      'foco nas notas',
      '\r',
    ])
    expect(
      keysForAction(menu('rewind-submenu-code'), { kind: 'other', optionIndex: 3, text: 'x' }),
    ).toEqual([DOWN, DOWN, DOWN, 'x', '\r'])
    expect(buildGenericInputKeys(menu('rewind-submenu-summarize-typed'), 3, 'mais')).toEqual([])
    expect(buildGenericInputKeys(menu('rewind-submenu-code'), 0, 'x')).toEqual([])
    // Campo focado e vazio ("add context (optional)") aceita.
    expect(buildGenericInputKeys(menu('rewind-submenu-code-summarize'), 3, 'x')).toEqual([
      'x',
      '\r',
    ])
  })

  it('"mostrar mais" rola até o Never mind; com a janela rolada, setas + Enter', () => {
    const top = menu('rewind-submenu-code')
    expect(buildGenericScrollKeys(top, 'down')).toEqual(Array(5).fill(DOWN))
    expect(buildGenericScrollKeys(top, 'up')).toEqual([])
    const scrolled = menu('rewind-e2e-submenu-scrolled')
    expect(scrolled.options.map((o) => o.label).at(-1)).toBe('Never mind')
    expect(scrolled).toMatchObject({ moreAbove: true, navigation: 'arrows', cursorIndex: 5 })
    expect(buildGenericSelectKeys(scrolled, 5)).toEqual(['\r'])
    expect(buildGenericScrollKeys(scrolled, 'up')).toEqual(Array(5).fill(UP))
  })

  it('Esc no submenu volta ao seletor com o cursor na mesma mensagem', () => {
    const back = menu('rewind-submenu-esc')
    expect(isRewindPicker(back)).toBe(true)
    expect(back.options.find((o) => o.index === back.cursorIndex)?.label).toBe(EXTRA)
    expect(isRewindPicker(menu('rewind-never-mind'))).toBe(true)
  })
})

describe('caixa de input depois do Restore conversation (2.1.318)', () => {
  it('a CLI devolve o texto da mensagem restaurada na caixa; antes, vazia', async () => {
    const before = await replay('rewind-idle-populated.ansi')
    expect(readInputBox(before)).toEqual({ prompt: true, draft: null })
    const after = await replay('rewind-e2e-submenu.ansi', 'rewind-e2e-after-restore.ansi')
    expect(parseTuiMenu(fixture('rewind-e2e-after-restore.txt'))).toBeNull()
    expect(readInputBox(after)).toEqual({ prompt: true, draft: EXTRA })
  })
})
