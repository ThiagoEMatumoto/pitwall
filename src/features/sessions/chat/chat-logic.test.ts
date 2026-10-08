import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../../shared/types/ipc'
import {
  countUserMessages,
  isAtBottom,
  nextResolveAt,
  pendingEchoes,
  pendingInteractive,
  resolveChatViewState,
  resolveInteractive,
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
