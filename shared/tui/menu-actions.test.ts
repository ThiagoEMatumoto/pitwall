import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { actionKeyDelay, isStepAction, keysForAction } from './menu-actions'
import {
  buildChatKeys,
  buildGenericSelectKeys,
  buildMultiSubmitKeys,
  buildQuestionOtherKeys,
  buildSelectKeys,
  buildToggleKeys,
  cursorInInput,
  QUESTION_KEY_DELAY_MS,
} from './respond-keys'
import { parseTuiMenu, type TuiMenu } from './tui-menu-parser'

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const menuOf = (name: string): TuiMenu => {
  const m = parseTuiMenu(readFileSync(join(__dirname, '__fixtures__', `claude-${name}.txt`), 'utf8'))
  if (!m) throw new Error(`sem menu em ${name}`)
  return m
}

// Teclas conferidas contra o que a TUI fez ao vivo (sondas question-multi-keys*,
// question-single-keys e question-multi-chat-digit, claude 2.1.318).
describe('multi-select: marcar, Other, Submit', () => {
  const fresh = () => menuOf('2.1.317-question-multi-other')

  it('marcar é o dígito (alterna sem mover o cursor)', () => {
    expect(buildToggleKeys(1, fresh())).toEqual(['2'])
    expect(keysForAction(fresh(), { kind: 'toggle', optionIndex: 2 })).toEqual(['3'])
  })

  it('Other e chat não são checkbox', () => {
    expect(keysForAction(fresh(), { kind: 'toggle', optionIndex: 3 })).toEqual([])
    expect(keysForAction(fresh(), { kind: 'toggle', optionIndex: 4 })).toEqual([])
  })

  it('com o cursor no campo do Other, o dígito sai dele antes (senão vira texto)', () => {
    const typing = menuOf('2.1.317-question-multi-other-typing')
    expect(cursorInInput(typing)).toBe(true)
    expect(keysForAction(typing, { kind: 'toggle', optionIndex: 0 })).toEqual([UP, '1'])
  })

  it('Other: setas até o campo, texto, ↓ (marca e vai ao Submit) — nunca o dígito', () => {
    expect(buildQuestionOtherKeys(fresh(), 3, 'verde agua')).toEqual([DOWN, DOWN, DOWN, 'verde agua', DOWN])
    // Do Submit, sobe um.
    const atSubmit = menuOf('2.1.318-question-multi-submit-line')
    expect(buildQuestionOtherKeys(atSubmit, 3, 'roxo')).toEqual([UP, 'roxo', DOWN])
  })

  it('Other que já tem texto no terminal: nada (concatenaria)', () => {
    expect(buildQuestionOtherKeys(menuOf('2.1.317-question-multi-other-typed'), 3, 'mais')).toEqual([])
  })

  it('Submit: ↓ até a linha Submit e Enter; já nela, só Enter', () => {
    expect(buildMultiSubmitKeys(fresh())).toEqual([DOWN, DOWN, DOWN, DOWN, '\r'])
    expect(buildMultiSubmitKeys(menuOf('2.1.317-question-multi-other-typed'))).toEqual([DOWN, '\r'])
    expect(buildMultiSubmitKeys(menuOf('2.1.317-question-multi-other-cursor-submit'))).toEqual(['\r'])
    expect(keysForAction(fresh(), { kind: 'submit-multi' })).toEqual([DOWN, DOWN, DOWN, DOWN, '\r'])
  })

  it('Submit do cursor na sentinela chat (abaixo da linha Submit) sobe', () => {
    const atChat = { ...fresh(), cursorIndex: 4 }
    expect(buildMultiSubmitKeys(atChat)).toEqual([UP, '\r'])
  })

  it('sem cursor nem Submit focado: nada', () => {
    const blind = { ...fresh(), cursorIndex: undefined }
    expect(buildMultiSubmitKeys(blind)).toEqual([])
    expect(buildQuestionOtherKeys(blind, 3, 'x')).toEqual([])
  })

  it('selecionar direto não existe no multi-select', () => {
    expect(keysForAction(fresh(), { kind: 'select', optionIndex: 0 })).toEqual([])
  })

  it('Other e Submit com respiro; toggle e Other do multi são passos', () => {
    expect(actionKeyDelay(fresh(), { kind: 'other', optionIndex: 3, text: 'a' })).toBe(QUESTION_KEY_DELAY_MS)
    expect(actionKeyDelay(fresh(), { kind: 'submit-multi' })).toBe(QUESTION_KEY_DELAY_MS)
    expect(isStepAction(fresh(), { kind: 'toggle', optionIndex: 0 })).toBe(true)
    expect(isStepAction(fresh(), { kind: 'other', optionIndex: 3, text: 'a' })).toBe(true)
    expect(isStepAction(fresh(), { kind: 'submit-multi' })).toBe(false)
  })

  it('revisão: dígito de Submit answers / Cancel', () => {
    const review = menuOf('2.1.318-question-multi-review-no-other')
    expect(keysForAction(review, { kind: 'select', optionIndex: 0 })).toEqual(['1'])
    expect(keysForAction(review, { kind: 'select', optionIndex: 1 })).toEqual(['2'])
  })
})

