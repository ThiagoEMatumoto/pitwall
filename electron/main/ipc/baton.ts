// Passagem de bastão: a sessão cujo contexto encheu não é encerrada nem retomada —
// uma sessão LIMPA sobe no mesmo repo/feature carregando o briefing destilado dela.
//
// Duas metades, dois handlers:
//   - `baton:distill` roda a destilação (claude -p) e devolve o texto pro humano EDITAR;
//   - `baton:pass` sobe a sucessora com o briefing JÁ APROVADO. Nunca destila de novo:
//     o texto que chega aqui é o que o humano leu e corrigiu, e re-destilar jogaria
//     a edição dele fora.
//
// A ANTECESSORA CONTINUA VIVA — decisão de produto. Nada aqui mata PTY: o humano
// encerra quando quiser (e é isso que cria o conflito de apelido tratado abaixo).
import { ipcMain } from 'electron'
import { getDb } from '../services/db'
import * as handoffStore from '../services/handoff-store'
import { broadcast } from '../services/notify'
import { buildHandoffAlias, roleForHandoffMode } from '../services/handoff/alias'
import { permissionModeForHandoffMode } from '../services/spawn-flags'
import { distillBaton } from '../services/baton/distill'
import { spawnSession, TERMINAL_HANDOFF_STATUSES } from './sessions'
import { notifyMotherOfAliasChange } from '../services/handoff/notify-mother-alias'
import type {
  DistillBatonInput,
  HandoffMode,
  HandoffStatus,
  PassBatonInput,
  PassBatonResult,
  SpawnSessionInput,
} from '../../../shared/types/ipc'

interface PredecessorRow {
  id: string
  repo_id: string | null
  cc_session_id: string | null
  title: string | null
  feature_id: string | null
}

interface InheritedHandoffRow {
  id: string
  status: string
  mode: string
  task: string
}

function predecessorRow(ccSessionId: string): PredecessorRow {
  const row = getDb()
    .prepare(
      `SELECT id, repo_id, cc_session_id, title, feature_id
         FROM sessions WHERE cc_session_id = ? ORDER BY started_at DESC LIMIT 1`,
    )
    .get(ccSessionId) as PredecessorRow | undefined
  if (!row) throw new Error(`Sessão não encontrada no Pitwall: ${ccSessionId}`)
  return row
}

