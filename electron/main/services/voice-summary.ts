// Resumo falado de fim de turno: a borda working → waiting/idle (hook do
// session-activity) dispara a leitura do transcript; se o turno terminou em texto
// de assistant (permission prompts também disparam a borda — esses NÃO resumem),
// o texto vira 2-3 frases via claude -p e sai por broadcast('voice:summary').
// Gate de custo: só roda com a pref voice.mode ligada.
import type { ChatMessage } from '../../../shared/types/chat'
import type { VoiceSummaryEvent } from '../../../shared/types/ipc'
import { chatTranscriptService } from './chat-transcript-service'
import { runClaude } from './claude-cli'
import { stripCodeFence } from './feature-digest'
import { broadcast } from './notify'
import { getPref } from './prefs-store'

export const VOICE_MODE_PREF_KEY = 'voice.mode'

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

// Lock por sessão: um resumo em voo por vez.
const inFlight = new Set<string>()
// Último turno já resumido por sessão (o texto é a identidade do turno) — o
// mesmo turno nunca gasta claude duas vezes, mesmo que a borda repique.
const lastSummarized = new Map<string, string>()
const settleTimers = new Map<string, NodeJS.Timeout>()

export async function maybeSummarizeTurn(ccSessionId: string): Promise<void> {
  if (!getPref(VOICE_MODE_PREF_KEY, false)) return
  if (inFlight.has(ccSessionId)) return
  inFlight.add(ccSessionId)
  try {
    const read = await chatTranscriptService.read(ccSessionId)
    const turnText = lastAssistantTurnText(read.messages)
    if (!turnText) return
    if (lastSummarized.get(ccSessionId) === turnText) return
    // Marca ANTES do claude: falha de resumo não re-tenta o mesmo turno (a
    // borda já passou; retry só duplicaria custo num turno possivelmente ruim).
    lastSummarized.set(ccSessionId, turnText)

    const result = await runClaude(
      ['-p', SUMMARY_INSTRUCTION + turnText, '--output-format', 'text', '--model', SUMMARY_MODEL],
      { timeoutMs: SUMMARY_TIMEOUT_MS },
    )
    if (result.code !== 0) return
    const summary = stripCodeFence(result.stdout).trim()
    if (!summary) return

    broadcast('voice:summary', { ccSessionId, summary } satisfies VoiceSummaryEvent)
  } finally {
    inFlight.delete(ccSessionId)
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
