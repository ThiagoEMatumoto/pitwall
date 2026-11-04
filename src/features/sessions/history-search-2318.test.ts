import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTuiMenu } from '../../../shared/tui/tui-menu-parser'
import { isKnownMenu } from '../../../shared/tui/tui-menu-parser'
import {
  historyAcceptEffect,
  historyAcceptKeys,
  historyCancelKeys,
  historyFillKeys,
  historyNewerKeys,
  historyOlderKeys,
  historyQueryKeys,
  historyScopeKeys,
  historySelectKeys,
} from './history-search-keys'
import { parseTuiPicker, type TuiHistorySearch } from './tui-picker-parser'

// Capturas reais do claude 2.1.318 com 17 prompts no histórico (sondas history-populated,
// e2e-history e e2e-history-fullscreen). "fullscreen-" = settings real ("tui":
// "fullscreen"), no escopo "project" — o "everywhere" lista o histórico da conta.
const txt = (name: string) =>
  readFileSync(
    join(__dirname, `../../../shared/tui/__fixtures__/claude-2.1.318-${name}.txt`),
    'utf8',
  )
const history = (name: string): TuiHistorySearch => {
  const p = parseTuiPicker(txt(name))
  if (p?.kind !== 'history_search') throw new Error(`${name}: ${p?.kind ?? 'null'}`)
  return p
}
const UP = '\x1b[A'
const DOWN = '\x1b[B'

describe('Ctrl+R sem fullscreen (linha no rodapé)', () => {
  it('o match é o que a caixa de input mostra para a query', () => {
    expect(history('history-query')).toEqual({
      kind: 'history_search',
      mode: 'inline',
      query: 'diga',
      noMatch: false,
      match: 'diga lima',
    })
    expect(history('history-query-older').match).toBe('diga juliett')
    expect(history('history-query-narrow')).toMatchObject({ query: 'diga g', match: 'diga golf' })
    expect(history('history-e2e-inline-older').match).toBe('diga juliett')
  })

  it('sem match a caixa mantém o anterior: não vira resultado', () => {
    expect(history('history-no-match')).toEqual({
      kind: 'history_search',
      mode: 'inline',
      query: 'digazzqx',
      noMatch: true,
    })
  })

  it('sem query a caixa é o rascunho, não um resultado', () => {
    expect(history('history-open-with-draft').match).toBeUndefined()
    expect(history('history-open-empty').match).toBeUndefined()
  })

  it('fechada (Tab, Esc, Enter, Ctrl+C): sem picker', () => {
    for (const name of [
      'history-after-tab',
      'history-after-esc',
      'history-after-enter',
      'history-after-ctrl-c',
      'history-e2e-cancel-with-draft',
    ])
      expect(parseTuiPicker(txt(name)), name).toBeNull()
  })

  it('teclas: Enter ENVIA, Tab só preenche, Ctrl+R anterior, Ctrl+C cancela com query', () => {
    const p = history('history-query')
    expect(historyAcceptEffect(p)).toBe('send')
    expect(historyAcceptKeys(p)).toEqual(['\r'])
    expect(historyFillKeys(p)).toEqual(['\t'])
    expect(historyOlderKeys(p)).toEqual(['\x12'])
    expect(historyNewerKeys(p)).toEqual([])
    expect(historyCancelKeys(p)).toEqual(['\x03'])
    expect(historyScopeKeys(p)).toEqual([])
    const empty = history('history-open-empty')
    expect(historyAcceptKeys(empty)).toEqual([])
    expect(historyOlderKeys(empty)).toEqual([])
    expect(historyCancelKeys(empty)).toEqual(['\x1b'])
    expect(historyAcceptKeys(history('history-no-match'))).toEqual([])
  })
})

describe('Ctrl+R no fullscreen (modal "Search prompts")', () => {
  it('escopo, lista visível, cursor e filtro', () => {
    const open = history('fullscreen-history-modal-project')
    expect(open).toMatchObject({
      mode: 'modal',
      scope: 'project',
      query: '',
      moreAbove: true,
      cursorIndex: 7,
    })
    expect(open.results?.map((r) => r.text)).toEqual([
      'diga golf',
      'Responda só: ok hotel',
      'diga india',
      'Liste três cores separadas por vírgula, nada ma…',
      'diga juliett',
      'Responda só: ok kilo',
      'diga lima',
      'Responda só: ok mike',
    ])
    expect(open.results?.[0].age).toMatch(/^\d+s ago$/)
    const query = history('fullscreen-history-modal-query')
    expect(query.query).toBe('diga')
    expect(query.results?.every((r) => r.text.startsWith('diga'))).toBe(true)
    const selected = history('fullscreen-history-modal-selected')
    expect(selected.results?.find((r) => r.index === selected.cursorIndex)?.text).toBe('diga india')
  })

  it('teclas: setas navegam, Enter só PREENCHE, Esc cancela, ctrl+s troca o escopo', () => {
    const p = history('fullscreen-history-modal-query')
    expect(historyAcceptEffect(p)).toBe('fill')
    expect(historyAcceptKeys(p)).toEqual(['\r'])
    expect(historyOlderKeys(p)).toEqual([UP])
    expect(historyNewerKeys(p)).toEqual([])
    expect(historySelectKeys(p, 5)).toEqual([UP, UP])
    expect(historySelectKeys(p, 99)).toEqual([])
    expect(historyCancelKeys(p)).toEqual(['\x1b'])
    expect(historyScopeKeys(p)).toEqual(['\x13'])
    expect(historyNewerKeys(history('fullscreen-history-modal-selected'))).toEqual([DOWN])
  })

  it('o parser genérico também vê o modal, mas como diálogo conhecido', () => {
    const m = parseTuiMenu(txt('fullscreen-history-modal-project'))
    expect(m?.question).toBe('Search prompts · project')
    expect(isKnownMenu(m!)).toBe(true)
  })

  it('depois de usar: modal fechado, prompt na caixa', () => {
    expect(parseTuiPicker(txt('fullscreen-history-modal-after-use'))).toBeNull()
    expect(txt('fullscreen-history-modal-after-use')).toMatch(/^❯ diga india\s*$/m)
  })
})

describe('historyQueryKeys', () => {
  it('apaga até o prefixo comum e digita o resto', () => {
    expect(historyQueryKeys('', 'ok kilo')).toEqual(['ok kilo'])
    expect(historyQueryKeys('ok kilo', 'diga')).toEqual([...Array(7).fill('\x7f'), 'diga'])
    expect(historyQueryKeys('diga', 'diga g')).toEqual([' g'])
    expect(historyQueryKeys('diga g', 'diga')).toEqual(['\x7f', '\x7f'])
    expect(historyQueryKeys('a', 'a\x1b[Ab')).toEqual(['[Ab'])
  })
})