// Handoff cujo papel a sucessora vai herdar: o vínculo mãe→filha mora SÓ em
// handoffs.child_session_id. Filtra dispensado (fora do Crew Dock) e, em JS,
// os status terminais — herdar um handoff já concluído ressuscitaria um card
// morto. Query local (mesmo padrão de findRelinkableHandoff em sessions.ts) pra
// não alargar a superfície do handoff-store.
function inheritedHandoff(predecessorSessionId: string): InheritedHandoffRow | null {
  const row = getDb()
    .prepare(
      `SELECT id, status, mode, task
         FROM handoffs
        WHERE child_session_id = ? AND dismissed_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .get(predecessorSessionId) as InheritedHandoffRow | undefined
  if (!row) return null
  if (TERMINAL_HANDOFF_STATUSES.has(row.status as HandoffStatus)) return null
  return row
}

// Escopo do apelido (`mauricio-auth-refactor` → `auth-refactor`). É o que a
// sucessora preserva quando precisa trocar de nome: quem olha o painel continua
// reconhecendo o TRABALHO, só o nome humano muda. Apelido legado sem hífen útil
// devolve null e o escopo é rederivado da task do handoff.
function aliasScope(alias: string | null): string | null {
  if (!alias) return null
  const rest = alias.trim().split('-').slice(1).join('-')
  return rest.length > 0 ? rest : null
}

export interface ResolvedAlias {
  alias: string
  changed: boolean
}

// O apelido é o ENDEREÇO do peer (`SendMessage({ to })`). Com a antecessora VIVA,
// reusar o apelido dela criaria dois PTYs no mesmo endereço — e a CLI passaria a
// desambiguar sozinha com hex ilegível, deixando a mãe falando com "algum dos dois".
//
// Renomear a antecessora pra liberar o nome NÃO resolve: `sessions:rename` só
// altera o SQLite, o `-n` do processo vivo continua o mesmo. O registro do Pitwall
// diria "liberado" enquanto o processo real ainda atende pelo nome — mentira que
// só apareceria na hora do SendMessage errado.
//
// Então: a sucessora DESAMBIGUA (mesmo escopo, próximo nome humano livre) e o
// endereço muda. Quando a antecessora já não está viva (o humano a encerrou antes),
// o apelido está livre e é reusado tal e qual.
export function resolveSuccessorAlias(args: {
  predecessorAlias: string | null
  mode: HandoffMode | null
  task: string
  takenNames: string[]
}): ResolvedAlias {
  const preferred = args.predecessorAlias?.trim() || null
  const taken = args.takenNames
  const isTaken = preferred
    ? taken.some((t) => t.trim().toLowerCase() === preferred.toLowerCase())
    : false
  if (preferred && !isTaken) return { alias: preferred, changed: false }

  const scope = aliasScope(preferred) ?? args.task
  return {
    alias: buildHandoffAlias({ role: roleForHandoffMode(args.mode), task: scope, taken }),
    changed: true,
  }
}

function buildKickoff(args: {
  task?: string
  handoffId: string | null
  alias: string | null
  aliasChanged: boolean
}): string {
  const parts = [
    'Você está assumindo o trabalho de uma sessão anterior cujo contexto encheu.',
    'O briefing dela está no seu system prompt (Estado atual, Decisões e porquês, Tentado e falhou,',
    'Arquivos em jogo, Próximo passo). Leia-o, confira o estado real do repositório antes de agir e',
    'execute o Próximo passo. Não reabra o que já foi decidido nem repita o que já falhou.',
  ]
  if (args.task?.trim()) {
    parts.push(`Instrução do humano para este começo: ${args.task.trim()}`)
  }
  if (args.handoffId) {
    parts.push(
      `Você assumiu o handoff handoffId="${args.handoffId}"; ao terminar, chame a MCP tool handoff_report com handoffId="${args.handoffId}".`,
    )
  }
  // A sessão precisa saber o próprio endereço quando ele muda: a antecessora
  // continua viva com o apelido antigo, e é a sucessora quem avisa a mãe.
  if (args.aliasChanged && args.alias) {
    parts.push(
      `Seu endereço de peer agora é "${args.alias}" — a sessão anterior continua viva com o apelido antigo. Se falar com a sessão-mãe, avise a troca.`,
    )
  }
  return parts.join(' ')
}

export function passBaton(input: PassBatonInput): PassBatonResult {
  const briefing = input.briefing?.trim()
  if (!briefing) {
    throw new Error(
      'Briefing vazio — a sucessora subiria cega. Destile ou escreva o briefing antes.',
    )
  }

  const predecessor = predecessorRow(input.ccSessionId)
  const handoffRow = inheritedHandoff(predecessor.id)

  // Só a filha de handoff carrega apelido fixo e `--settings` (o endereço de peer).
  // Sessão comum herda só repo/feature/briefing e nasce com o nome default do repo.
  const resolved = handoffRow
    ? resolveSuccessorAlias({
        predecessorAlias: predecessor.title,
        mode: handoffRow.mode as HandoffMode,
        task: handoffRow.task,
        takenNames: handoffStore.activeSessionNames(),
      })
    : null

  const session = spawnSession({
    repoId: predecessor.repo_id,
    featureId: predecessor.feature_id ?? undefined,
    name: resolved?.alias,
    // Cai no --append-system-prompt-file: o briefing é multi-linha e injetá-lo no
    // REPL viraria uma sequência de Enter.
    systemPromptText: briefing,
    initialPrompt: buildKickoff({
      task: input.task,
      handoffId: handoffRow?.id ?? null,
      alias: resolved?.alias ?? null,
      aliasChanged: resolved?.changed ?? false,
    }),
    // Herda o papel de filha: `--settings` (sem ele a mensagem da mãe fica `held`
    // em silêncio) + apelido espelhado em sessions.title como 'manual'.
    handoffChild: handoffRow != null,
    // Herda também as PERMISSÕES do modo do handoff. Sem isto a sucessora do
    // bastão subiria sem `--permission-mode` — uma filha em `plan` voltaria
    // podendo editar, e uma autônoma perderia o DESTRUCTIVE_DENYLIST (que o
    // spawnSession aplica a partir do modo, via resolveDisallowedTools).
    permissionMode: (permissionModeForHandoffMode(handoffRow?.mode) ??
      undefined) as SpawnSessionInput['permissionMode'],
    cols: input.cols,
    rows: input.rows,
  })

  if (!handoffRow) {
    return { session, handoff: null, alias: null, aliasChanged: false }
  }

  // Linhagem ANTES do relink: markRunning sobrescreve child_session_id, e é este
  // UPDATE que preserva de quem a sucessora recebeu o bastão.
  getDb()
    .prepare('UPDATE handoffs SET predecessor_session_id = ? WHERE id = ?')
    .run(predecessor.id, handoffRow.id)

  // Relink: sem isto a sucessora herdaria o lugar no painel sem herdar o endereço,
  // e a mãe continuaria falando com a antecessora (que está de saída).
  const updated = handoffStore.markRunning(handoffRow.id, session.id)
  broadcast('handoff:updated', updated)

  // Endereço novo → a mãe precisa saber, e saber SOZINHA. O aviso do diálogo
  // depende de o humano repassar; aqui a nota chega na mãe pelo mesmo caminho
  // que o handoff_message já usa. Best-effort de propósito: mãe encerrada não
  // é erro, e falhar aqui não pode desfazer um bastão que já deu certo.
  if (resolved?.changed && resolved.alias) {
    // try/catch porque a promessa acima ("não pode desfazer um bastão que já deu
    // certo") só vale se ela for verdade também quando o inesperado acontece: a
    // sucessora JÁ subiu e já foi relinkada, então uma exceção daqui rejeitaria
    // um baton:pass que funcionou — e o humano veria "não deu pra subir a
    // sucessora" com a sucessora rodando na tela.
    try {
      notifyMotherOfAliasChange({
        handoffId: handoffRow.id,
        alias: resolved.alias,
        previousAlias: predecessor.title,
      })
    } catch (err) {
      console.error('[baton] aviso de troca de apelido falhou:', err)
    }
  }

  return {
    session,
    handoff: updated,
    alias: resolved?.alias ?? null,
    aliasChanged: resolved?.changed ?? false,
  }
}

// Destilação sob demanda: enriquece o prompt com repo/feature da sessão (a
// sucessora sobe em algum lugar e o briefing precisa dizer qual). Falha de lookup
// não impede destilar — os rótulos são contexto, não requisito.
export async function distillForBaton(input: DistillBatonInput): Promise<string> {
  interface LabelsRow {
    repo_label: string | null
    feature_title: string | null
  }
  const row = getDb()
    .prepare(
      `SELECT r.label AS repo_label, f.title AS feature_title
         FROM sessions s
         LEFT JOIN repos r ON r.id = s.repo_id
         LEFT JOIN features f ON f.id = s.feature_id
        WHERE s.cc_session_id = ?
        ORDER BY s.started_at DESC LIMIT 1`,
    )
    .get(input.ccSessionId) as LabelsRow | undefined

  return distillBaton(input.ccSessionId, {
    repoLabel: row?.repo_label ?? null,
    featureTitle: row?.feature_title ?? null,
    note: input.note ?? null,
  })
}

export function registerBatonIpc(): void {
  ipcMain.handle('baton:distill', (_e, input: DistillBatonInput) => distillForBaton(input))
  ipcMain.handle('baton:pass', (_e, input: PassBatonInput) => passBaton(input))
}
