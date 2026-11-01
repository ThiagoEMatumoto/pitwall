import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useRef } from 'react'
import { CHAT_MIN_WIDTH, PANEL_MIN_WIDTH } from './artifactPanelStore'
import { useSidePanelFits } from './useSidePanelFits'

// O mesmo ChatView monta na área da sessão e em colunas estreitas (MotherDock,
// RoomMotherPane, CrewPeek lift); o painel lembrado por sessão não pode
// esmagar a conversa nessas colunas.

let observers: Array<{ cb: ResizeObserverCallback; el: Element | null }> = []
const original = globalThis.ResizeObserver

beforeEach(() => {
  observers = []
  globalThis.ResizeObserver = class {
    private entry: { cb: ResizeObserverCallback; el: Element | null }
    constructor(cb: ResizeObserverCallback) {
      this.entry = { cb, el: null }
      observers.push(this.entry)
    }
    observe(el: Element) {
      this.entry.el = el
    }
    unobserve() {}
    disconnect() {
      this.entry.el = null
    }
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  globalThis.ResizeObserver = original
})

function resize(px: number): void {
  for (const o of observers) {
    if (!o.el) continue
    Object.defineProperty(o.el, 'clientWidth', { configurable: true, get: () => px })
    o.cb([], {} as ResizeObserver)
  }
}

function Host({ initial }: { initial: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const fits = useSidePanelFits(ref)
  return (
    <div
      ref={(el) => {
        ;(ref as { current: HTMLDivElement | null }).current = el
        if (el) Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => initial })
      }}
    >
      {fits ? 'fits' : 'narrow'}
    </div>
  )
}

describe('useSidePanelFits', () => {
  it('coluna estreita (dock da mãe) não abre o painel ao lado', () => {
    render(<Host initial={420} />)
    expect(screen.getByText('narrow')).toBeTruthy()
  })

  it('área da sessão larga abre, e volta a fechar quando a coluna encolhe', () => {
    render(<Host initial={PANEL_MIN_WIDTH + CHAT_MIN_WIDTH + 200} />)
    expect(screen.getByText('fits')).toBeTruthy()
    act(() => resize(PANEL_MIN_WIDTH + CHAT_MIN_WIDTH - 1))
    expect(screen.getByText('narrow')).toBeTruthy()
    act(() => resize(PANEL_MIN_WIDTH + CHAT_MIN_WIDTH))
    expect(screen.getByText('fits')).toBeTruthy()
  })
})
