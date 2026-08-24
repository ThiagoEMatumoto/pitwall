// Resumo de fim de turno: a borda working → waiting/idle (hook do
// session-activity) dispara a leitura do transcript; se o turno terminou em texto
// de assistant (permission prompts também disparam a borda — esses NÃO resumem),
// o texto vira 2-3 frases via claude -p e sai por broadcast('voice:summary').
// Gate de custo: o resumo automático só roda pra sessões que o usuário ligou
// individualmente (Set em memória — o toggle vive na barra do composer); o
// resumo sob demanda (summarizeNow) ignora o gate porque é ação explícita.
import { createHash } from 'node:crypto'
import type { ChatMessage } from '../../../shared/types/chat'
import type { VoiceSummarizeNowResult, VoiceSummaryEvent } from '../../../shared/types/ipc'
import { chatTranscriptService } from './chat-transcript-service'
import { runClaude, TEXT_ONLY_CLAUDE_ARGS } from './claude-cli'
import { stripCodeFence } from './feature-digest'
import { broadcast } from './notify'

const SUMMARY_TIMEOUT_MS = 60_000
// Haiku: resumo curto de texto já pronto — latência e custo importam mais.
const SUMMARY_MODEL = 'haiku'
// A borda de status pode chegar um instante antes do último append no JSONL;
// o settle dá tempo do texto final pousar e coalesce disparos repetidos.
export const SETTLE_MS = 750

export const SUMMARY_INSTRUCTION = `Você resume a última resposta de um agente de programação (Claude) para um engenheiro brasileiro que acompanha a sessão por voz, sem olhar a tela.

Regras:
- 2 a 3 frases em português, direto ao ponto;
- diga o RESULTADO: o que o Claude fez, encontrou ou concluiu;
- se o Claude precisa de algo do usuário (decisão, resposta, aprovação), diga isso explicitamente;
- NÃO invente nada que não esteja no texto;
- responda SÓ com o resumo, sem preâmbulo nem cerca de código.

Resposta do Claude:
`

// Texto assistant do último turno: só quando a ÚLTIMA mensagem é texto de
// assistant (turno terminou falando com o usuário). Última mensagem tool_use /
// ask_user_question / exit_plan_mode = sessão esperando permissão ou resposta
// estruturada — não é fim de resposta, não resume. Anda pra trás até a fronteira
// do turno (user/command) concatenando os blocos de texto do assistant.
export function lastAssistantTurnText(messages: ChatMessage[]): string | null {
  const last = messages[messages.length - 1]
  if (!last || last.kind !== 'assistant') return null
  const texts: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'user' || m.kind === 'command') break
    if (m.kind === 'assistant') texts.unshift(m.text)
  }
  const joined = texts.join('\n\n').trim()
  return joined || null
}

// Sessões com o resumo automático ligado (toggle por sessão no composer). Em
// memória de propósito: o toggle é um interruptor de custo da sessão viva —
// sessão nova nasce desligada, e um restart do app volta ao default silencioso.
const autoSummarySessions = new Set<string>()

export function setAutoSummary(ccSessionId: string, enabled: boolean): void {
  if (enabled) autoSummarySessions.add(ccSessionId)
  else autoSummarySessions.delete(ccSessionId)
}

export function isAutoSummaryEnabled(ccSessionId: string): boolean {
  return autoSummarySessions.has(ccSessionId)
}

// Lock por sessão: um resumo em voo por vez.
const inFlight = new Set<string>()
// Borda que chegou COM resumo em voo: o turno novo não pode se perder — ao
// terminar o voo atual, roda de novo pro estado mais recente do transcript.
const pendingRerun = new Set<string>()
// Último turno já resumido por sessão (hash sha1 do texto — a identidade do
// turno sem reter o texto integral em memória pra sempre) — o mesmo turno
// nunca gasta claude duas vezes, mesmo que a borda repique.
const lastSummarized = new Map<string, string>()
const settleTimers = new Map<string, NodeJS.Timeout>()

// O índice do session-activity cobre TODA sessão CC da máquina (terminais fora
// do app, filhas de crew). Só sessões que o Pitwall exibe (pane com watch de
// atividade) pagam leitura de transcript + claude. Injetável pra evitar ciclo
// de import com session-activity; default permissivo até o boot registrar.
let sessionDisplayed: (ccSessionId: string) => boolean = () => true

