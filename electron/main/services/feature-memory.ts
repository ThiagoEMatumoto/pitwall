import { BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import type {
  Feature,
  FeatureLinkTargetType,
  FeatureSynthError,
  FeatureSynthMode,
} from '../../../shared/types/ipc'
import { getDb } from './db'
import {
  get as getFeature,
  create as createFeature,
  markSelfWrite,
  reindexFromFile,
  findFeatureByRepoBranch,
  isVisibleFeature,
  listActiveFeaturesByProject,
  getProjectIdForRepo,
  getRepoPath,
  saveSessionRecord,
  sessionRecordCount,
  listSessionRecords,
  setObjectiveLinks,
  setAppDev,
} from './feature-store'
import { setPulse } from './loop-store'
import { markDuplicateSuspect } from './feature-focus'
import { list as listObjectives, loadKeyResults } from './objective-store'
import { findTranscriptPath } from './session-activity'
import { runClaude } from './claude-cli'
import { PULSE_MAX_LENGTH } from '../../../shared/feature-loop'
import {
  isProtectedBranch,
  normalizeBranch,
  fuzzyScore,
  decideRegistration,
  decideObjectiveLink,
} from './feature-heuristics'
import {
  buildDigest,
  renderDigestForRecord,
  buildRecordPrompt,
  buildHolisticPrompt,
  stripCodeFence,
  stripToFrontmatter,
  isValidDoc,
} from './feature-digest'

const SYNTH_TIMEOUT_MS = 90_000
const DEBOUNCE_MS = 4_000
const SYNTH_MODEL_KEY = 'synth_model'
const SYNTH_MODE_KEY = 'synth_mode'
const MAX_AUTO_OBJECTIVE_CHARS = 600

// Identidade do próprio Pitwall, pro auto-tag app-dev (Onda 3 —
// separação app-dev). O nome do package.json do repo é o sinal escolhido:
// estável em qualquer worktree do repo (todas carregam o mesmo package.json),
// e independente de onde o Electron está rodando (dev vs packaged) — ao
// contrário de comparar paths, que quebraria em qualquer clone/worktree fora
// do path exato de quem escreveu este código.
const SELF_PACKAGE_NAME = 'pitwall'

// Modo de síntese global (app_prefs); 'threshold' como default seguro.
function globalSynthMode(): FeatureSynthMode {
  try {
    const row = getDb().prepare('SELECT value FROM app_prefs WHERE key = ?').get(SYNTH_MODE_KEY) as
      | { value: string }
      | undefined
    const v = row?.value?.trim()
    if (v === 'auto' || v === 'manual' || v === 'threshold') return v
  } catch {
    // sem tabela/pref — cai no default.
  }
  return 'threshold'
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function emitSynthError(featureId: string, message: string): void {
  const event: FeatureSynthError = { featureId, message, at: Date.now() }
  broadcast('feature:synth-error', event)
}

function resolveModel(feature: Feature): string | null {
  if (feature.model) return feature.model
  try {
    const row = getDb()
      .prepare('SELECT value FROM app_prefs WHERE key = ?')
      .get(SYNTH_MODEL_KEY) as { value: string } | undefined
    return row?.value?.trim() || null
  } catch {
    return null
  }
}

// Detecta se `repoPath` é o repo do próprio Pitwall (Onda 3 —
// separação app-dev): lê o package.json do repo e compara `name`. Função de
// módulo (não método), testável direto com fixtures de filesystem sem
// precisar montar uma sessão inteira.
export function isSelfRepoPath(repoPath: string | null): boolean {
  if (!repoPath) return false
  try {
    const raw = readFileSync(join(repoPath, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { name?: unknown }
    return pkg.name === SELF_PACKAGE_NAME
  } catch {
    return false
  }
}

// Auto-sugestão de vínculo a objetivo (Onda 2 — fecha a sub-linkagem: a causa
// raiz era ninguém expor "quantas features não têm OKR", nem sugerir um).
// Função de módulo (não método) — exportada pra ser exercitada direto em
// teste de integração sem precisar do singleton `featureMemory`. Roda só
// quando a feature resolvida ainda não tem NENHUM vínculo — feature já
// linkada não é candidata (evita sobrescrever escolha humana). Mesmo
// fuzzyScore do link sessão→feature, contra títulos de objetivos/KRs ativos
// (objectives não são escopados por projeto no schema atual — Fase 1 os
// trata como camada global, sem project_id).
export function maybeSuggestObjectiveLink(featureId: string, prompt: string | null): void {
  if (!prompt) return
  const feature = getFeature(featureId)
  if (!feature || feature.objectiveLinkCount > 0) return

  let best: { targetType: FeatureLinkTargetType; targetId: string; title: string; score: number } | null =
    null
  for (const objective of listObjectives({ status: 'active' })) {
    const score = fuzzyScore(prompt, objective.title)
    if (!best || score > best.score) {
      best = { targetType: 'objective', targetId: objective.id, title: objective.title, score }
    }
    for (const kr of loadKeyResults(objective.id)) {
      if (kr.status !== 'active') continue
      const krScore = fuzzyScore(prompt, kr.title)
      if (!best || krScore > best.score) {
        best = { targetType: 'key_result', targetId: kr.id, title: kr.title, score: krScore }
      }
    }
  }
  if (!best) return

  // Só o auto-link de confiança alta escreve; 'needs-review' virou no-op.
  // Ele criava uma task de revisão que ninguém consumia (26% do backlog aberto
  // no banco real, nenhuma jamais tocada). A feature sem OKR já se anuncia
  // sozinha: `withOkrIssue` (src/features/features/feature-issues.ts) deriva a
  // issue `okr_missing` de objectiveLinkCount === 0 e a faixa de issues leva
  // direto pra FeatureObjectiveLinksSection — a task era ruído redundante.
  if (decideObjectiveLink(best.score) !== 'link') return
  setObjectiveLinks(featureId, [{ targetType: best.targetType, targetId: best.targetId }])
  const updated = getFeature(featureId)
  if (updated && isVisibleFeature(updated)) broadcast('feature:updated', updated)
}

// ---- Pulso automático (rede de segurança do loop) ----

// Quem DEVE fechar o loop é a sessão, via MCP (feature_pulse_set). Isto aqui é
// a rede pra quando ela não fecha: o registro que a síntese acabou de produzir
// vira um pulso candidato por derivação DETERMINÍSTICA do texto — sem uma
// segunda chamada de LLM, sem custo novo e sem depender de o modelo colaborar.

// Trecho do registro que fala do estado final. É o que o pulso quer dizer
// ("como a frente está AGORA"), e não o objetivo com que a sessão abriu.
const PULSE_SECTION = /^(resultado|estado)\b[^:]*:?\s*(.*)$/i

// Tira a decoração Markdown de UMA linha (heading, bullet, ênfase, crase) — o
// pulso é uma frase de texto puro.
function plainLine(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/[*_`]/g, '')
    .trim()
}

function isHeading(line: string): boolean {
  return /^\s*#{1,6}\s/.test(line)
}

function firstSentence(text: string): string {
  const match = /^(.*?[.!?])(?:\s|$)/.exec(text)
  return (match ? match[1] : text).trim()
}

function clampPulse(text: string): string {
  return text.length <= PULSE_MAX_LENGTH ? text : `${text.slice(0, PULSE_MAX_LENGTH - 1)}…`
}

/**
 * Deriva um pulso candidato do registro de sessão. Prefere a seção
 * "Resultado"/"Estado" do registro; sem ela, a primeira frase de prosa. Devolve
 * null quando não sobra texto nenhum (registro só de headings, por exemplo).
 */
export function pulseCandidateFromSummary(summary: string): string | null {
  const lines = summary.split('\n')
  const texts = lines.map(plainLine)

  for (let i = 0; i < texts.length; i++) {
    const match = PULSE_SECTION.exec(texts[i])
    if (!match) continue
    // Forma inline ("**Resultado:** ficou pela metade") vs. heading seguido do
    // parágrafo — nos dois casos o que interessa é o texto, não o rótulo.
    const inline = match[2].trim()
    if (inline) return clampPulse(firstSentence(inline))
    const next = texts.slice(i + 1).find((t) => t !== '')
    if (next) return clampPulse(firstSentence(next))
  }

  // Fallback: primeira linha de PROSA. Heading é rótulo ("## Registro"), não
  // estado — usá-lo produziria um pulso que não diz nada.
  const firstProse = texts.find((text, i) => text !== '' && !isHeading(lines[i]))
  return firstProse ? clampPulse(firstSentence(firstProse)) : null
}

// A sessão já deixou pulso nesta janela? Duas checagens: `session_id` igual (é
// o que o caminho MCP carimba) e, como rede, qualquer pulso criado depois do
// started_at da sessão — um pulso escrito à mão no app enquanto a sessão rodava
// também é intenção mais fresca que o nosso palpite derivado.
function sessionAlreadyPulsed(featureId: string, sessionId: string): boolean {
  const db = getDb()
  const session = db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(sessionId) as
    | { started_at: number }
    | undefined
  const row = session
    ? db
        .prepare(
          'SELECT 1 FROM feature_pulses WHERE feature_id = ? AND (session_id = ? OR created_at >= ?) LIMIT 1',
        )
        .get(featureId, sessionId, session.started_at)
    : db
        .prepare('SELECT 1 FROM feature_pulses WHERE feature_id = ? AND session_id = ? LIMIT 1')
        .get(featureId, sessionId)
  return row !== undefined
}

// ---- Serviço ----

export interface SessionExitInfo {
  sessionId: string
  ccSessionId: string | null
  repoId: string
  // Feature escolhida manualmente no spawn (precedência absoluta). null => auto-resolver.
  featureId: string | null
}

type LinkKind = 'manual' | 'auto-linked' | 'auto-created'

interface RecordJob {
  info: SessionExitInfo
  featureId: string
}

class FeatureMemoryService {
  // Debounce por-feature da síntese holística (Stage 2): várias sessões da mesma
  // feature colapsam numa única regeneração.
  private timers = new Map<string, NodeJS.Timeout>()
  private running = new Set<string>()
  // Fila throttled (concorrência 1) de geração de registros (Stage 1). Usada tanto
  // pelo fluxo live (1 sessão) quanto pelo backfill (N sessões) — evita rajada de
  // chamadas LLM concorrentes.
  private recordQueue: RecordJob[] = []
  private draining = false

  onSessionExit(info: SessionExitInfo): void {
    if (!info.ccSessionId) return

    let resolution: { featureId: string; kind: LinkKind } | null = null
    try {
      resolution = this.resolveFeature(info, info.ccSessionId)
    } catch (err) {
      console.error('[feature-memory] resolução de feature falhou:', err)
      return
    }
    if (!resolution) return

    const { featureId, kind } = resolution
    console.log(`[feature-memory] session ${info.sessionId} ${kind} -> feature ${featureId}`)

    // Observabilidade: a UI recarrega a lista assim que a feature é criada/linkada.
    // Gate: rascunho invisível (auto-criado sem registros) NÃO é broadcastado —
    // o featuresStore.onUpdated insere qualquer Feature recebida na lista. Ele
    // aparece quando o 1º registro for gravado (broadcast em generateSessionRecord).
    const feat = getFeature(featureId)
    if (feat && isVisibleFeature(feat)) broadcast('feature:updated', feat)

    // Stage 1 (registro) via fila → ao drenar, agenda Stage 2 (holística) debounced.
    this.enqueueRecords([{ info, featureId }])
  }

  // Backfill: resolve + cria/linka uma sessão JÁ encerrada (SEM LLM). A geração de
  // registros é enfileirada à parte pelo IPC. Retorna o resultado para contagem, ou
  // null se a sessão não rende feature (atividade insuficiente, etc).
  registerOnly(info: SessionExitInfo): { featureId: string; kind: LinkKind } | null {
    if (!info.ccSessionId) return null
    try {
      return this.resolveFeature(info, info.ccSessionId)
    } catch (err) {
      console.error('[feature-memory] backfill resolve falhou:', err)
      return null
    }
  }

  // Enfileira jobs de geração de registro (Stage 1). Throttled: drena 1 por vez.
  enqueueRecords(jobs: RecordJob[]): void {
    if (jobs.length === 0) return
    this.recordQueue.push(...jobs)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    const affected = new Set<string>()
    try {
      while (this.recordQueue.length) {
        const job = this.recordQueue.shift()
        if (!job) break
        try {
          const ok = await this.generateSessionRecord(job.info, job.featureId)
          if (ok) affected.add(job.featureId)
        } catch (err) {
          console.error('[feature-memory] geração de registro falhou:', err)
        }
      }
    } finally {
      this.draining = false
    }
    // Stage 2: uma regeneração holística por feature afetada (debounced).
    for (const fid of affected) this.scheduleHolistic(fid)
  }

  // Stage 1: destila a sessão num registro e persiste. Retorna true se produziu.
  private async generateSessionRecord(info: SessionExitInfo, featureId: string): Promise<boolean> {
    if (!info.ccSessionId) return false
    const feature = getFeature(featureId)
    if (!feature) return false
    if (feature.synthMode === 'manual') return false

    const transcriptPath = findTranscriptPath(info.ccSessionId)
    if (!transcriptPath) return false
    const digest = buildDigest(transcriptPath)

    // Guarda de atividade (modo 'threshold'; 'auto' pula). Não gera registro de
    // sessão trivial.
    if (feature.synthMode !== 'auto') {
      if (digest.userTurns < 2 || digest.editCount === 0) return false
    }

    const prompt = buildRecordPrompt(feature, renderDigestForRecord(digest))
    const model = resolveModel(feature)
    const args = ['-p', prompt, '--output-format', 'text']
    if (model) args.push('--model', model)

    const result = await runClaude(args, { timeoutMs: SYNTH_TIMEOUT_MS })
    if (result.code !== 0) {
      emitSynthError(featureId, `registro de sessão falhou (exit ${result.code}): ${result.stderr.slice(0, 300)}`)
      this.stubDraftFeature(info, feature)
      return false
    }
    const summary = stripCodeFence(result.stdout).trim()
    if (!summary) {
      this.stubDraftFeature(info, feature)
      return false
    }

    saveSessionRecord({
      sessionId: info.sessionId,
      featureId,
      ccSessionId: info.ccSessionId,
      summary,
      model,
    })
    this.recordAutoPulse(info, featureId, summary)
    // O 1º registro torna um rascunho visível — broadcasta pra feature "aparecer
    // sozinha" na UI (pra features já visíveis é um update inofensivo).
    const updated = getFeature(featureId)
    if (updated && isVisibleFeature(updated)) broadcast('feature:updated', updated)
    return true
  }

  // Grava o pulso derivado do registro — a menos que a sessão já tenha fechado
  // o loop por conta própria. Nunca derruba a geração do registro: o pulso é
  // rede de segurança, não parte do contrato do Stage 1.
  private recordAutoPulse(info: SessionExitInfo, featureId: string, summary: string): void {
    try {
      if (sessionAlreadyPulsed(featureId, info.sessionId)) return
      const body = pulseCandidateFromSummary(summary)
      if (!body) return
      setPulse(featureId, body, 'session', info.sessionId)
    } catch (err) {
      console.error('[feature-memory] pulso automático falhou:', err)
    }
  }

  // Feature fantasma (Onda 3): quando a síntese LLM falha (timeout/erro/output
  // vazio) pra uma feature auto que AINDA não tem nenhum registro, ela fica
  // presa invisível pra sempre — isVisibleFeature deriva de recordCount>0, e
  // sem isto a sessão "desaparece" pro usuário sem deixar rastro nenhum. Grava
  // um registro título-only (o título já foi derivado via humanizeBranch/
  // deriveTitle na criação, em decideRegistration) em vez de tentar
  // re-sintetizar — a feature vira visível com o mínimo de conteúdo, e a
  // próxima sessão bem-sucedida complementa via síntese holística normal. Só
  // se aplica a rascunhos (feature já visível não precisa disto).
  private stubDraftFeature(info: SessionExitInfo, feature: Feature): void {
    if (feature.origin !== 'auto' || sessionRecordCount(feature.id) > 0) return
    saveSessionRecord({
      sessionId: info.sessionId,
      featureId: feature.id,
      ccSessionId: info.ccSessionId,
      summary: feature.title,
      model: null,
    })
    const updated = getFeature(feature.id)
    if (updated && isVisibleFeature(updated)) broadcast('feature:updated', updated)
  }

  private scheduleHolistic(featureId: string): void {
    const existing = this.timers.get(featureId)
    if (existing) clearTimeout(existing)
    this.timers.set(
      featureId,
      setTimeout(() => {
        this.timers.delete(featureId)
        void this.synthesizeHolistic(featureId)
      }, DEBOUNCE_MS),
    )
  }

  // Resolve (ou cria) a feature a vincular à sessão e persiste sessions.feature_id.
  // Retorna null quando não deve vincular (trivial / sem branch utilizável / branch
  // protegida sem feature pré-existente).
  private resolveFeature(
    info: SessionExitInfo,
    ccSessionId: string,
  ): { featureId: string; kind: LinkKind } | null {
    // Tag app-dev (Onda 3): calculada uma vez por resolução, aplicada em
    // qualquer um dos 3 caminhos (manual/link/create) — é sobre o repo da
    // SESSÃO, não sobre como a feature foi resolvida.
    const appDev = isSelfRepoPath(getRepoPath(info.repoId))
    const tagAppDev = (featureId: string): void => {
      if (appDev) setAppDev(featureId, true)
    }

    // 1. Manual vence (sem guarda de atividade — o usuário escolheu a feature).
    if (info.featureId) {
      const f = getFeature(info.featureId)
      if (f) {
        tagAppDev(f.id)
        return { featureId: f.id, kind: 'manual' }
      }
      // feature manual sumiu — cai pra auto-resolução.
    }

    // 2. Distila o transcript. `digest.gitBranch` já é a branch de TRABALHO.
    const transcriptPath = findTranscriptPath(ccSessionId)
    if (!transcriptPath) return null
    const digest = buildDigest(transcriptPath)

    const branch = normalizeBranch(digest.gitBranch)
    const workBranch = branch && !isProtectedBranch(branch) ? branch : null
    const firstPrompt = digest.userPrompts[0] ?? null

    const projectId = getProjectIdForRepo(info.repoId)
    if (!projectId) return null

    // Candidatos a vínculo: por branch de trabalho e por fuzzy de objetivo.
    const byBranch = workBranch ? findFeatureByRepoBranch(info.repoId, workBranch) : null
    let fuzzyMatch: { featureId: string; score: number } | null = null
    if (firstPrompt) {
      for (const f of listActiveFeaturesByProject(projectId)) {
        const score = fuzzyScore(firstPrompt, f.title)
        if (!fuzzyMatch || score > fuzzyMatch.score) fuzzyMatch = { featureId: f.id, score }
      }
    }

    const decision = decideRegistration({
      synthMode: globalSynthMode(),
      userTurns: digest.userTurns,
      editCount: digest.editCount,
      workBranch,
      firstPrompt,
      byBranchFeatureId: byBranch?.id ?? null,
      fuzzyMatch,
    })

    if (decision.action === 'skip') return null
    if (decision.action === 'link') {
      this.persistLink(info.sessionId, decision.featureId)
      tagAppDev(decision.featureId)
      maybeSuggestObjectiveLink(decision.featureId, firstPrompt)
      return { featureId: decision.featureId, kind: 'auto-linked' }
    }

    // create/suspect: título já decidido (pela branch ou pelo objetivo). Nasce
    // como rascunho oculto (origin 'auto') — só aparece quando ganhar o 1º
    // registro. Em 'suspect' o rascunho nasce IGUAL: o trabalho da sessão nunca
    // se perde por um palpite de semelhança; o que muda é a marca de suspeita
    // gravada logo depois, pra a UI oferecer o merge.
    const repoPath = getRepoPath(info.repoId)
    const created = createFeature({
      projectId,
      title: decision.title,
      status: 'in-progress',
      origin: 'auto',
      isAppDev: appDev,
      objective: firstPrompt ? firstPrompt.slice(0, MAX_AUTO_OBJECTIVE_CHARS) : null,
      repos: [{ repoId: info.repoId, branch: workBranch ?? branch ?? 'main', worktreePath: repoPath }],
    })
    this.persistLink(info.sessionId, created.id)
    maybeSuggestObjectiveLink(created.id, firstPrompt)
    if (decision.action === 'suspect') {
      markDuplicateSuspect(created.id, decision.candidateId, decision.score)
    }
    return { featureId: created.id, kind: 'auto-created' }
  }

  private persistLink(sessionId: string, featureId: string): void {
    try {
      getDb().prepare('UPDATE sessions SET feature_id = ? WHERE id = ?').run(featureId, sessionId)
    } catch (err) {
      console.error('[feature-memory] falha ao persistir feature_id:', err)
    }
  }

  // Stage 2: regenera o corpo inteiro do doc sintetizando TODOS os registros da
  // feature. Substitui o antigo patch incremental por-sessão.
  private async synthesizeHolistic(featureId: string): Promise<void> {
    if (this.running.has(featureId)) return
    this.running.add(featureId)
    try {
      const feature = getFeature(featureId)
      if (!feature) return
      if (feature.synthMode === 'manual') return

      const records = listSessionRecords(featureId)
      if (records.length === 0) return

      const currentMd = (() => {
        try {
          return readFileSync(feature.docPath, 'utf8')
        } catch {
          return null
        }
      })()
      if (!currentMd) return

      const prompt = buildHolisticPrompt(currentMd, records)
      const model = resolveModel(feature)
      const args = ['-p', prompt, '--output-format', 'text']
      if (model) args.push('--model', model)

      const result = await runClaude(args, { timeoutMs: SYNTH_TIMEOUT_MS })
      if (result.code !== 0) {
        emitSynthError(featureId, `síntese falhou (exit ${result.code}): ${result.stderr.slice(0, 300)}`)
        return
      }

      const md = stripToFrontmatter(result.stdout)
      if (!isValidDoc(md)) {
        emitSynthError(featureId, 'output da síntese inválido (frontmatter ausente ou não parseável)')
        return
      }

      // Escrita segura: marca self-write ANTES de escrever (o watcher ignora),
      // depois re-indexa pelo doc e emite o update.
      try {
        const reparsed = matter(md)
        reparsed.data.last_updated = Date.now()
        const finalMd = matter.stringify(reparsed.content, reparsed.data)
        markSelfWrite(feature.docPath)
        writeFileSync(feature.docPath, finalMd, 'utf8')
      } catch (err) {
        emitSynthError(featureId, `falha ao escrever doc: ${String(err)}`)
        return
      }

      const updated = reindexFromFile(feature.docPath)
      if (updated) broadcast('feature:updated', updated)
    } catch (err) {
      emitSynthError(featureId, `erro inesperado na síntese: ${String(err)}`)
    } finally {
      this.running.delete(featureId)
    }
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.recordQueue = []
  }
}

export const featureMemory = new FeatureMemoryService()

// Helper público pra fase 6: extrai seções-chave do corpo de um doc pra injeção
// no system prompt (Visão geral / Estado atual / Pontos em aberto).
export function extractKeySections(body: string): string {
  const wanted = ['Visão geral', 'Estado atual', 'Pontos em aberto']
  const out: string[] = []
  // Quebra o body por headings de nível 2.
  const sections = body.split(/^## /m)
  for (const chunk of sections) {
    const nlIdx = chunk.indexOf('\n')
    if (nlIdx === -1) continue
    const heading = chunk.slice(0, nlIdx).trim()
    const content = chunk.slice(nlIdx + 1).trim()
    if (wanted.includes(heading) && content) {
      out.push(`## ${heading}\n\n${content}`)
    }
  }
  return out.join('\n\n')
}
