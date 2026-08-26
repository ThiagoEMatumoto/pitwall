import { create } from 'zustand'
import { handoffsApi } from '@/lib/ipc'
import { showToast } from '@/features/notifications/toast-store'
import { dispatchHandoffChild, permissionModeFor } from '@/features/handoffs/spawn-child'
import { useAppStore } from './appStore'
import type { Handoff } from '../../shared/types/ipc'

// permissionModeFor mudou de casa (spawn-child.ts, junto do resto do nascimento
// da filha) e continua exportado daqui — é o import que o resto do renderer já usa.
export { permissionModeFor }

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

// A filha agora nasce no MAIN (MCP → spawnSession), sem passar pelo renderer —
// então nada aqui refresca liveSessions por conta do spawn. Este é o gancho: ao
// ver a transição pra running, puxa o snapshot vivo (a filha aparece no rollup) e
// avisa por TOAST em vez do antigo modal bloqueante. O alias vem de
// sessions.title (fixado no spawn); sem ele ainda no snapshot, cai no repo.
async function notifyDispatched(h: Handoff): Promise<void> {
  await useAppStore.getState().refreshLiveSessions()
  const child = useAppStore.getState().liveSessions.find((s) => s.id === h.childSessionId)
  const alias = child?.title?.trim() || null
  const repo = h.targetRepoLabel ?? h.targetRepoId
  showToast({
    title: alias ? `${alias} despachada → ${repo}` : `Handoff despachado → ${repo}`,
    body: h.task,
    actionLabel: child ? 'Abrir' : undefined,
    onAction: child ? () => void useAppStore.getState().focusOrOpenSession(child) : undefined,
  })
}

// Janela em que o "Desfazer" da dispensa fica à vista (mesmo tempo do Encerrar).
const DISMISS_UNDO_MS = 5000

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
  // Tira o handoff de vista no dock (carimba dismissedAt no banco). NÃO encerra a
  // filha nem muda o status — é decisão de exibição, não desfecho. Mostra um
  // toast com "Desfazer" (undismiss) — dispensar é reversível.
  dismiss: (id: string) => Promise<void>
  // Devolve o card ao dock (apaga o carimbo). É o que o "Desfazer" chama.
  undismiss: (id: string) => Promise<void>
  // Aprova o handoff (com o prompt possivelmente editado), resolve o repo-alvo e
  // entrega o nascimento da filha ao dispatch compartilhado (spawn em background
  // + mark-running). Erro no caminho vira `error` visível e handoff failed — não
  // deixa o handoff preso silenciosamente.
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

  dismiss: async (id) => {
    const handoff = get().handoffs.find((h) => h.id === id)
    try {
      await handoffsApi.dismiss(id)
      await get().load()
      // Undo SEM a janela de graça do endSession (appStore): lá o toast corre
      // contra um kill agendado, aqui não há efeito destrutivo esperando timer —
      // dispensar só carimba dismissed_at, e o undismiss desfaz isso a qualquer
      // momento. O toast é prazo de ATENÇÃO, não prazo de reversibilidade.
      const child = useAppStore
        .getState()
        .liveSessions.find((s) => s.id === handoff?.childSessionId)
      const who = child?.title?.trim() || handoff?.targetRepoLabel || 'A sessão-filha'
      showToast({
        title: 'Card dispensado',
        body: child ? `${who} continua rodando — só o card saiu do painel.` : who,
        actionLabel: 'Desfazer',
        onAction: () => void get().undismiss(id),
        durationMs: DISMISS_UNDO_MS,
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  undismiss: async (id) => {
    try {
      await handoffsApi.undismiss(id)
      await get().load()
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  approve: async (id, editedPrompt) => {
    const handoff = get().handoffs.find((h) => h.id === id)
    set({ error: null })
    try {
      // Aprovação e resolução do repo-alvo vão DENTRO do resolvePlan porque o
      // dispatch carimba failed pra qualquer erro dali pra frente — um handoff
      // aprovado sem filha é exatamente o estado preso que queremos evitar.
      await dispatchHandoffChild(id, async () => {
        await handoffsApi.approve({ id, composedPrompt: editedPrompt })
        const ctx = await handoffsApi.spawnContext(id)
        return {
          repoId: ctx.repo.id,
          alias: ctx.alias,
          // O prompt completo (editado pelo humano no gate) é o briefing da filha.
          systemPromptText: editedPrompt,
          featureId: handoff?.featureId ?? undefined,
          permissionMode: permissionModeFor(handoff?.mode ?? 'interactive'),
        }
      })
      await get().load()
    } catch (err) {
      // O carimbo de failed já saiu no dispatch; aqui só expõe o erro e recarrega.
      const msg = err instanceof Error ? err.message : String(err)
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
      if (updated) {
        // Notifica só na TRANSIÇÃO (estado anterior diferente), pra reconciliações
        // /rebroadcasts não re-notificarem o mesmo handoff.
        const prev = get().handoffs.find((h) => h.id === updated.id)
        const changed = prev?.status !== updated.status
        if (changed && (updated.status === 'done' || updated.status === 'failed')) {
          if (prev) notifyTerminal(updated)
        }
        // Despacho sem gate: prev pode nem existir (create+spawn no mesmo tick do
        // main), então a ausência de prev também conta como transição.
        if (changed && updated.status === 'running' && updated.childSessionId) {
          void notifyDispatched(updated)
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
//
// Handoff DISPENSADO não entra, mesmo vivo. Esconder a sessão daqui só se paga
// porque ela aparece no Crew Dock — e o dispensado não aparece (ver dockCrew).
// INVARIANTE: um handoff com filha viva nunca pode estar invisível em todas as
// superfícies ao mesmo tempo; sem esta cláusula, um card dispensado que depois
// ganhasse filha (ou a ganhasse por outro caminho que não o markRunning, que já
// limpa o carimbo) deixaria uma PTY rodando sem dock, sem barra e sem switcher.
export function childSessionIds(handoffs: Handoff[]): Set<string> {
  const ids = new Set<string>()
  for (const h of handoffs) {
    if (h.dismissedAt != null) continue
    if (h.childSessionId && ACTIVE_HANDOFF_STATUSES.has(h.status)) {
      ids.add(h.childSessionId)
    }
  }
  return ids
}
