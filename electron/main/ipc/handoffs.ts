import { ipcMain } from 'electron'
import { z } from 'zod'
import * as store from '../services/handoff-store'
import { getDb } from '../services/db'
import { broadcast } from '../services/notify'
import { ptyManager } from '../services/pty-manager'
import { injectIntoChild } from '../services/handoff/inject'
import { buildHandoffAlias, roleForHandoffMode } from '../services/handoff/alias'
import type { HandoffSpawnContext, LinkKind, Handoff, HandoffStatus, Repo } from '../../../shared/types/ipc'

interface RepoJoinRow {
  id: string
  project_id: string
  label: string
  path: string
  role: string | null
  link_kind: string
  source: string | null
  position: number
  created_at: number
  canvas_x: number | null
  canvas_y: number | null
  is_hub: number
  project_name: string
  project_icon: string | null
  project_color: string | null
}

function toRepo(row: RepoJoinRow): Repo {
  return {
    id: row.id,
    projectId: row.project_id,
    label: row.label,
    path: row.path,
    role: row.role,
    linkKind: row.link_kind as LinkKind,
    source: row.source,
    position: row.position,
    createdAt: row.created_at,
    canvasX: row.canvas_x ?? null,
    canvasY: row.canvas_y ?? null,
    isHub: row.is_hub === 1,
  }
}

const handoffStatus = z.enum([
  'pending',
  'approved',
  'running',
  'needs_input',
  'done',
  'rejected',
  'failed',
  'interrupted',
])

const listSchema = z
  .object({
    status: z.union([handoffStatus, z.array(handoffStatus)]).optional(),
  })
  .optional()

const approveSchema = z.object({
  id: z.string().min(1),
  composedPrompt: z.string().optional(),
})

const markRunningSchema = z.object({
  id: z.string().min(1),
  childSessionId: z.string().min(1),
})

const failSchema = z.object({
  id: z.string().min(1),
  error: z.string().min(1),
})

const sendMessageSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
})

const setOutcomeSchema = z.object({
  id: z.string().min(1),
  outcome: z.enum(['useful', 'wrong', 'partial']),
})

export function registerHandoffsIpc(): void {
  ipcMain.handle('handoffs:list', (_e, raw: unknown): Handoff[] => {
    const opts = listSchema.parse(raw)
    return store.list(opts as { status?: HandoffStatus | HandoffStatus[] } | undefined)
  })

  ipcMain.handle('handoffs:get', (_e, id: string): Handoff | null => {
    return store.get(id)
  })

  ipcMain.handle('handoffs:approve', (_e, raw: unknown): Handoff => {
    const { id, composedPrompt } = approveSchema.parse(raw)
    const handoff = store.approve(id, { composedPrompt })
    broadcast('handoff:updated', handoff)
    return handoff
  })

  ipcMain.handle('handoffs:reject', (_e, id: string): Handoff => {
    const handoff = store.reject(id)
    broadcast('handoff:updated', handoff)
    return handoff
  })

  ipcMain.handle('handoffs:mark-running', (_e, raw: unknown): Handoff => {
    const { id, childSessionId } = markRunningSchema.parse(raw)
    const handoff = store.markRunning(id, childSessionId)
    broadcast('handoff:updated', handoff)
    return handoff
  })

  // Falha de spawn/aprovação: marca o handoff como failed com o erro visível no inbox.
  ipcMain.handle('handoffs:fail', (_e, raw: unknown): Handoff => {
    const { id, error } = failSchema.parse(raw)
    const handoff = store.fail(id, error)
    broadcast('handoff:updated', handoff)
    return handoff
  })

  // Intervenção do humano pelo inbox: entrega uma mensagem (texto livre OU resposta
  // a um handoff_ask) à sessão-filha. Resolve o childSessionId pelo handoffId,
  // exige PTY viva (isRunning) e injeta via injectIntoChild — bracketed-paste com
  // submit, NÃO sessions:write cru (que não submeteria). Entregue o texto, a
  // pergunta pendente se encerra AQUI (needs_input → running): este é o caminho da
  // mãe respondendo, e é o único que fecha o bloqueio — handoff_progress preserva
  // needs_input de propósito. Idempotente fora de needs_input (mensagem avulsa
  // para uma filha running não muda nada).
  ipcMain.handle('handoffs:send-message', (_e, raw: unknown): void => {
    const { id, text } = sendMessageSchema.parse(raw)
    const handoff = store.get(id)
    if (!handoff) throw new Error(`Handoff não encontrado: ${id}`)
    if (!handoff.childSessionId) {
      throw new Error('Handoff ainda não tem sessão-filha (não aprovado).')
    }
    if (!ptyManager.isRunning(handoff.childSessionId)) {
      throw new Error('A sessão-filha não está mais viva — não há para onde enviar.')
    }
    injectIntoChild(handoff.childSessionId, text)
    broadcast('handoff:updated', store.resume(id))
  })

  // Feedback humano (👍/👎/parcial) sobre a utilidade de um handoff concluído.
  // Persiste o outcome e loga um evento 'feedback' na trilha (instrumentação).
  ipcMain.handle('handoffs:set-outcome', (_e, raw: unknown): Handoff => {
    const { id, outcome } = setOutcomeSchema.parse(raw)
    const handoff = store.setOutcome(id, outcome)
    broadcast('handoff:updated', handoff)
    return handoff
  })

  // Resolve o repo-alvo + metadados do projeto pra UI conseguir chamar openSession.
  ipcMain.handle('handoffs:spawn-context', (_e, id: string): HandoffSpawnContext => {
    const handoff = store.get(id)
    if (!handoff) throw new Error(`Handoff não encontrado: ${id}`)
    const row = getDb()
      .prepare(
        `SELECT r.*, p.name AS project_name, p.icon AS project_icon, p.color AS project_color
         FROM repos r JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(handoff.targetRepoId) as RepoJoinRow | undefined
    if (!row) throw new Error(`Repo-alvo do handoff não encontrado: ${handoff.targetRepoId}`)
    // Alias resolvido AQUI (e não no create) porque a unicidade é contra as
    // sessões vivas AGORA. Determinístico para o mesmo (papel, task, ocupados) —
    // o mesmo alias que o briefing já anunciou à filha, salvo colisão nova.
    const alias = buildHandoffAlias({
      role: roleForHandoffMode(handoff.mode),
      task: handoff.task,
      taken: store.activeSessionNames(),
    })
    return {
      repo: toRepo(row),
      projectName: row.project_name,
      projectIcon: row.project_icon ?? null,
      projectColor: row.project_color ?? null,
      alias,
    }
  })
}
