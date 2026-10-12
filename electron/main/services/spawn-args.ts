// Flags do spawn de uma sessão, gravadas em sessions.spawn_args (migration 061) e
// reaplicadas no resume da mesma conversa. Guarda os valores já resolvidos; quem
// relança passa de novo pelas whitelists (resolve*), como o spawn.
import type Database from 'better-sqlite3'
import {
  handoffChildSettingsJson,
  resolveAdvisor,
  resolveDisallowedTools,
  resolveEffort,
  resolveModel,
  resolvePermissionMode,
} from './spawn-flags'

export interface SpawnArgs {
  model: string | null
  effort: string | null
  advisorModel: string | null
  permissionMode: string | null
  disallowedTools: string[] | null
  // Texto livre do chamador (briefing do handoff, instruções da mãe). O bloco de
  // arquitetura/feature é remontado no resume, não guardado.
  systemPromptText: string | null
  // Filha de handoff: relança com o --settings dela.
  handoffChild: boolean
  // Diretório efetivo do spawn, carimbado pelo startSession (quem chama não passa).
  cwd?: string | null
}

export interface RelaunchFlags {
  model: string | null
  effort: string | null
  advisorModel: string | null
  permissionMode: string | null
  disallowedTools: string[] | null
  settingsJson: string | null
  systemPromptText: string | null
}

const NO_FLAGS: RelaunchFlags = {
  model: null,
  effort: null,
  advisorModel: null,
  permissionMode: null,
  disallowedTools: null,
  settingsJson: null,
  systemPromptText: null,
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export function parseSpawnArgs(raw: string | null): SpawnArgs | null {
  if (!raw) return null
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null) return null
  const r = o as Record<string, unknown>
  return {
    model: str(r.model),
    effort: str(r.effort),
    advisorModel: str(r.advisorModel),
    permissionMode: str(r.permissionMode),
    disallowedTools: Array.isArray(r.disallowedTools)
      ? r.disallowedTools.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : null,
    systemPromptText: str(r.systemPromptText),
    handoffChild: r.handoffChild === true,
    cwd: str(r.cwd),
  }
}

// Linha mais recente da conversa com flags gravadas (cada resume abre uma linha).
export function latestSpawnArgs(db: Database.Database, ccSessionId: string): SpawnArgs | null {
  const row = db
    .prepare(
      `SELECT spawn_args FROM sessions
        WHERE cc_session_id = ? AND spawn_args IS NOT NULL
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(ccSessionId) as { spawn_args: string } | undefined
  return parseSpawnArgs(row?.spawn_args ?? null)
}

// Flags do relançamento, revalidadas como no spawn. Sem registro (sessão de antes
// da 061, ou nunca spawnada pelo Pitwall), relança como antes: sem flags.
export function relaunchFlags(args: SpawnArgs | null): RelaunchFlags {
  if (!args) return NO_FLAGS
  const permissionMode = resolvePermissionMode(args.permissionMode)
  return {
    model: resolveModel(args.model),
    effort: resolveEffort(args.effort),
    advisorModel: resolveAdvisor(args.advisorModel),
    permissionMode,
    disallowedTools: resolveDisallowedTools(permissionMode, args.disallowedTools, {
      handoffChild: args.handoffChild,
    }),
    settingsJson: args.handoffChild ? handoffChildSettingsJson(permissionMode) : null,
    systemPromptText: args.systemPromptText,
  }
}
