import { create } from 'zustand'
import { handoffsApi } from '@/lib/ipc'
import { useAppStore } from './appStore'
import type { Handoff, HandoffMode, PermissionMode } from '../../shared/types/ipc'

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

// O payload de handoff:updated é o Handoff atualizado; tipamos defensivamente
// (a assinatura IPC é `unknown`) e validamos o shape mínimo antes de usar.
function asHandoff(payload: unknown): Handoff | null {
  if (payload && typeof payload === 'object' && 'id' in payload && 'status' in payload) {
    return payload as Handoff
  }
  return null
}

// Notificação nativa do renderer quando um handoff transiciona pra done/failed.
// Best-effort: se a API de Notification não existir/permissão negada, ignora.
function notifyTerminal(h: Handoff): void {
  const repo = h.targetRepoLabel ?? h.targetRepoId
  const verb = h.status === 'done' ? 'done' : 'failed'
  try {
    new Notification(`Handoff ${repo}: ${verb}`, {
      body: h.status === 'failed' && h.error ? h.error : h.task,
    })
  } catch {
    // Notification indisponível (ambiente sem suporte/permissão) — no-op.
  }
}

// Dono único da assinatura de onUpdated — assinada uma vez (StrictMode-safe),
// mesmo padrão do objectivesStore.
let offUpdated: (() => void) | null = null
let updatedStarted = false

interface HandoffsState {
  handoffs: Handoff[]
  loading: boolean
  error: string | null

  load: () => Promise<void>
  reject: (id: string) => Promise<void>
  // Aprova o handoff (com o prompt possivelmente editado), resolve o repo-alvo,
  // spawna a sessão-filha via openSession do appStore e marca mark-running com o
  // id da sessão criada. Erro de spawn vira `error` visível (não deixa o handoff
  // preso silenciosamente).
  approve: (id: string, editedPrompt: string) => Promise<void>

  startUpdatedWatch: () => void
  stopUpdatedWatch: () => void
}

export const useHandoffsStore = create<HandoffsState>((set, get) => ({
  handoffs: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null })
    try {
      const handoffs = await handoffsApi.list()
      set({ handoffs, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  reject: async (id) => {
    try {
      await handoffsApi.reject(id)
      await get().load()
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  approve: async (id, editedPrompt) => {
    const handoff = get().handoffs.find((h) => h.id === id)
    set({ error: null })
    try {
      await handoffsApi.approve({ id, composedPrompt: editedPrompt })
      const ctx = await handoffsApi.spawnContext(id)
      // O prompt completo (editado) vai por arquivo de system-prompt (íntegro,
      // multi-linha); o kickoff abaixo vira o 1º turno REAL da filha, entregue como
      // prompt posicional no comando de spawn (`claude "<kickoff>"` auto-submete) —
      // não colado no PTY, que em background é descartado sem resize do TUI.
      const kickoff = `Comece a tarefa do handoff descrita no seu contexto de sistema. Ao terminar, chame a MCP tool handoff_report com handoffId="${id}".`
      // Background spawn: a filha sobe SEM abrir pane/xterm. Vira só um chip no
      // rollup (abrível sob demanda). O modo do handoff vira permissionMode.
      const childSessionId = await useAppStore.getState().spawnSessionBackground({
        repoId: ctx.repo.id,
        // Alias `<nome>-<escopo>` resolvido no main (único contra as sessões
        // vivas). É o `-n <name>` do spawn e, por tabela, o endereço do
        // SendMessage — nada de `handoff: <repo>`, que colide e vira hex.
        name: ctx.alias,
        featureId: handoff?.featureId ?? undefined,
        initialPrompt: kickoff,
        systemPromptText: editedPrompt,
        permissionMode: permissionModeFor(handoff?.mode ?? 'interactive'),
        handoffChild: true,
      })
      await handoffsApi.markRunning({ id, childSessionId })
      await get().load()
    } catch (err) {
      // Spawn/approve falhou: marca o handoff como failed (erro visível no inbox)
      // em vez de deixá-lo preso em approved sem filha. Mostra o erro e recarrega.
      const msg = err instanceof Error ? err.message : String(err)
      try {
        await handoffsApi.fail({ id, error: msg })
      } catch {
        // fail() também falhou (IPC indisponível): só exibe o erro no store.
      }
      set({ error: msg })
      await get().load()
      throw err
    }
  },

  startUpdatedWatch: () => {
    if (updatedStarted) return
    updatedStarted = true
    offUpdated = handoffsApi.onUpdated((payload) => {
      const updated = asHandoff(payload)
      if (updated && (updated.status === 'done' || updated.status === 'failed')) {
        // Notifica só na TRANSIÇÃO pra terminal (estado anterior != done/failed),
        // pra reconciliações/rebroadcasts não re-notificarem o mesmo handoff.
        const prev = get().handoffs.find((h) => h.id === updated.id)
        if (prev && prev.status !== updated.status) {
          notifyTerminal(updated)
        }
      }
      void get().load()
    })
  },

  stopUpdatedWatch: () => {
    if (offUpdated) {
      offUpdated()
      offUpdated = null
    }
    updatedStarted = false
  },
}))

// Derivado: handoffs pendentes (aguardando gate humano). Recebe a lista crua —
// NÃO use como selector zustand (filter retorna array novo a cada chamada → loop
// de re-render no v5). Derive com useMemo no componente sobre `handoffs`.
export function pendingHandoffs(handoffs: Handoff[]): Handoff[] {
  return handoffs.filter((h) => h.status === 'pending')
}

// Status de handoff cuja filha está "viva e sob a alçada do rollup" — não deve
// poluir a lista flat de sessões (o usuário monitora as não-filhas + o rollup).
// pending/approved não têm filha ainda (childSessionId null), mas inclui-los é
// inócuo; running e needs_input são os casos reais (filha viva: trabalhando ou
// aguardando a mãe). done/failed/rejected liberam a sessão de volta.
export const ACTIVE_HANDOFF_STATUSES: ReadonlySet<Handoff['status']> = new Set([
  'pending',
  'approved',
  'running',
  'needs_input',
])

// Conjunto de Session.id que são filhas de handoffs ativos. Pura → testável e
// reusável pelo strip/switcher (esconder) e pelo rollup (exibir compacto).
export function childSessionIds(handoffs: Handoff[]): Set<string> {
  const ids = new Set<string>()
  for (const h of handoffs) {
    if (h.childSessionId && ACTIVE_HANDOFF_STATUSES.has(h.status)) {
      ids.add(h.childSessionId)
    }
  }
  return ids
}
