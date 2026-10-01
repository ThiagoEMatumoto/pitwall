/** @vitest-environment node */
// Resolução contínua com o feature-store REAL (DB em tmp): leitura que falha não
// solta o vínculo, feature criada depois do spawn é casada, o fuzzy espera o 1º
// prompt e rascunho oculto não vira card.
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'feature-session-live-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

const seam = vi.hoisted(() => ({
  running: [] as string[],
  // cc_session_id → cwd do session file (ausente = arquivo sumiu).
  cwd: new Map<string, string>(),
  // cc_session_id → cauda do transcript.
  tail: new Map<string, string>(),
  firstPrompt: new Map<string, string>(),
  size: 0,
  broadcasts: [] as Array<{ sessionId: string; featureId: string | null }>,
}))

vi.mock('./pty-manager', () => ({ ptyManager: { runningIds: () => seam.running } }))
vi.mock('./notify', () => ({
  broadcast: (channel: string, p: { sessionId: string; featureId: string | null }) => {
    if (channel === 'session:feature-changed') seam.broadcasts.push(p)
  },
}))
vi.mock('./session-activity', () => ({
  buildSessionsFileIndex: () => new Map([...seam.cwd].map(([cc, cwd]) => [cc, { cwd }])),
  readTailSync: (path: string) => seam.tail.get(path.replace('/t/', '')) ?? '',
}))
vi.mock('./transcript-index', () => ({
  transcriptIndex: { lookup: (cc: string) => (seam.tail.has(cc) ? `/t/${cc}` : null) },
}))
vi.mock('./session-purpose', () => ({
  readFirstPrompt: (cc: string) => seam.firstPrompt.get(cc) ?? null,
}))
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return {
    ...real,
    statSync: (p: string) =>
      p.startsWith('/t/') ? { mtimeMs: 1, size: ++seam.size } : real.statSync(p),
  }
})

import { app } from 'electron'
import { closeDb, getDb } from './db'
import { create as createFeature, setRepos } from './feature-store'
import { resolveLiveSessionFeatures } from './feature-session-live'

const line = (branch: string) => `{"type":"assistant","gitBranch":"${branch}","x":1}\n`

function addSession(id: string, cc: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, 'repo-1', ?, 'running', 1)`,
    )
    .run(id, cc)
  seam.running.push(id)
}

const featureOf = (id: string) =>
  (
    getDb().prepare('SELECT feature_id FROM sessions WHERE id = ?').get(id) as {
      feature_id: string | null
    }
  ).feature_id

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

let n = 0
beforeEach(() => {
  getDb().exec('DELETE FROM sessions; DELETE FROM feature_repos; DELETE FROM features;')
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)',
    )
    .run('proj-1', 'Loja')
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO repos (id, project_id, label, path, position, created_at) VALUES ('repo-1','proj-1','api','/r/api',0,1)`,
    )
    .run()
  seam.running = []
  seam.cwd.clear()
  seam.tail.clear()
  seam.firstPrompt.clear()
  seam.broadcasts = []
  n += 1
})

