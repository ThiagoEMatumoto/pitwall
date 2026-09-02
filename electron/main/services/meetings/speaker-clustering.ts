// Agrupamento incremental de embeddings de voz dentro de uma reunião. Puro:
// sem sherpa, sem banco. Cada speaker é um centroide (média dos embeddings
// normalizados); um turno novo entra no centroide mais parecido se o cosseno
// passar do limiar, senão vira "Participante N" — e aí é comparado com as
// vozes conhecidas (reuniões anteriores renomeadas) pra já nascer com nome.
//
// Defaults calibrados com áudio real (TitaNet small, chunks de 12 s): a 0,6 o
// limiar fragmentava 1 voz em 2 e 2 em 4; a 0,4 acerta 1→1 e 2→2. E um rabicho
// de ~1 s no fim do chunk rendia embedding ruim o bastante pra virar speaker
// novo — só turnos ≥ 1,5 s criam speaker.

export const DEFAULT_THRESHOLD = 0.4
export const DEFAULT_MIN_TURN_SEC = 1.5

export interface KnownVoice {
  voiceId: string
  name: string
  embedding: Float32Array
}

export interface ClusterAssignment {
  speakerKey: string
  label: string
  isNew: boolean
  matchedVoiceId: string | null
}

export interface SpeakerCentroid {
  speakerKey: string
  label: string
  voiceId: string | null
  centroid: Float32Array
  turnCount: number
}

export interface MeetingClustererOptions {
  /** Cosseno mínimo pra cair num speaker existente. */
  threshold?: number
  /** Turnos mais curtos que isto nunca criam speaker (embedding pouco confiável). */
  minTurnSec?: number
  /** Cosseno mínimo pra um turno curto ainda ser atribuído. */
  shortTurnThreshold?: number
  /** Cosseno mínimo pra um speaker novo casar com uma voz conhecida. */
  knownThreshold?: number
  known?: KnownVoice[]
}

export interface MeetingClusterer {
  /** null = turno curto sem speaker parecido; quem chama decide o fallback. */
  assign(embedding: Float32Array, durationSec: number): ClusterAssignment | null
  centroids(): SpeakerCentroid[]
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  const norm = Math.sqrt(n)
  const out = new Float32Array(v.length)
  if (norm === 0) return out
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}

export function mean(vs: Float32Array[]): Float32Array {
  if (vs.length === 0) return new Float32Array(0)
  const out = new Float32Array(vs[0].length)
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i] += v[i]
  for (let i = 0; i < out.length; i++) out[i] /= vs.length
  return out
}

interface Cluster extends SpeakerCentroid {
  /** Soma (não normalizada) dos embeddings normalizados — o centroide é ela renormalizada. */
  sum: Float32Array
}

export function createMeetingClusterer(opts: MeetingClustererOptions = {}): MeetingClusterer {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const minTurnSec = opts.minTurnSec ?? DEFAULT_MIN_TURN_SEC
  const shortTurnThreshold = opts.shortTurnThreshold ?? 0.5
  const knownThreshold = opts.knownThreshold ?? 0.6
  const known = opts.known ?? []
  const clusters: Cluster[] = []
  const usedVoices = new Set<string>()

  function best(embedding: Float32Array): { cluster: Cluster; score: number } | null {
    let top: { cluster: Cluster; score: number } | null = null
    for (const cluster of clusters) {
      const score = cosine(embedding, cluster.centroid)
      if (!top || score > top.score) top = { cluster, score }
    }
    return top
  }

  function absorb(cluster: Cluster, embedding: Float32Array): void {
    for (let i = 0; i < cluster.sum.length; i++) cluster.sum[i] += embedding[i]
    cluster.centroid = normalize(cluster.sum)
    cluster.turnCount += 1
  }

  function matchKnown(embedding: Float32Array): KnownVoice | null {
    let top: { voice: KnownVoice; score: number } | null = null
    for (const voice of known) {
      if (usedVoices.has(voice.voiceId) || voice.embedding.length !== embedding.length) continue
      const score = cosine(embedding, voice.embedding)
      if (score >= knownThreshold && (!top || score > top.score)) top = { voice, score }
    }
    return top?.voice ?? null
  }

  return {
    assign(raw, durationSec) {
      const embedding = normalize(raw)
      const top = best(embedding)
      const short = durationSec < minTurnSec

      if (top && top.score >= (short ? shortTurnThreshold : threshold)) {
        // Turno curto não puxa o centroide: embedding de turno curto é ruidoso.
        if (!short) absorb(top.cluster, embedding)
        else top.cluster.turnCount += 1
        return {
          speakerKey: top.cluster.speakerKey,
          label: top.cluster.label,
          isNew: false,
          matchedVoiceId: null,
        }
      }
      if (short) return null

      const voice = matchKnown(embedding)
      if (voice) usedVoices.add(voice.voiceId)
      const cluster: Cluster = {
        speakerKey: `spk-${clusters.length + 1}`,
        label: voice ? voice.name : `Participante ${clusters.length + 1}`,
        voiceId: voice?.voiceId ?? null,
        sum: Float32Array.from(embedding),
        centroid: embedding,
        turnCount: 1,
      }
      clusters.push(cluster)
      return {
        speakerKey: cluster.speakerKey,
        label: cluster.label,
        isNew: true,
        matchedVoiceId: cluster.voiceId,
      }
    },
    centroids() {
      return clusters.map(({ speakerKey, label, voiceId, centroid, turnCount }) => ({
        speakerKey,
        label,
        voiceId,
        centroid: Float32Array.from(centroid),
        turnCount,
      }))
    },
  }
}