describe('single-select: Other e chat', () => {
  const fresh = () => menuOf('2.1.317-question-chat-sentinel')

  it('Other: dígito foca, texto, Enter', () => {
    expect(buildQuestionOtherKeys(fresh(), 3, 'Rust 2')).toEqual(['4', 'Rust 2', '\r'])
  })

  it('Other com o cursor já no campo vazio: só texto e Enter', () => {
    expect(buildQuestionOtherKeys(menuOf('2.1.318-question-single-digit-other'), 3, 'Rust')).toEqual([
      'Rust',
      '\r',
    ])
  })

  it('Other já com texto no terminal: nada', () => {
    expect(buildQuestionOtherKeys(menuOf('2.1.318-question-single-other-typed'), 3, 'x')).toEqual([])
  })

  it('opção comum com o cursor no campo do Other: sai com ↑ antes do dígito', () => {
    expect(buildSelectKeys(menuOf('2.1.318-question-single-other-typed'), 1)).toEqual([UP, '2'])
    expect(buildSelectKeys(fresh(), 1)).toEqual(['2'])
  })

  it('chat: o dígito da sentinela, saindo do campo se preciso', () => {
    expect(buildChatKeys(fresh())).toEqual(['5'])
    expect(keysForAction(fresh(), { kind: 'chat' })).toEqual(['5'])
    expect(buildChatKeys(menuOf('2.1.318-question-single-digit-other'))).toEqual([UP, '5'])
    expect(buildChatKeys(menuOf('2.1.317-question-multi-other'))).toEqual(['5'])
  })

  it('select na sentinela chat pelo caminho genérico: nada (é a ação chat)', () => {
    expect(keysForAction(fresh(), { kind: 'select', optionIndex: 4 })).toEqual([])
  })
})

describe('menu genérico e nudge', () => {
  it('submenu do /rewind: dígito com o cursor fora do campo', () => {
    const menu = menuOf('2.1.317-rewind-restore-menu')
    expect(buildGenericSelectKeys(menu, 0)).toEqual(['1'])
    expect(buildGenericSelectKeys(menu, 3)).toEqual(['4'])
  })

  it('opção que abre campo: setas + Enter, nunca dígito', () => {
    expect(buildGenericSelectKeys(menuOf('2.1.317-rewind-restore-menu'), 1)).toEqual([DOWN, '\r'])
  })

  it('cursor no campo (Summarize from here): setas + Enter (o dígito viraria texto)', () => {
    for (const name of ['2.1.317-rewind-restore-menu-down', '2.1.317-rewind-digit-into-input']) {
      const menu = menuOf(name)
      expect(buildGenericSelectKeys(menu, 0), name).toEqual([UP, '\r'])
      expect(buildGenericSelectKeys(menu, 3), name).toEqual([DOWN, DOWN, '\r'])
    }
  })

  it('lista sem número (seletor do /rewind, /hooks): setas do cursor + Enter', () => {
    const picker = menuOf('2.1.317-rewind-picker')
    expect(buildGenericSelectKeys(picker, 1)).toEqual([UP, UP, '\r'])
    expect(buildGenericSelectKeys(picker, 3)).toEqual(['\r'])
    expect(keysForAction(menuOf('2.1.317-unknown-hooks'), { kind: 'select', optionIndex: 0 })).toEqual(['\r'])
  })

  it('/permissions com foco na busca: ↓ pousa na 1ª opção, depois Enter; abas por ←/→', () => {
    const menu = menuOf('2.1.317-unknown-permissions')
    expect(buildGenericSelectKeys(menu, 0)).toEqual([DOWN, '\r'])
    expect(keysForAction(menu, { kind: 'tab', direction: 'next' })).toEqual(['\x1b[C'])
    expect(keysForAction(menu, { kind: 'tab', direction: 'prev' })).toEqual(['\x1b[D'])
    expect(keysForAction(menuOf('2.1.317-unknown-permissions-down'), { kind: 'select', optionIndex: 0 })).toEqual(['1'])
  })

  it('sem dica de abas: tab não digita nada; Esc sempre', () => {
    const hooks = menuOf('2.1.317-unknown-hooks')
    expect(keysForAction(hooks, { kind: 'tab', direction: 'next' })).toEqual([])
    expect(keysForAction(hooks, { kind: 'esc' })).toEqual(['\x1b'])
  })

  it('nudge: dígito da opção', () => {
    const nudge = menuOf('2.1.317-auto-mode-env-nudge')
    expect(keysForAction(nudge, { kind: 'select', optionIndex: 1 })).toEqual(['2'])
    expect(keysForAction(nudge, { kind: 'other', optionIndex: 1, text: 'x' })).toEqual([])
  })

  it('sem cursor e sem foco na busca: nada', () => {
    const menu = { ...menuOf('2.1.317-rewind-picker'), cursorIndex: undefined }
    expect(buildGenericSelectKeys(menu, 0)).toEqual([])
  })
})

describe('single-select com abas (várias perguntas): Other', () => {
  // Sem captura de abas no single-select: a tela real de uma pergunta com as abas que
  // várias perguntas teriam.
  const withTabs = (m: TuiMenu): TuiMenu => ({
    ...m,
    tabs: [
      { label: 'Q1', done: false },
      { label: 'Q2', done: false },
      { label: 'Submit', done: false },
    ],
  })

  it('cursor já no campo do Other: só o texto e Enter, sem o dígito', () => {
    const menu = withTabs(menuOf('2.1.318-question-single-digit-other'))
    const other = menu.options.find((o) => o.sentinel === 'other')!
    expect(menu.cursorIndex).toBe(other.index)
    expect(buildQuestionOtherKeys(menu, other.index, 'Rust')).toEqual(['Rust', '\r'])
  })

  it('cursor fora do campo: dígito do Other, texto e Enter', () => {
    const base = menuOf('2.1.318-question-single-digit-other')
    const other = base.options.find((o) => o.sentinel === 'other')!
    const menu = withTabs({ ...base, cursorIndex: 0 })
    expect(buildQuestionOtherKeys(menu, other.index, 'Rust')).toEqual([String(other.index + 1), 'Rust', '\r'])
  })
})