export function setVoiceSessionFilter(fn: (ccSessionId: string) => boolean): void {
  sessionDisplayed = fn
}

export function turnKey(turnText: string): string {
  return createHash('sha1').update(turnText).digest('hex')
}

// Limpeza quando a sessão sai do índice (PID morreu / arquivo sumiu) — sem
// isso o lastSummarized reteria uma entrada por sessão pra sempre.
export function forgetSessionSummaries(ccSessionId: string): void {
  autoSummarySessions.delete(ccSessionId)
  lastSummarized.delete(ccSessionId)
  pendingRerun.delete(ccSessionId)
  const timer = settleTimers.get(ccSessionId)
  if (timer) {
    clearTimeout(timer)
    settleTimers.delete(ccSessionId)
  }
}

export async function maybeSummarizeTurn(ccSessionId: string): Promise<void> {
  if (!autoSummarySessions.has(ccSessionId)) return
  if (!sessionDisplayed(ccSessionId)) return
  if (inFlight.has(ccSessionId)) {
    // Turno novo com resumo em voo: não pode ser dropado — coalesce num rerun.
    pendingRerun.add(ccSessionId)
    return
  }
  await runSummary(ccSessionId, { force: false })
}

// Resumo sob demanda (botão "Resumir"): ação explícita do usuário, então
// ignora o gate do resumo automático E o dedupe (pedir de novo o mesmo turno
// resume de novo). O lock anti-concorrência continua valendo — dois resumos da
// mesma sessão ao mesmo tempo nunca.
export async function summarizeNow(ccSessionId: string): Promise<VoiceSummarizeNowResult> {
  if (inFlight.has(ccSessionId))
    return { ok: false, error: 'Um resumo desta sessão já está em andamento.' }
  return runSummary(ccSessionId, { force: true })
}

// Núcleo compartilhado. Pré-condição: o lock NÃO está tomado (os chamadores
// checam antes) — aqui ele é tomado e solto.
async function runSummary(
  ccSessionId: string,
  { force }: { force: boolean },
): Promise<VoiceSummarizeNowResult> {
  inFlight.add(ccSessionId)
  try {
    const read = await chatTranscriptService.read(ccSessionId)
    const turnText = lastAssistantTurnText(read.messages)
    if (!turnText)
      return {
        ok: false,
        error: 'O último turno ainda não terminou em resposta de texto.',
      }
    const key = turnKey(turnText)
    if (!force && lastSummarized.get(ccSessionId) === key) return { ok: true }
    // Marca ANTES do claude: falha de resumo não re-tenta o mesmo turno (a
    // borda já passou; retry só duplicaria custo num turno possivelmente ruim).
    lastSummarized.set(ccSessionId, key)

    // O texto do transcript entra no prompt: guard-rail de tools obrigatório —
    // o resumidor NUNCA pode executar ação a partir do conteúdo da sessão.
    const result = await runClaude(
      [
        '-p',
        SUMMARY_INSTRUCTION + turnText,
        '--output-format',
        'text',
        '--model',
        SUMMARY_MODEL,
        ...TEXT_ONLY_CLAUDE_ARGS,
      ],
      { timeoutMs: SUMMARY_TIMEOUT_MS },
    )
    if (result.code !== 0) return { ok: false, error: 'O resumidor (claude) falhou.' }
    const summary = stripCodeFence(result.stdout).trim()
    if (!summary) return { ok: false, error: 'O resumidor devolveu um resumo vazio.' }

    broadcast('voice:summary', {
      ccSessionId,
      summary,
    } satisfies VoiceSummaryEvent)
    return { ok: true }
  } catch {
    return { ok: false, error: 'Falha ao ler o transcript da sessão.' }
  } finally {
    inFlight.delete(ccSessionId)
    if (pendingRerun.delete(ccSessionId)) void maybeSummarizeTurn(ccSessionId)
  }
}

// Entrada do hook do session-activity: debounce por sessão (repiques do índice
// de PIDs colapsam num disparo) + settle pro JSONL terminar de ser escrito.
export function scheduleTurnSummary(ccSessionId: string): void {
  const pending = settleTimers.get(ccSessionId)
  if (pending) clearTimeout(pending)
  settleTimers.set(
    ccSessionId,
    setTimeout(() => {
      settleTimers.delete(ccSessionId)
      void maybeSummarizeTurn(ccSessionId)
    }, SETTLE_MS),
  )
}
