import { describe, expect, it, vi } from 'vitest'
import { formatCombo } from '@/lib/keybindings'

vi.mock('@/lib/ipc', () => ({
  sessionGraphApi: { get: vi.fn(() => new Promise(() => {})), onUpdated: vi.fn(() => () => {}) },
  handoffsApi: {},
}))

import {
  currentGraphNode,
  sessionLinkKeyAction,
  stepSessionLink,
  useSessionLinkHudStore,
} from './session-link-nav'
import { useSessionGraphStore } from './session-graph-store'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { useAttentionStore } from '@/features/session-switcher/useAttentionQueue'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'
import type { SessionGraph, SessionGraphNode } from '../../../shared/types/session-graph'

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

function node(sessionId: string, over: Partial<SessionGraphNode> = {}): SessionGraphNode {
  return {
    sessionId,
    ccSessionId: `cc-${sessionId}`,
    title: sessionId,
    projectId: null,
    repoId: null,
    repoLabel: null,
    provider: 'claude',
    status: 'idle',
    attentionReason: null,
    lastActivityAt: null,
    purposeHint: null,
    childOfHandoffId: null,
    ...over,
  }
}

function keyOn(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const e = key(init)
  Object.defineProperty(e, 'target', { value: target })
  return e
}

describe('sessionLinkKeyAction', () => {
  it('Alt+,/Alt+. por code (layout-independente)', () => {
    expect(sessionLinkKeyAction(key({ altKey: true, code: 'Comma' }), {}, 'projects')).toBe('prev')
    expect(sessionLinkKeyAction(key({ altKey: true, code: 'Period' }), {}, 'projects')).toBe('next')
  })

  // No 2.1.286 meta+←/→ é pular palavra no prompt: a tecla tem que chegar no claude.
  it('Alt+←/→ NÃO é o atalho (fica pro claude)', () => {
    expect(
      sessionLinkKeyAction(key({ altKey: true, code: 'ArrowLeft' }), {}, 'projects'),
    ).toBeNull()
    expect(
      sessionLinkKeyAction(key({ altKey: true, code: 'ArrowRight' }), {}, 'projects'),
    ).toBeNull()
  })

  it('tecla sem Alt, ou com Ctrl/Shift junto, não é o atalho', () => {
    expect(sessionLinkKeyAction(key({ code: 'Comma' }), {}, 'projects')).toBeNull()
    const ctrl = key({ altKey: true, ctrlKey: true, code: 'Comma' })
    expect(sessionLinkKeyAction(ctrl, {}, 'projects')).toBeNull()
    const shift = key({ altKey: true, shiftKey: true, code: 'Period' })
    expect(sessionLinkKeyAction(shift, {}, 'projects')).toBeNull()
  })

  it('em campo de texto do app a tecla fica pro campo; no xterm continua capturada', () => {
    const composer = document.createElement('textarea')
    const input = document.createElement('input')
    const xterm = document.createElement('textarea')
    xterm.className = 'xterm-helper-textarea'
    const next = { altKey: true, code: 'Period' }
    expect(sessionLinkKeyAction(keyOn(composer, next), {}, 'sessions')).toBeNull()
    expect(sessionLinkKeyAction(keyOn(input, next), {}, 'sessions')).toBeNull()
    expect(sessionLinkKeyAction(keyOn(xterm, next), {}, 'sessions')).toBe('next')
  })

  it('cede a tecla na área de Design (atalhos do canvas)', () => {
    expect(sessionLinkKeyAction(key({ altKey: true, code: 'Comma' }), {}, 'design')).toBeNull()
  })

  it('o <kbd> mostra a pontuação, não o nome do code', () => {
    expect(formatCombo({ alt: true, code: 'Comma' })).toBe('Alt+,')
    expect(formatCombo({ alt: true, code: 'Period' })).toBe('Alt+.')
  })

  it('respeita o remapeamento do usuário', () => {
    const overrides = { 'session.linkNext': { alt: true, code: 'KeyL' } }
    expect(sessionLinkKeyAction(key({ altKey: true, code: 'KeyL' }), overrides, 'projects')).toBe(
      'next',
    )
    const period = key({ altKey: true, code: 'Period' })
    expect(sessionLinkKeyAction(period, overrides, 'projects')).toBeNull()
  })
})

describe('currentGraphNode', () => {
  const graph: SessionGraph = {
    nodes: [node('tab'), node('kid', { childOfHandoffId: 'h1' })],
    lanes: [],
    edges: [],
  }

  it('com o quick look aberto, a atual é a filha espiada (o peek cobre a aba)', () => {
    expect(currentGraphNode(graph, { activeCc: 'cc-tab', peekId: 'h1' })?.sessionId).toBe('kid')
  })

  it('sem peek, é a aba ativa', () => {
    expect(currentGraphNode(graph, { activeCc: 'cc-tab', peekId: null })?.sessionId).toBe('tab')
    expect(currentGraphNode(graph, { activeCc: 'cc-x', peekId: null })).toBeNull()
  })
})

describe('stepSessionLink', () => {
  // Filha de handoff concluído com a PTY encerrada continua no grafo (só o dispensar
  // tira), mas não abre nada: não pode ser destino, senão o Alt+. trava nela.
  it('pula a filha encerrada de handoff concluído e chega na filha viva', () => {
    const edge = (to: string, handoffId: string, createdAt: number) => ({
      kind: 'handoff' as const,
      from: 'M',
      to,
      handoffId,
      handoffStatus: 'running' as const,
      currentStep: null,
      createdAt,
    })
    useSessionGraphStore.setState({
      graph: {
        nodes: [
          node('M'),
          node('filha1', { status: 'ended', childOfHandoffId: 'h1' }),
          node('filha2', { status: 'working', childOfHandoffId: 'h2' }),
        ],
        lanes: [],
        edges: [edge('filha1', 'h1', 1), edge('filha2', 'h2', 2)],
      },
    })
    useHandoffsStore.setState({
      handoffs: [
        { id: 'h1', status: 'done', dismissedAt: null } as Handoff,
        { id: 'h2', status: 'running', dismissedAt: null } as Handoff,
      ],
    })
    useAppStore.setState({ liveSessions: [{ ccSessionId: 'cc-M' } as LiveSessionInfo] })
    useAttentionStore.setState({ activeCc: 'cc-M' })

    stepSessionLink(1)

    expect(useCrewDockStore.getState().peekId).toBe('h2')
    expect(useSessionLinkHudStore.getState().flash).toMatchObject({
      node: { sessionId: 'filha2' },
      position: 2,
      total: 2,
    })
  })
})
