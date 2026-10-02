import { describe, expect, it } from 'vitest'
import {
  EdgePulseStore,
  PULSE_MAX_TRAIN,
  PULSE_PING_MS,
  PULSE_SPACING_MS,
  PULSE_TRAVEL_MS,
  arcPath,
  pulseDirection,
  pulseFraction,
  pulsePairKey,
} from './edge-pulse-store'

function makeStore() {
  let now = 10_000
  const timers: Array<{ at: number; fn: () => void }> = []
  const store = new EdgePulseStore(
    () => now,
    (fn, ms) => timers.push({ at: now + ms, fn }),
  )
  const advance = (ms: number) => {
    now += ms
    for (const t of timers.splice(0)) t.at <= now ? t.fn() : timers.push(t)
  }
  return { store, advance }
}

const pulse = (id: string, from = 'mae', to = 'filha') => ({
  id,
  fromSessionId: from,
  toSessionId: to,
  kind: 'message' as const,
})

describe('EdgePulseStore', () => {
  it('progresso e nota pulsam sem trocar o anúncio do leitor de tela', () => {
    const { store } = makeStore()
    store.add({ ...pulse('a', 'filha', 'mae'), kind: 'report', label: 'otavio → mae: entrega' })
    store.add({ ...pulse('b', 'filha', 'mae'), kind: 'progress', label: 'otavio → mae: progresso' })
    store.add({ ...pulse('c', 'mae', 'filha'), kind: 'note', label: 'mae → otavio: nota' })
    expect(store.lastLabel()).toBe('otavio → mae: entrega')
    expect(store.pulsesFor(pulsePairKey('mae', 'filha'))).toHaveLength(3)
  })

  it('pulsos no mesmo par formam um trem espaçado, nos dois sentidos', () => {
    const { store } = makeStore()
    store.add(pulse('a'))
    store.add(pulse('b', 'filha', 'mae'))
    store.add(pulse('c'))
    const list = store.pulsesFor(pulsePairKey('mae', 'filha'))
    expect(list.map((p) => p.startAt)).toEqual([
      10_000,
      10_000 + PULSE_SPACING_MS,
      10_000 + 2 * PULSE_SPACING_MS,
    ])
    expect(list[1]).toMatchObject({ from: 'filha', to: 'mae' })
  })

  it('cada pulso some depois do trajeto + ping; o trem esvazia', () => {
    const { store, advance } = makeStore()
    store.add(pulse('a'))
    store.add(pulse('b'))
    const key = pulsePairKey('mae', 'filha')
    advance(PULSE_TRAVEL_MS + PULSE_PING_MS)
    expect(store.pulsesFor(key).map((p) => p.id)).toEqual(['b'])
    advance(PULSE_SPACING_MS)
    expect(store.pulsesFor(key)).toHaveLength(0)
  })

  it('trem tem teto e não duplica o mesmo id', () => {
    const { store } = makeStore()
    for (let i = 0; i < PULSE_MAX_TRAIN + 3; i++) store.add(pulse(`p${i}`))
    store.add(pulse('p0'))
    expect(store.pulsesFor(pulsePairKey('mae', 'filha'))).toHaveLength(PULSE_MAX_TRAIN)
  })

  it('só o par afetado é notificado, com snapshot estável', () => {
    const { store } = makeStore()
    let hitsAB = 0
    let hitsCD = 0
    store.subscribePair(pulsePairKey('a', 'b'), () => hitsAB++)
    store.subscribePair(pulsePairKey('c', 'd'), () => hitsCD++)
    store.add(pulse('x', 'a', 'b'))
    expect([hitsAB, hitsCD]).toEqual([1, 0])
    const snap = store.pulsesFor(pulsePairKey('a', 'b'))
    expect(store.pulsesFor(pulsePairKey('b', 'a'))).toBe(snap)
    expect(store.pulsesFor(pulsePairKey('c', 'd'))).toBe(store.pulsesFor(pulsePairKey('e', 'f')))
  })

  it('par sem fio montado vira órfão (arco temporário); com fio, não', () => {
    const { store } = makeStore()
    store.add(pulse('x', 'a', 'b'))
    expect(store.orphans().map((p) => p.id)).toEqual(['x'])
    expect(store.orphans()).toBe(store.orphans())
    const release = store.claim(pulsePairKey('b', 'a'), 'e:h:1')
    expect(store.orphans()).toHaveLength(0)
    release()
    expect(store.orphans().map((p) => p.id)).toEqual(['x'])
  })

  it('dois fios no mesmo par: só o primeiro desenha; ao sair, passa ao seguinte', () => {
    const { store } = makeStore()
    const key = pulsePairKey('a', 'b')
    let hits = 0
    store.subscribePair(key, () => hits++)
    const releaseH = store.claim(key, 'e:h:1')
    store.claim(key, 'e:a:9')
    expect(store.ownerOf(key)).toBe('e:h:1')
    releaseH()
    expect(store.ownerOf(key)).toBe('e:a:9')
    expect(hits).toBe(3)
  })
})

describe('direção e trajeto', () => {
  it('pulso da filha para a mãe num fio mãe→filha anda ao contrário', () => {
    expect(pulseDirection('mae', { from: 'mae' })).toBe('forward')
    expect(pulseDirection('mae', { from: 'filha' })).toBe('reverse')
  })

  it('fração parte da ponta de origem e pousa na de destino, com easing', () => {
    expect(pulseFraction(0, 'forward')).toBe(0)
    expect(pulseFraction(PULSE_TRAVEL_MS, 'forward')).toBe(1)
    expect(pulseFraction(0, 'reverse')).toBe(1)
    expect(pulseFraction(PULSE_TRAVEL_MS, 'reverse')).toBe(0)
    expect(pulseFraction(PULSE_TRAVEL_MS / 2, 'forward')).toBeCloseTo(0.5)
    // Arranque macio: no primeiro décimo andou bem menos que um décimo.
    expect(pulseFraction(PULSE_TRAVEL_MS / 10, 'forward')).toBeLessThan(0.02)
    expect(pulseFraction(PULSE_TRAVEL_MS * 3, 'forward')).toBe(1)
  })

  it('arco temporário liga as duas pontas e estufa para fora da reta', () => {
    const d = arcPath({ x: 0, y: 0 }, { x: 200, y: 0 })
    expect(d.startsWith('M 0 0 Q ')).toBe(true)
    expect(d.endsWith(' 200 0')).toBe(true)
    const cy = Number(d.split(' ')[5])
    expect(Math.abs(cy)).toBeGreaterThan(20)
  })
})
