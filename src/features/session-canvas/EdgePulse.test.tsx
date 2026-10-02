import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { DIMMED_PULSE_OPACITY, ORPHAN_LAYER_STYLE, PulseTrain } from './EdgePulse'
import { CARD_Z } from './graph-to-flow'
import type { ActivePulse } from './edge-pulse-store'

vi.mock('@/lib/ipc', () => ({ sessionGraphApi: {} }))

const pulse = (over: Partial<ActivePulse>): ActivePulse => ({
  id: 'p1',
  from: 'mae',
  to: 'filha',
  kind: 'message',
  startAt: performance.now(),
  ...over,
})

function setReduced(reduced: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: reduced && q.includes('reduce'),
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

// jsdom não mede path: sem isto o pulso nunca "chega" e o ping nunca aparece.
function measurePaths() {
  const proto = window.SVGElement.prototype as unknown as Record<string, unknown>
  proto.getTotalLength = () => 200
  proto.getPointAtLength = (l: number) => ({ x: l, y: 0 })
  return () => {
    delete proto.getTotalLength
    delete proto.getPointAtLength
  }
}

function renderPinged(dimmed: boolean) {
  const rect = { x: 200, y: -20, w: 100, h: 40 }
  return render(
    <svg>
      <PulseTrain
        d="M 0 0 L 200 0"
        sourceSessionId="mae"
        pulses={[pulse({ startAt: performance.now() - 60_000 })]}
        rects={{ filha: rect }}
        dimmed={dimmed}
      />
    </svg>,
  )
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 120))
  })

function renderTrain(pulses: ActivePulse[]) {
  return render(
    <svg>
      <PulseTrain d="M 0 0 L 200 0" sourceSessionId="mae" pulses={pulses} rects={{}} />
    </svg>,
  )
}

afterEach(() => setReduced(false))

describe('PulseTrain', () => {
  it('fio mãe→filha: pulso da mãe anda para a frente, o da filha ao contrário', () => {
    setReduced(false)
    const { container } = renderTrain([
      pulse({ id: 'ida' }),
      pulse({ id: 'volta', from: 'filha', to: 'mae', kind: 'report' }),
    ])
    const ida = container.querySelector('[data-edge-pulse][data-pulse-id="ida"]')!
    const volta = container.querySelector('[data-edge-pulse][data-pulse-id="volta"]')!
    expect(ida.getAttribute('data-direction')).toBe('forward')
    expect(volta.getAttribute('data-direction')).toBe('reverse')
    expect(volta.getAttribute('data-from')).toBe('filha')
    expect(volta.getAttribute('data-to')).toBe('mae')
    // Cada pulso anda sobre o MESMO path do fio.
    expect(volta.querySelector('path')!.getAttribute('d')).toBe('M 0 0 L 200 0')
    // Cor pelo tipo, só tokens do tema.
    expect(volta.querySelector('[data-edge-pulse-head]')!.getAttribute('fill')).toBe(
      'var(--color-success)',
    )
  })

  it('prefers-reduced-motion: sem bolinha, só o flash do fio', () => {
    setReduced(true)
    const { container } = renderTrain([pulse({ kind: 'question' })])
    expect(container.querySelector('[data-edge-pulse]')).toBeNull()
    const flash = container.querySelector('[data-edge-pulse-flash]')!
    expect(flash.getAttribute('d')).toBe('M 0 0 L 200 0')
    expect(flash.getAttribute('stroke')).toBe('var(--color-warning)')
  })

  // Foco num cartão apaga os outros fios: o trem deles passa apagado e sem ping.
  it('fio esmaecido: trem a baixa opacidade e sem ping no destino', async () => {
    setReduced(false)
    const restore = measurePaths()
    try {
      const lit = renderPinged(false)
      await settle()
      // Controle: com o path medido, o pulso pousa e o ping aparece.
      expect(lit.container.querySelector('[data-edge-ping]')).not.toBeNull()
      lit.unmount()

      const { container } = renderPinged(true)
      const g = container.querySelector<SVGGElement>('.edge-pulse-train')!
      expect(g.style.opacity).toBe(String(DIMMED_PULSE_OPACITY))
      await settle()
      expect(container.querySelector('[data-edge-ping]')).toBeNull()
    } finally {
      restore()
    }
  })

  // O fio corre por baixo de cartões no caminho: a bolinha vai na camada de cima
  // (parts="dots"), o fio aceso fica na dos fios (parts="wire").
  it('camadas: fio aceso embaixo, bolinha em cima; sem movimento, o flash fica no fio', () => {
    const one = (parts: 'wire' | 'dots') =>
      render(
        <svg>
          <PulseTrain
            d="M 0 0 L 200 0"
            sourceSessionId="mae"
            pulses={[pulse({})]}
            rects={{}}
            parts={parts}
          />
        </svg>,
      ).container
    setReduced(false)
    const wire = one('wire')
    expect(wire.querySelector('.edge-pulse-wire')).not.toBeNull()
    expect(wire.querySelector('[data-edge-pulse]')).toBeNull()
    const dots = one('dots')
    expect(dots.querySelector('.edge-pulse-wire')).toBeNull()
    expect(dots.querySelector('[data-edge-pulse]')).not.toBeNull()
    setReduced(true)
    expect(one('wire').querySelector('[data-edge-pulse-flash]')).not.toBeNull()
    expect(one('dots').querySelector('.edge-pulse-train')).toBeNull()
  })

  it('sem pulsos não desenha nada', () => {
    const { container } = renderTrain([])
    expect(container.querySelector('.edge-pulse-train')).toBeNull()
  })
})

describe('arco de par sem fio', () => {
  it('fica abaixo dos cartões: fio nunca sobe acima de cartão', () => {
    expect(ORPHAN_LAYER_STYLE.zIndex).toBeLessThan(CARD_Z)
  })
})
