import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../../shared/types/ipc'
import { parseTuiMenu } from '../../../../shared/tui/tui-menu-parser'
import { parseChatMessages } from '../../../../electron/main/services/chat-transcript'
import {
  countUserMessages,
  isAtBottom,
  liveMenuCoversPending,
  nextResolveAt,
  pendingEchoes,
  pendingInteractive,
  resolveChatViewState,
  resolveInteractive,
  settleDialogEchoes,
  absorbDialogLines,
  visibleEchoes,
  showTerminalWaitBanner,
  type Echo,
} from './chat-logic'

const user = (text: string): ChatMessage => ({ kind: 'user', text })
const assistant = (text: string): ChatMessage => ({ kind: 'assistant', text })

describe('countUserMessages', () => {
  it('counts user messages and slash commands (both typed by the human)', () => {
    const msgs: ChatMessage[] = [
      user('a'),
      assistant('b'),
      { kind: 'tool_use', id: 't1', name: 'Read', input: {} },
      { kind: 'tool_result', forId: 't1', content: 'x', isError: false },
      user('c'),
      { kind: 'command', name: 'goal', args: 'review X' },
      { kind: 'command_output', text: 'ok' }, // saída não conta
      { kind: 'meta', text: 'injected', label: 'injected' }, // injetado não conta
    ]
    expect(countUserMessages(msgs)).toBe(3)
  })

  it('is zero for an empty transcript', () => {
    expect(countUserMessages([])).toBe(0)
  })
})

describe('optimistic echo reconciliation', () => {
  it('keeps a single echo until its user message reaches disk', () => {
    // Disco começa sem nenhuma mensagem do usuário.
    let echoes: Echo[] = []
    echoes = [...echoes, { text: 'hello', resolveAt: nextResolveAt(0, echoes.length) }]
    // Ainda 0 no disco → o eco permanece.
    expect(pendingEchoes(echoes, 0)).toHaveLength(1)
    // Disco passa a ter 1 mensagem de usuário → o eco resolve e some.
    expect(pendingEchoes(echoes, 1)).toHaveLength(0)
  })

  it('does not let one disk write resolve a different pending echo', () => {
    // Dois envios rápidos antes de qualquer gravação em disco.
    let echoes: Echo[] = []
    echoes = [...echoes, { text: 'first', resolveAt: nextResolveAt(0, echoes.length) }]
    echoes = [...echoes, { text: 'second', resolveAt: nextResolveAt(0, echoes.length) }]
    // Disco grava só o primeiro (count = 1): 'first' resolve, 'second' fica.
    const after1 = pendingEchoes(echoes, 1)
    expect(after1.map((e) => e.text)).toEqual(['second'])
    // Disco grava o segundo (count = 2): nada pendente.
    expect(pendingEchoes(echoes, 2)).toHaveLength(0)
  })

  it('does not resolve an echo against pre-existing history of the same text', () => {
    // Já existe 1 mensagem 'hello' no histórico ao enviar um novo 'hello'.
    const echo: Echo = { text: 'hello', resolveAt: nextResolveAt(1, 0) }
    // Disco continua com 1 (o novo ainda não gravou) → o eco permanece visível.
    expect(pendingEchoes([echo], 1)).toHaveLength(1)
    // Disco vai a 2 (o novo 'hello' gravou) → resolve.
    expect(pendingEchoes([echo], 2)).toHaveLength(0)
  })
})

