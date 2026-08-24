// Nascimento de uma sessão-filha de handoff no renderer: spawn em background →
// mark-running → carimbo de failed se algo no caminho quebrar.
//
// Vive aqui (e não dentro do handoffsStore) porque a sequência tem DOIS donos: o
// gate de aprovação (handoffsStore.approve) e a criação manual pelo diálogo de
// nova sessão. Duplicar a sequência seria duplicar o tratamento de erro — a parte
// que ninguém lembra de manter em dia nos dois lugares.

import { handoffsApi } from '@/lib/ipc'
import { useAppStore } from '@/store/appStore'
import type { HandoffMode, PermissionMode } from '../../../shared/types/ipc'

// Mapeia o modo do handoff → permissionMode do spawn (o main valida contra
// whitelist e, em acceptEdits, mescla o denylist destrutivo canônico sozinho —
// o renderer NÃO monta disallowedTools). 'interactive' = sem permissionMode
// (comportamento legado: o claude pergunta cada ação). Pura → testável.
export function permissionModeFor(mode: HandoffMode): PermissionMode | undefined {
  switch (mode) {
    case 'plan':
      return 'plan'
    case 'auto-edits':
      return 'acceptEdits'
    case 'interactive':
    default:
      return undefined
  }
}

// Caminho inverso, usado na criação MANUAL: o diálogo de nova sessão já pede a
// permissão da sessão, então o modo do handoff é derivado dela em vez de virar um
// segundo controle dizendo quase a mesma coisa. O modo importa por dois motivos —
// é ele que escolhe o papel (e portanto o nome) do apelido e as restrições do
// briefing. bypassPermissions não tem modo próprio: cai em interactive (o spawn
// continua recebendo o bypass; é só o rótulo do handoff que não o expressa).
export function handoffModeForPermission(permission: PermissionMode): HandoffMode {
  switch (permission) {
    case 'plan':
      return 'plan'
    case 'acceptEdits':
      return 'auto-edits'
    default:
      return 'interactive'
  }
}

// O 1º turno REAL da filha, entregue como prompt posicional no comando de spawn
// (`claude "<kickoff>"` auto-submete) — não colado no PTY, que em background é
// descartado sem resize do TUI. O briefing completo vai por outro caminho
// (arquivo de system-prompt), pra sobreviver íntegro e multi-linha.
export function handoffKickoff(handoffId: string): string {
  return `Comece a tarefa do handoff descrita no seu contexto de sistema. Ao terminar, chame a MCP tool handoff_report com handoffId="${handoffId}".`
}

export interface HandoffChildPlan {
  repoId: string
  // Alias `<nome>-<escopo>` resolvido no main (único contra as sessões vivas). É
  // o `-n <name>` do spawn e, por tabela, o endereço do SendMessage — nada de
  // `handoff: <repo>`, que colide e vira hex.
  alias: string
  // Briefing completo da filha (o mesmo texto persistido em composed_prompt).
  systemPromptText: string
  featureId?: string | null
  permissionMode?: PermissionMode
}

// Spawna a filha em background e devolve o sessions.id dela.
//
// O plano chega por callback de propósito: tudo que o chamador precisa fazer
// ANTES do spawn (aprovar o handoff, resolver o repo-alvo, criar o registro) roda
// DENTRO da mesma guarda — assim um erro na preparação carimba o handoff como
// failed igual a um erro de spawn, em vez de deixá-lo preso sem filha.
export async function dispatchHandoffChild(
  handoffId: string,
  resolvePlan: () => HandoffChildPlan | Promise<HandoffChildPlan>,
): Promise<string> {
  try {
    const plan = await resolvePlan()
    // Background spawn: a filha sobe SEM abrir pane/xterm. Vira só um chip no
    // painel lateral (abrível sob demanda).
    const childSessionId = await useAppStore.getState().spawnSessionBackground({
      repoId: plan.repoId,
      name: plan.alias,
      featureId: plan.featureId ?? undefined,
      initialPrompt: handoffKickoff(handoffId),
      systemPromptText: plan.systemPromptText,
      permissionMode: plan.permissionMode,
      handoffChild: true,
    })
    await handoffsApi.markRunning({ id: handoffId, childSessionId })
    return childSessionId
  } catch (err) {
    // Marca o handoff como failed (erro visível no inbox) em vez de deixá-lo
    // preso em approved/pending sem filha. O erro original segue subindo.
    const msg = err instanceof Error ? err.message : String(err)
    try {
      await handoffsApi.fail({ id: handoffId, error: msg })
    } catch {
      // fail() também falhou (IPC indisponível): resta propagar o erro original.
    }
    throw err
  }
}
