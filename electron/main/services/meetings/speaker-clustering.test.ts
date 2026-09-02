import { describe, expect, it } from 'vitest'
import { cosine, createMeetingClusterer, mean, normalize } from './speaker-clustering'

const DIM = 8

function oneHot(i: number, scale = 1): Float32Array {
  const v = new Float32Array(DIM)
  v[i] = scale
  return v
}

// Vetor base + ruído determinístico pequeno: cosseno com a base ~0,95.
function noisy(base: Float32Array, seed: number, amount = 0.2): Float32Array {
  const out = Float32Array.from(base)
  for (let i = 0; i < out.length; i++) {
    const r = Math.sin(seed * 97 + i * 13) // pseudo-aleatório determinístico
    out[i] += r * amount * 0.5
  }
  return out
}

describe('cosine / normalize / mean', () => {
  it('cosseno de ortogonais é 0, de iguais é 1, de opostos é -1', () => {
    expect(cosine(oneHot(0), oneHot(1))).toBe(0)
    expect(cosine(oneHot(0), oneHot(0, 5))).toBeCloseTo(1)
    const neg = oneHot(0, -3)
    expect(cosine(oneHot(0), neg)).toBeCloseTo(-1)
  })

  it('cosseno de vetores vazios ou de tamanhos diferentes é 0 (não NaN)', () => {
    expect(cosine(new Float32Array(0), new Float32Array(0))).toBe(0)
    expect(cosine(oneHot(0), new Float32Array(3))).toBe(0)
    expect(cosine(new Float32Array(DIM), oneHot(1))).toBe(0)
  })

  it('normalize devolve norma 1 e não muta a entrada', () => {
    const v = oneHot(2, 4)
    const n = normalize(v)
    expect(v[2]).toBe(4)
    expect(n[2]).toBeCloseTo(1)
    expect(normalize(new Float32Array(DIM)).every((x) => x === 0)).toBe(true)
  })

  it('mean faz a média elemento a elemento', () => {
    const m = mean([oneHot(0, 2), oneHot(1, 2)])
    expect(Array.from(m.subarray(0, 2))).toEqual([1, 1])
    expect(mean([]).length).toBe(0)
  })
})

describe('createMeetingClusterer', () => {
  it('cria Participante 1, 2… para embeddings ortogonais', () => {
    const c = createMeetingClusterer()
    const a = c.assign(oneHot(0), 2)
    const b = c.assign(oneHot(1), 2)
    expect(a).toEqual({ speakerKey: 'spk-1', label: 'Participante 1', isNew: true, matchedVoiceId: null })
    expect(b).toEqual({ speakerKey: 'spk-2', label: 'Participante 2', isNew: true, matchedVoiceId: null })
  })

  it('embedding ruidoso do mesmo speaker cai no mesmo cluster e puxa o centroide', () => {
    const c = createMeetingClusterer()
    c.assign(oneHot(0), 2)
    for (let s = 1; s <= 5; s++) {
      const r = c.assign(noisy(oneHot(0), s), 2)
      expect(r?.speakerKey).toBe('spk-1')
      expect(r?.isNew).toBe(false)
    }
    const [only] = c.centroids()
    expect(c.centroids()).toHaveLength(1)
    expect(only.turnCount).toBe(6)
    expect(cosine(only.centroid, oneHot(0))).toBeGreaterThan(0.95)
  })

  it('respeita o threshold configurado', () => {
    const strict = createMeetingClusterer({ threshold: 0.99 })
    strict.assign(oneHot(0), 2)
    expect(strict.assign(noisy(oneHot(0), 1), 2)?.isNew).toBe(true)

    const loose = createMeetingClusterer({ threshold: 0.5 })
    loose.assign(oneHot(0), 2)
    expect(loose.assign(noisy(oneHot(0), 1), 2)?.isNew).toBe(false)
  })

  it('turno curto nunca cria speaker: sem cluster parecido devolve null', () => {
    const c = createMeetingClusterer()
    expect(c.assign(oneHot(0), 0.3)).toBeNull()
    expect(c.centroids()).toHaveLength(0)
    c.assign(oneHot(0), 2)
    expect(c.assign(oneHot(1), 0.3)).toBeNull()
    expect(c.centroids()).toHaveLength(1)
  })

  it('turno curto ainda é atribuído com cosseno ≥ 0,5, sem mover o centroide', () => {
    const c = createMeetingClusterer({ threshold: 0.9 })
    c.assign(oneHot(0), 2)
    const before = Float32Array.from(c.centroids()[0].centroid)
    // cos ≈ 0,71: abaixo do threshold normal (0,9), acima do de turno curto (0,5)
    const mixed = new Float32Array(DIM)
    mixed[0] = 1
    mixed[1] = 1
    expect(c.assign(mixed, 2)?.isNew).toBe(true)
    const r = c.assign(mixed, 0.3)
    expect(r?.speakerKey).toBeDefined()
    expect(r?.isNew).toBe(false)
    expect(Array.from(c.centroids()[0].centroid)).toEqual(Array.from(before))
  })

  it('speaker novo casa com voz conhecida e nasce com nome', () => {
    const c = createMeetingClusterer({
      known: [
        { voiceId: 'v-ana', name: 'Ana', embedding: oneHot(3) },
        { voiceId: 'v-bob', name: 'Bob', embedding: oneHot(4) },
      ],
    })
    const r = c.assign(noisy(oneHot(4), 2), 2)
    expect(r).toMatchObject({ label: 'Bob', isNew: true, matchedVoiceId: 'v-bob' })
    expect(c.assign(oneHot(0), 2)).toMatchObject({ label: 'Participante 2', matchedVoiceId: null })
    expect(c.centroids().map((x) => x.voiceId)).toEqual(['v-bob', null])
  })

  it('uma voz conhecida só é usada por um speaker na reunião', () => {
    const c = createMeetingClusterer({
      threshold: 0.99,
      known: [{ voiceId: 'v-ana', name: 'Ana', embedding: oneHot(3) }],
    })
    expect(c.assign(oneHot(3), 2)?.label).toBe('Ana')
    // parecido com a Ana (cos ~0,95) mas o threshold 0,99 força cluster novo
    const again = c.assign(noisy(oneHot(3), 1), 2)
    expect(again?.isNew).toBe(true)
    expect(again?.matchedVoiceId).toBeNull()
    expect(again?.label).toBe('Participante 2')
  })

  it('ignora voz conhecida com dimensão diferente', () => {
    const c = createMeetingClusterer({
      known: [{ voiceId: 'v', name: 'X', embedding: new Float32Array(3).fill(1) }],
    })
    expect(c.assign(oneHot(0), 2)?.label).toBe('Participante 1')
  })

  it('centroids() devolve cópias', () => {
    const c = createMeetingClusterer()
    c.assign(oneHot(0), 2)
    c.centroids()[0].centroid[0] = 99
    expect(c.centroids()[0].centroid[0]).toBeCloseTo(1)
  })
})
