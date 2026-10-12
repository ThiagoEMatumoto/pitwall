// Settings do `claude` POR SESSÃO, entregues como ARQUIVO (`--settings <path>`).
//
// Por que arquivo e não JSON inline: o argv do processo é público (/proc/<pid>/cmdline)
// e `pkill -f <padrão>` casa a cmdline inteira. Com o deny inline, um `pkill -f cat`
// de qualquer sessão matava toda sessão do Pitwall cujo argv carregava `Bash(cat:*)`.
// No arquivo, o argv fica só com o path.
//
// Mesma base e mesmo ciclo de vida do mcp-config por sessão (mcp/config.ts):
// <userData>/session-settings/<sessions.id>.json, escrito antes do spawn, removido
// no exit da PTY e varrido no boot.
import { app } from 'electron'
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SessionSettings {
  crossSessionInbound?: string
  permissions?: {
    allow?: string[]
    ask?: string[]
    deny?: string[]
  }
}

export function sessionSettingsDir(): string {
  return join(app.getPath('userData'), 'session-settings')
}

export function sessionSettingsPath(sessionId: string, dir: string = sessionSettingsDir()): string {
  return join(dir, `${sessionId}.json`)
}

// Junta o settings base (o da filha de handoff, ou nada) com o denylist resolvido
// do spawn. `permissions.deny` no settings tem o mesmo efeito do `--disallowedTools`
// (verificado com claude 2.1.296: ambos negam mesmo com allow casando), então o
// denylist inteiro passa a viver aqui. null = nada a entregar → sem `--settings`.
export function buildSessionSettings(
  base: SessionSettings | null,
  deny: readonly string[] | null,
): SessionSettings | null {
  const mergedDeny = Array.from(new Set([...(base?.permissions?.deny ?? []), ...(deny ?? [])]))
  if (!base && mergedDeny.length === 0) return null
  const settings: SessionSettings = { ...(base ?? {}) }
  if (base?.permissions || mergedDeny.length > 0) {
    settings.permissions = { ...(base?.permissions ?? {}), deny: mergedDeny }
  }
  return settings
}

// Gravação atômica (tmp + rename): o claude nunca lê um arquivo pela metade.
// Arquivo 0600, diretório 0700 — é a política de permissões da sessão.
export function writeSessionSettings(
  sessionId: string,
  settings: SessionSettings,
  dir: string = sessionSettingsDir(),
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = sessionSettingsPath(sessionId, dir)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  return path
}

// Best-effort, chamado no exit da PTY junto com removeSessionMcpConfig.
export function removeSessionSettings(sessionId: string, dir: string = sessionSettingsDir()): void {
  try {
    rmSync(sessionSettingsPath(sessionId, dir), { force: true })
  } catch {
    // ignora
  }
}

// Varredura de boot: nenhuma PTY sobrevive ao quit, então tudo que sobrou é órfão
// (inclui .tmp de uma gravação interrompida).
export function sweepSessionSettings(dir: string = sessionSettingsDir()): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue
    try {
      rmSync(join(dir, name), { force: true })
      removed++
    } catch {
      // segue varrendo os demais
    }
  }
  return removed
}
