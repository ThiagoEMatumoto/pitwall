import type { AgentProviderId, Session } from '../../../../shared/types/ipc'
import { getDb } from '../db'
import { inheritFeatureId } from '../feature-session-resolver'

// Seam leaf (sem electron) pro spawn da sessão-filha disparado direto pelo MCP.
// A implementação real é spawnSession (ipc/sessions.ts, que puxa electron + PTY);
// importá-la em mcp/tools.ts fecharia o ciclo tools → ipc/sessions → mcp/server →
// tools e arrastaria electron pros testes de tools. Mesma motivação e mesmo
// padrão de job-run-now.ts; registerSessionIpc() registra a impl no boot.

export interface SpawnHandoffChildInput {
  repoId: string
  // Alias da filha: vira o `-n <name>` e, por tabela, o endereço do SendMessage.
  name: string
  featureId?: string | null
  // Quem despachou: sem featureId explícito a filha nasce na feature dela.
  motherSessionId?: string | null
  // Prompt posicional (1º turno auto-submetido).
  initialPrompt: string
  // Prompt composto do handoff, entregue via --append-system-prompt-file.
  systemPromptText: string
  permissionMode?: string | null
  // CLI da filha. Ausente = claude.
  provider?: AgentProviderId
  // O cwd da filha é o work_dir deste handoff.
  handoffId: string
}

type SpawnHandoffChildFn = (input: SpawnHandoffChildInput) => Session

let impl: SpawnHandoffChildFn | null = null

export function setSpawnHandoffChild(fn: SpawnHandoffChildFn): void {
  impl = fn
}

// Lança se o IPC de sessões ainda não registrou a impl (ex.: ambiente de teste
// que não carrega electron) — falha explícita, nunca silenciosa.
export function spawnHandoffChild(input: SpawnHandoffChildInput): Session {
  if (!impl) {
    throw new Error('spawn de sessão-filha indisponível: o IPC de sessões não foi inicializado')
  }
  return impl({ ...input, featureId: inheritFeatureId(input.featureId, motherFeatureOf(input)) })
}

function motherFeatureOf(input: SpawnHandoffChildInput): string | null {
  if (input.featureId || !input.motherSessionId) return null
  const row = getDb()
    .prepare('SELECT feature_id FROM sessions WHERE id = ?')
    .get(input.motherSessionId) as { feature_id: string | null } | undefined
  return row?.feature_id ?? null
}
