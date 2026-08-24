// Destilação do bastão: transcript vivo -> digest -> claude -p -> briefing.
// Mesma mecânica do Stage 1 da memória de features (feature-memory.ts:268-283) —
// findTranscriptPath / buildDigest / runClaude, timeout de 90s. A diferença é que
// aqui não há persistência nem fila: é síncrono e sob demanda, porque o humano
// está esperando na tela da passagem de bastão.
import { buildDigest, stripCodeFence } from '../feature-digest'
import { findTranscriptPath } from '../session-activity'
import { runClaude } from '../claude-cli'
import { composeBatonPrompt } from './compose-baton-prompt'

// Igual ao SYNTH_TIMEOUT_MS da síntese de features: destilar um transcript grande
// leva dezenas de segundos e um timeout curto só produziria falha intermitente.
const DISTILL_TIMEOUT_MS = 90_000

export interface DistillBatonOpts {
  repoLabel?: string | null
  featureTitle?: string | null
  note?: string | null
  // Modelo do claude -p. null/ausente = default da CLI.
  model?: string | null
}

// Devolve o texto Markdown do briefing. Lança Error com mensagem legível (a UI
// mostra a mensagem direto) quando não há transcript, o claude falha ou o output
// vem vazio — nunca devolve briefing vazio, que passaria adiante uma sucessora cega.
export async function distillBaton(
  ccSessionId: string,
  opts: DistillBatonOpts = {},
): Promise<string> {
  const transcriptPath = findTranscriptPath(ccSessionId)
  if (!transcriptPath) {
    throw new Error(
      `Transcript da sessão ${ccSessionId} não encontrado em ~/.claude/projects — sem histórico não há bastão a passar.`,
    )
  }

  const digest = buildDigest(transcriptPath)
  // Transcript existe mas está vazio/ilegível (sessão recém-criada, arquivo truncado):
  // destilar isso gastaria 90s de LLM pra produzir um briefing inventado.
  if (digest.userTurns === 0 && digest.editCount === 0) {
    throw new Error(
      `A sessão ${ccSessionId} ainda não tem trabalho registrado no transcript — nada para destilar.`,
    )
  }

  const prompt = composeBatonPrompt({
    digest,
    repoLabel: opts.repoLabel,
    featureTitle: opts.featureTitle,
    note: opts.note,
  })
  const args = ['-p', prompt, '--output-format', 'text']
  if (opts.model) args.push('--model', opts.model)

  const result = await runClaude(args, { timeoutMs: DISTILL_TIMEOUT_MS })
  if (result.code !== 0) {
    // runClaude nunca rejeita: erro de exec, exit != 0 e timeout (execFile mata o
    // processo) chegam todos aqui como code != 0. A stderr é o que há de legível.
    const detail = result.stderr.trim().slice(0, 300) || `exit ${result.code}`
    throw new Error(`Destilação do bastão falhou (${detail}).`)
  }

  const briefing = stripCodeFence(result.stdout).trim()
  if (!briefing) {
    throw new Error('Destilação do bastão devolveu um briefing vazio — tente de novo.')
  }
  return briefing
}
