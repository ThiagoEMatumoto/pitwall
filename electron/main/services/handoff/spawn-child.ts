import type { Session } from '../../../../shared/types/ipc'

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
  // Prompt posicional (1º turno auto-submetido).
  initialPrompt: string
  // Prompt composto do handoff, entregue via --append-system-prompt-file.
  systemPromptText: string
  permissionMode?: string | null
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
  return impl(input)
}