// JSONL real do claude 2.1.318 (drive-app e sonda com transcript ligado): /hooks e
// /permissions não gravam linha nenhuma, nem ao abrir nem ao fechar com Esc; o /model
// grava o local_command só no Esc. Pela contagem do disco esses ecos nunca resolviam e
// as bolhas ficavam em "enviando…".
describe('echo of a slash command that opens a CLI dialog', () => {
  it('is settled by the dialog, since the disk never gets it', () => {
    const echoes: Echo[] = [{ text: '/hooks', resolveAt: nextResolveAt(3, 0) }]
    expect(pendingEchoes(echoes, 3)).toHaveLength(1)
    expect(visibleEchoes(settleDialogEchoes(echoes))).toEqual([])
    expect(pendingEchoes(settleDialogEchoes(echoes), 3)).toHaveLength(1)
  })

  it('does not hold a later message on the settled slot', () => {
    let echoes: Echo[] = []
    echoes = [...echoes, { text: '/permissions', resolveAt: nextResolveAt(3, echoes.length) }]
    echoes = [...echoes, { text: 'hello', resolveAt: nextResolveAt(3, echoes.length) }]
    const settled = settleDialogEchoes(echoes)
    expect(visibleEchoes(settled)).toEqual([{ text: 'hello', resolveAt: 4 }])
    // O disco grava só o 'hello' (count 3 → 4): nada fica pendente.
    expect(visibleEchoes(pendingEchoes(settled, 4))).toHaveLength(0)
  })

  it('gives the slot back when the settled command writes its line later (/model on Esc)', () => {
    let echoes: Echo[] = [{ text: '/model', resolveAt: nextResolveAt(3, 0) }]
    echoes = settleDialogEchoes(echoes)
    echoes = [...echoes, { text: 'hello', resolveAt: nextResolveAt(3, visibleEchoes(echoes).length) }]
    // O disco grava só o /model (3 → 4): o 'hello' não chegou e segue pendente.
    echoes = absorbDialogLines(echoes, [{ kind: 'command', name: 'model', args: '' }])
    expect(pendingEchoes(echoes, 4)).toEqual([{ text: 'hello', resolveAt: 5 }])
    // Linha de outro comando não é do liquidado.
    const other = settleDialogEchoes([{ text: '/hooks', resolveAt: 4 }, { text: 'x', resolveAt: 5 }])
    expect(absorbDialogLines(other, [{ kind: 'command', name: 'model', args: '' }])).toBe(other)
  })

  it('leaves messages that are not slash commands waiting for the disk', () => {
    const echoes: Echo[] = [
      { text: 'hello', resolveAt: 4 },
      { text: 'a /path in the middle', resolveAt: 5 },
    ]
    expect(settleDialogEchoes(echoes)).toBe(echoes)
  })
})

describe('resolveChatViewState', () => {
  it('is loading before the first read returns (no file known yet)', () => {
    expect(resolveChatViewState({ loading: true, transcriptExists: false, messageCount: 0 })).toBe(
      'loading',
    )
  })

  it('waits when the read finished and no transcript exists on disk', () => {
    expect(resolveChatViewState({ loading: false, transcriptExists: false, messageCount: 0 })).toBe(
      'waiting',
    )
  })

  it('is empty when the transcript exists but has no renderable messages', () => {
    expect(resolveChatViewState({ loading: false, transcriptExists: true, messageCount: 0 })).toBe(
      'empty',
    )
  })

  it('is ready as soon as there is anything to render', () => {
    expect(resolveChatViewState({ loading: false, transcriptExists: true, messageCount: 3 })).toBe(
      'ready',
    )
  })

  it('renders content (echo) even while still loading or pre-flush', () => {
    // Eco otimista enviado antes do disco alcançar: messageCount > 0 vence loading/waiting.
    expect(resolveChatViewState({ loading: true, transcriptExists: false, messageCount: 1 })).toBe(
      'ready',
    )
    expect(resolveChatViewState({ loading: false, transcriptExists: false, messageCount: 1 })).toBe(
      'ready',
    )
  })
})

describe('resolveInteractive', () => {
  it('maps question/plan ids to their answers/decision', () => {
    const msgs: ChatMessage[] = [
      { kind: 'ask_user_question', id: 'a1', questions: [] },
      { kind: 'ask_user_question_answered', forId: 'a1', answers: { Q: 'opt' } },
      { kind: 'exit_plan_mode', id: 'p1', plan: '# P', allowedPrompts: null },
      { kind: 'plan_decision', forId: 'p1', approved: true },
    ]
    const r = resolveInteractive(msgs)
    expect(r.answers.get('a1')).toEqual({ Q: 'opt' })
    expect(r.plans.get('p1')).toBe(true)
  })

  it('maps subagent ids to their final error status', () => {
    const r = resolveInteractive([
      { kind: 'subagent', id: 's1', name: 'Explore', description: '', turnCount: 1, turns: [] },
      { kind: 'subagent_result', forId: 's1', isError: false },
      { kind: 'subagent', id: 's2', name: 'Explore', description: '', turnCount: 1, turns: [] },
      { kind: 'subagent_result', forId: 's2', isError: true },
    ])
    expect(r.subagents.get('s1')).toBe(false)
    expect(r.subagents.get('s2')).toBe(true)
  })

  it('leaves unresolved ids out of the maps', () => {
    const r = resolveInteractive([{ kind: 'ask_user_question', id: 'pend', questions: [] }])
    expect(r.answers.has('pend')).toBe(false)
    expect(r.subagents.has('pend')).toBe(false)
  })
})