describe('resolveLiveSessionFeatures', () => {
  it('cauda sem gitBranch (tool_result grande) não solta o vínculo por branch', () => {
    const s = `s-tail-${n}`
    const cc = `cc-tail-${n}`
    const f = createFeature({ projectId: 'proj-1', title: 'Checkout E2E' })
    setRepos(f.id, [{ repoId: 'repo-1', branch: 'feat/checkout', worktreePath: null }])
    addSession(s, cc)
    seam.cwd.set(cc, '/r/api')
    seam.tail.set(cc, line('feat/checkout'))
    resolveLiveSessionFeatures()
    expect(featureOf(s)).toBe(f.id)

    seam.tail.set(cc, `{"type":"user","content":"${'x'.repeat(200)}"}\n`)
    seam.cwd.delete(cc)
    resolveLiveSessionFeatures()
    expect(featureOf(s)).toBe(f.id)
    expect(seam.broadcasts).toHaveLength(1)
  })

  it('trocar para uma branch sem feature (sinal LIDO) ainda solta', () => {
    const s = `s-swap-${n}`
    const cc = `cc-swap-${n}`
    const f = createFeature({ projectId: 'proj-1', title: 'Checkout E2E' })
    setRepos(f.id, [{ repoId: 'repo-1', branch: 'feat/checkout', worktreePath: null }])
    addSession(s, cc)
    seam.tail.set(cc, line('feat/checkout'))
    resolveLiveSessionFeatures()
    seam.tail.set(cc, line('feat/outra'))
    resolveLiveSessionFeatures()
    expect(featureOf(s)).toBeNull()
  })

  it('voltar da feat/* para a main solta (a feat/* antiga ainda na cauda não segura o vínculo)', () => {
    const s = `s-main-${n}`
    const cc = `cc-main-${n}`
    const f = createFeature({ projectId: 'proj-1', title: 'Checkout volta' })
    setRepos(f.id, [{ repoId: 'repo-1', branch: 'feat/checkout-volta', worktreePath: null }])
    addSession(s, cc)
    seam.tail.set(cc, line('feat/checkout-volta'))
    resolveLiveSessionFeatures()
    expect(featureOf(s)).toBe(f.id)
    seam.tail.set(cc, [line('feat/checkout-volta'), line('main')].join('\n'))
    resolveLiveSessionFeatures()
    expect(featureOf(s)).toBeNull()
  })

  it('feature criada DEPOIS do spawn, com a branch da sessão, é casada no tick seguinte', () => {
    const s = `s-late-${n}`
    const cc = `cc-late-${n}`
    addSession(s, cc)
    seam.tail.set(cc, line('feat/late'))
    resolveLiveSessionFeatures()
    expect(featureOf(s)).toBeNull()

    // Posição salva no card "Sem feature": relativa à lane antiga.
    getDb()
      .prepare(
        `INSERT INTO canvas_positions (scope, kind, entity_id, x, y) VALUES ('all', 'session', ?, 12, 40)`,
      )
      .run(s)
    const f = createFeature({ projectId: 'proj-1', title: 'Chegou tarde' })
    setRepos(f.id, [{ repoId: 'repo-1', branch: 'feat/late', worktreePath: null }])
    resolveLiveSessionFeatures()
    expect(featureOf(s)).toBe(f.id)
    // Trocou de card: a posição antiga cairia em cima dos cartões do card novo.
    const left = getDb()
      .prepare(`SELECT x FROM canvas_positions WHERE kind = 'session' AND entity_id = ?`)
      .all(s)
    expect(left).toEqual([])
  })

  it('fuzzy: 1º prompt ilegível no 1º tick é reavaliado quando chega', () => {
    const s = `s-fuzzy-${n}`
    const cc = `cc-fuzzy-${n}`
    const f = createFeature({ projectId: 'proj-1', title: 'arruma o cache de sessao' })
    addSession(s, cc)
    seam.cwd.set(cc, '/r/api')
    resolveLiveSessionFeatures()
    expect(featureOf(s)).toBeNull()

    seam.firstPrompt.set(cc, 'arruma o cache de sessao do checkout')
    resolveLiveSessionFeatures()
    expect(featureOf(s)).toBe(f.id)
  })

  it('rascunho oculto (auto, sem registro) não recebe a sessão pela branch', () => {
    const s = `s-draft-${n}`
    const cc = `cc-draft-${n}`
    const f = createFeature({ projectId: 'proj-1', title: 'Rascunho', origin: 'auto' })
    setRepos(f.id, [{ repoId: 'repo-1', branch: 'feat/draft', worktreePath: null }])
    addSession(s, cc)
    seam.tail.set(cc, line('feat/draft'))
    resolveLiveSessionFeatures()
    expect(featureOf(s)).toBeNull()
  })
})
