import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PROJECTS_ROOT } from './transcript-path'

// Índice ccSessionId → transcript, pro caminho quente do grafo de sessões. O
// findTranscriptPath faz readdir + um existsSync por subdir de ~/.claude/projects;
// no rebuild do grafo (a cada ~300ms com sessão ativa) isso rodava pra toda sessão
// sem propósito. Aqui a consulta é um Map.get síncrono e a varredura é assíncrona,
// fora do rebuild: um miss só agenda uma (no máximo uma a cada 30s), e quem assina
// onGrow ouve os ids que apareceram pra reconstruir o grafo.
export const REFRESH_MIN_INTERVAL_MS = 30_000
// Quanto tempo uma sessão viva sem transcript mantém a varredura se reagendando.
export const WANT_TTL_MS = 10 * 60_000

export class TranscriptIndex {
  private paths = new Map<string, string>()
  private refreshedAt = Number.NEGATIVE_INFINITY
  private inflight: Promise<string[]> | null = null
  private listeners = new Set<(found: string[]) => void>()
  // Sessões vivas esperando o transcript nascer → desde quando.
  private wanted = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null

  // root resolvido só na varredura: importar este módulo não toca o PROJECTS_ROOT.
  constructor(
    private root: string | null = null,
    private now: () => number = () => Date.now(),
  ) {}

  lookup(ccSessionId: string): string | null {
    const hit = this.paths.get(ccSessionId)
    if (hit) return hit
    this.refreshSoon()
    return null
  }

  refreshSoon(): void {
    if (this.inflight || this.now() - this.refreshedAt < REFRESH_MIN_INTERVAL_MS) return
    void this.refresh()
  }

  // Devolve os ids que entraram no índice nesta varredura.
  refresh(): Promise<string[]> {
    this.inflight ??= this.scan().finally(() => {
      this.refreshedAt = this.now()
      this.inflight = null
    })
    return this.inflight
  }

  // Sessão viva sem transcript ainda: o rebuild do grafo só roda quando algo muda,
  // e uma sessão quieta não dispara nada — então a varredura se reagenda sozinha
  // (no ritmo do intervalo mínimo) até achar o arquivo ou o pedido expirar.
  want(ccSessionId: string): void {
    if (this.paths.has(ccSessionId)) return
    if (!this.wanted.has(ccSessionId)) this.wanted.set(ccSessionId, this.now())
    this.arm()
  }

  private arm(): void {
    if (this.timer) return
    const now = this.now()
    for (const [id, since] of this.wanted) {
      if (this.paths.has(id) || now - since >= WANT_TTL_MS) this.wanted.delete(id)
    }
    if (this.wanted.size === 0) return
    const wait = Math.max(0, REFRESH_MIN_INTERVAL_MS - (now - this.refreshedAt))
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh().then(() => this.arm())
    }, wait)
    this.timer.unref?.()
  }

  onGrow(listener: (found: string[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async scan(): Promise<string[]> {
    const root = this.root ?? PROJECTS_ROOT
    let dirs: string[]
    try {
      dirs = (await readdir(root, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return []
    }
    const found: string[] = []
    for (const dir of dirs) {
      let files: string[]
      try {
        files = await readdir(join(root, dir))
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const id = file.slice(0, -'.jsonl'.length)
        if (this.paths.has(id)) continue
        this.paths.set(id, join(root, dir, file))
        found.push(id)
      }
    }
    if (found.length > 0) for (const l of this.listeners) l(found)
    return found
  }
}

export const transcriptIndex = new TranscriptIndex()