describe('pendingInteractive', () => {
  it('returns kind and id of the last unanswered interactive moment', () => {
    expect(pendingInteractive([{ kind: 'ask_user_question', id: 'a', questions: [] }])).toEqual({
      kind: 'question',
      id: 'a',
    })
    expect(
      pendingInteractive([{ kind: 'exit_plan_mode', id: 'p', plan: '#', allowedPrompts: null }]),
    ).toEqual({ kind: 'plan', id: 'p' })
  })

  it('is null once the last interactive moment is resolved', () => {
    const msgs: ChatMessage[] = [
      { kind: 'ask_user_question', id: 'a', questions: [] },
      { kind: 'ask_user_question_answered', forId: 'a', answers: {} },
    ]
    expect(pendingInteractive(msgs)).toBeNull()
  })

  it('reflects the latest moment when an answered one precedes a pending one', () => {
    const msgs: ChatMessage[] = [
      { kind: 'exit_plan_mode', id: 'p', plan: '#', allowedPrompts: null },
      { kind: 'plan_decision', forId: 'p', approved: true },
      { kind: 'ask_user_question', id: 'a', questions: [] },
    ]
    expect(pendingInteractive(msgs)).toEqual({ kind: 'question', id: 'a' })
  })

  it('is null when there is no interactive moment', () => {
    expect(pendingInteractive([user('hi'), assistant('yo')])).toBeNull()
  })
})

describe('showTerminalWaitBanner', () => {
  it('shows when waiting with no known interactive card (TTY-only prompt)', () => {
    expect(showTerminalWaitBanner({ status: 'waiting', pending: null })).toBe(true)
  })

  it('defers to the R5 card/banner when a question/plan is pending', () => {
    expect(
      showTerminalWaitBanner({ status: 'waiting', pending: { kind: 'question', id: 'a' } }),
    ).toBe(false)
    expect(showTerminalWaitBanner({ status: 'waiting', pending: { kind: 'plan', id: 'p' } })).toBe(
      false,
    )
  })

  it('hides when the host already shows a panel that answers the menu', () => {
    expect(
      showTerminalWaitBanner({ status: 'waiting', pending: null, answeredElsewhere: true }),
    ).toBe(false)
    expect(
      showTerminalWaitBanner({ status: 'waiting', pending: null, answeredElsewhere: false }),
    ).toBe(true)
  })

  it('does not show for non-waiting statuses', () => {
    expect(showTerminalWaitBanner({ status: 'working', pending: null })).toBe(false)
    expect(showTerminalWaitBanner({ status: 'idle', pending: null })).toBe(false)
    expect(showTerminalWaitBanner({ status: 'starting', pending: null })).toBe(false)
    expect(showTerminalWaitBanner({ status: 'ended', pending: null })).toBe(false)
    expect(showTerminalWaitBanner({ status: undefined, pending: null })).toBe(false)
  })
})

describe('isAtBottom', () => {
  it('is true at the exact bottom', () => {
    expect(isAtBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 })).toBe(true)
  })

  it('is true within the threshold (subpixel / one growing line)', () => {
    expect(isAtBottom({ scrollTop: 790, scrollHeight: 1000, clientHeight: 200 })).toBe(true)
  })

  it('is false when scrolled up beyond the threshold', () => {
    expect(isAtBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 200 })).toBe(false)
  })

  it('respects a custom threshold', () => {
    expect(isAtBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 200 }, 100)).toBe(true)
    expect(isAtBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 200 }, 100)).toBe(false)
  })
})

describe('liveMenuCoversPending — JSONL e tela reais do claude 2.1.317', () => {
  const real = (name: string) =>
    readFileSync(
      join(__dirname, '../../../../shared/tui/__fixtures__', `claude-2.1.317-${name}`),
      'utf8',
    )

  it('plano pendente no JSONL + diálogo de plano vivo = o menu vivo responde', () => {
    const pending = pendingInteractive(parseChatMessages(real('plan-default.jsonl')))
    expect(pending).toEqual({ kind: 'plan', id: 'toolu_013zfPNQQ4TP4VVHVMLzMZ7q' })
    expect(liveMenuCoversPending(pending, parseTuiMenu(real('plan-default.txt'))?.kind)).toBe(true)
  })

  it('depois do Esc o plano não está mais pendente', () => {
    expect(pendingInteractive(parseChatMessages(real('plan-default-after-esc.jsonl')))).toBeNull()
  })

  it('pergunta pendente é coberta pela pergunta ou pela revisão, nunca pelo plano', () => {
    const q = { kind: 'question' as const, id: 'q' }
    expect(liveMenuCoversPending(q, 'question')).toBe(true)
    expect(liveMenuCoversPending(q, 'question_review')).toBe(true)
    expect(liveMenuCoversPending(q, 'plan')).toBe(false)
    expect(liveMenuCoversPending({ kind: 'plan', id: 'p' }, 'permission')).toBe(false)
    expect(liveMenuCoversPending(null, 'plan')).toBe(false)
  })
})
