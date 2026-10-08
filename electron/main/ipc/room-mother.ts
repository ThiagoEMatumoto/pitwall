import { statSync } from 'node:fs'
import { ipcMain } from 'electron'
import { z } from 'zod'
import { getDb } from '../services/db'
import { get as getFeature } from '../services/feature-store'
import { setSessionPurpose } from '../services/canvas-store'
import { getMcpRuntime } from '../services/mcp/server'
import { buildMotherRolePrompt } from '../services/mother-role-prompt'
import { broadcast } from '../services/notify'
import { resolveRepoPath } from '../services/repo-path'
import { resolveFeatureWorktree } from '../services/work-dir'
import { spawnSession } from './sessions'
import type {
  MotherPreflight,
  MotherPreflightRepo,
  StartMotherInput,
  StartMotherResult,
} from '../../../shared/types/feature-room'
import type { EffortLevel } from '../../../shared/types/ipc'

// Prefixo estável: o renderer recebe "Error invoking remote method …: Error:
// MCP_NOT_READY: …" e casa pelo código; o resto é o texto para o humano.
export const MCP_NOT_READY = 'MCP_NOT_READY'
export const MCP_BLOCK_REASON =
  'O servidor MCP do Pitwall não subiu: a mãe nasceria sem session_handoff/handoff_* e não conseguiria delegar. Reinicie o Pitwall para religar o MCP e tente de novo.'

const startMotherSchema = z.object({
  featureId: z.string().min(1),
  repoId: z.string().min(1),
  purpose: z.string().trim().min(1).max(500),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
})

const preflightSchema = z.object({
  featureId: z.string().min(1),
  repoId: z.string().min(1).nullable().optional(),
})

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function repoPreflight(featureId: string, repoId: string): MotherPreflightRepo {
  const row = getDb().prepare('SELECT path, label FROM repos WHERE id = ?').get(repoId) as
    { path: string; label: string } | undefined
  if (!row) return { repoId, label: repoId, valid: false, hasWorktree: false, cwd: null }
  const repoPath = resolveRepoPath(row.path)
  const valid = isDir(repoPath)
  const worktree = resolveFeatureWorktree(featureId, repoId)
  return {
    repoId,
    label: row.label,
    valid,
    hasWorktree: worktree !== null,
    cwd: worktree ?? (valid ? repoPath : null),
  }
}

export function motherPreflight(featureId: string, repoId?: string | null): MotherPreflight {
  const feature = getFeature(featureId)
  const mcpReady = getMcpRuntime() !== null
  return {
    featureExists: feature !== null,
    mcpReady,
    mcpBlockReason: mcpReady ? null : MCP_BLOCK_REASON,
    repos: (feature?.repos ?? []).map((r) => repoPreflight(featureId, r.repoId)),
    repo: repoId ? repoPreflight(featureId, repoId) : null,
    suggestedPurpose: feature ? feature.objective?.trim() || feature.title : null,
    ccSessionIdAtSpawn: true,
  }
}

export function startMother(raw: unknown): StartMotherResult {
  const t0 = performance.now()
  const input: StartMotherInput = startMotherSchema.parse(raw) as StartMotherInput
  // Recusa antes de qualquer efeito: sem MCP a sessão não tem as tools de
  // delegação, e uma "mãe" que não delega não é mãe.
  if (!getMcpRuntime()) throw new Error(`${MCP_NOT_READY}: ${MCP_BLOCK_REASON}`)
  if (!getFeature(input.featureId)) throw new Error(`feature not found: ${input.featureId}`)
  // Mesma regra do spawnSession (worktree da feature > raiz do repo); o Session
  // devolvido não carrega o cwd.
  const { cwd } = repoPreflight(input.featureId, input.repoId)

  const session = spawnSession({
    repoId: input.repoId,
    featureId: input.featureId,
    name: `mãe · ${input.purpose.slice(0, 40)}`,
    systemPromptText: buildMotherRolePrompt({ purpose: input.purpose }),
    model: input.model ?? undefined,
    effort: (input.effort as EffortLevel | null | undefined) ?? undefined,
    // Codex é forçado para o modo terminal; a mãe da Room conversa pelo chat.
    provider: 'claude',
  })
  setSessionPurpose(session.id, input.purpose)
  const ccSessionIdReadyMs = Math.round(performance.now() - t0)
  console.info(
    `[room-mother] started ${session.id} for feature ${input.featureId}: ccSessionId=${session.ccSessionId ?? 'null'} after ${ccSessionIdReadyMs}ms`,
  )
  broadcast('room:changed', { featureId: input.featureId })
  return {
    sessionId: session.id,
    ccSessionId: session.ccSessionId ?? null,
    cwd: cwd ?? '',
    ccSessionIdReadyMs,
  }
}

export function registerRoomMotherIpc(): void {
  ipcMain.handle('room:mother-preflight', (_e, featureId: unknown, repoId?: unknown) => {
    const input = preflightSchema.parse({ featureId, repoId: repoId ?? null })
    return motherPreflight(input.featureId, input.repoId)
  })
  ipcMain.handle('room:start-mother', (_e, raw: unknown) => startMother(raw))
}
