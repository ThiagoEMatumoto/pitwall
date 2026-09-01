import { randomUUID } from 'node:crypto'
import * as jobStore from './scheduled-job-store'
import { runJob, type JobRunParams } from './job-runner'
import { setRunJobNow } from './job-run-now'
import { broadcast } from './notify'
import { isE2E } from './e2e-mode'
import type { JobRun, ScheduledJob } from '../../../shared/types/ipc'

// Scheduler de Scheduled Jobs (Fase 2). Molde de calendar-watcher: um único timer
// de poll + flag anti-reentrância. Sem lib de cron — next_run_at é derivado do
// schedule num único helper (computeNextRunAt) no store, e o claim atômico
// (claimDueJob) evita double-fire quando o poll dispara duas vezes no mesmo tick.
//
// Boot (start): reconcileOrphanRuns (limpa runs 'running' do processo anterior)
// → catch-up dos vencidos (spawn se catch_up, senão marca 'missed') → agenda o
// poll. Nada de tick imediato: o catch-up já reivindicou tudo que estava vencido.

const POLL_INTERVAL_MS = 30 * 1000

export interface JobSchedulerDeps {
  // Relógio (default: Date.now). Injetável p/ teste determinístico.
  now?: () => number
  // Executa o job HEADLESS e finaliza a run async (default: runJob). Injetável p/
  // teste — assim o teste nunca toca claude/execFile/electron.
  run?: (params: JobRunParams) => void | Promise<void>
  // Gera o --session-id/cc_session_id da run (default: randomUUID). Injetável p/
  // teste determinístico.
  genId?: () => string
}

// Snapshot self-contained dos params do job a partir da row (imune a mudança de
// preset — o que foi gravado no job é o que roda). runId liga o run à finalização
// desta execução; previousReport (último run COM relatório) alimenta o delta. O
// ccSessionId é gerado no disparo (spawnClaimedRun) e adicionado a estes params.
function jobToSpawnParams(
  job: ScheduledJob,
  run: JobRun,
  previousReport: string | null,
  previousMetrics: string | null,
): Omit<JobRunParams, 'ccSessionId'> {
  return {
    repoId: job.repoId,
    name: job.name,
    kind: job.kind,
    prompt: job.prompt,
    systemPrompt: job.systemPrompt,
    targetUrl: job.targetUrl,
    model: job.model,
    effort: job.effort,
    permissionMode: job.permissionMode,
    advisorModel: job.advisorModel,
    disallowedTools: job.disallowedTools,
    runId: run.id,
    previousReport,
    previousMetrics,
  }
}

export class JobScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  // Anti-reentrância: se um tick ainda está em voo (spawn lento), o próximo é
  // ignorado. O claim atômico já protege o DB, mas isto evita trabalho redundante.
  private ticking = false
  private readonly deps: Required<JobSchedulerDeps>

  constructor(deps: JobSchedulerDeps = {}) {
    this.deps = {
      now: deps.now ?? (() => Date.now()),
      run: deps.run ?? runJob,
      genId: deps.genId ?? randomUUID,
    }
  }

  isRunning(): boolean {
    return this.timer !== null
  }

  start(): void {
    // Sob o harness o scheduler não sobe: o catch-up dos vencidos spawna
    // sessões Claude reais a partir dos jobs do perfil copiado.
    if (isE2E()) return
    if (this.timer) return
    // ORDEM crítica: reconcile PRIMEIRO (senão o catch-up abaixo cria runs
    // 'running' que o reconcile marcaria 'interrupted' na sequência).
    this.bootReconcileAndCatchUp()
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // Boot: limpa órfãos e resolve os vencidos com o app fechado. Para cada job
  // vencido: reivindica (avança next_run_at 1x → catch-up LIMITADO); se catch_up
  // opt-in, spawna 1 run, senão marca a run 'missed' (skip-with-marker).
  private bootReconcileAndCatchUp(): void {
    const now = this.deps.now()
    try {
      const reconciled = jobStore.reconcileOrphanRuns(now)
      // Órfãs running→interrupted mutam runs FORA de um IPC handler. A janela já
      // existe no boot (createMainWindow roda antes de start), então sinaliza o
      // reload — o jobsStore recarrega lista/histórico no evento (ignora o payload).
      if (reconciled > 0) broadcast('jobRun:updated', { reconciled })
    } catch (err) {
      console.error('[job-scheduler] reconcile de órfãos no boot falhou:', err)
    }
    for (const job of jobStore.listDueJobs(now)) {
      // Último run COM relatório (não o último absoluto: 'missed'/'failed' no meio
      // não devem suprimir o delta havendo um 'success' anterior). Alimenta o delta.
      const previousReport = jobStore.getLastReport(job.id)
      const previousMetrics = jobStore.getLastMetrics(job.id)
      const run = jobStore.claimDueJob(job.id, now)
      if (!run) continue
      // claim avançou next_run_at/last_run_at → a UI precisa do job atualizado.
      this.broadcastJobUpdated(job.id)
      if (job.catchUp) {
        this.spawnClaimedRun(job, run, previousReport, previousMetrics, now)
      } else {
        const missed = jobStore.updateRun({ id: run.id, status: 'missed', finishedAt: now })
        broadcast('jobRun:updated', missed)
      }
    }
  }

  // Rebroadcast do job após uma mutação fora de IPC (claim avança next_run_at):
  // relê fresco e emite no MESMO canal que o handler scheduledJobs:update usa.
  private broadcastJobUpdated(jobId: string): void {
    const job = jobStore.get(jobId)
    if (job) broadcast('scheduledJob:updated', job)
  }

  // Poll de runtime: cada job vencido → claim atômico → spawn. O claim re-checa
  // enabled/next_run_at na transação, então double-tick no mesmo instante não
  // cria 2 runs (o 2º claim vê next_run_at já avançado e retorna null).
  tick(): void {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.deps.now()
      for (const job of jobStore.listDueJobs(now)) {
        const previousReport = jobStore.getLastReport(job.id)
        const previousMetrics = jobStore.getLastMetrics(job.id)
        const run = jobStore.claimDueJob(job.id, now)
        if (!run) continue
        // claim avançou next_run_at → a UI precisa do job atualizado ao vivo.
        this.broadcastJobUpdated(job.id)
        this.spawnClaimedRun(job, run, previousReport, previousMetrics, now)
      }
    } catch (err) {
      console.error('[job-scheduler] tick falhou (não-fatal):', err)
    } finally {
      this.ticking = false
    }
  }

  // Dispara um run AD-HOC agora, fora do schedule (paridade com o "Run now" da UI
  // e da tool MCP). NÃO reivindica via claimDueJob: cria a run direto e NÃO toca
  // next_run_at — computeNextRunAt segue a única fonte do agendamento. Reusa o
  // mesmo caminho de disparo (delta-via-prompt + finalização async valem igual).
  // Retorna a run já em 'running' (o runner headless a finaliza async depois).
  runJobNow(jobId: string): JobRun {
    const job = jobStore.get(jobId)
    if (!job) throw new Error(`scheduled job não encontrado: ${jobId}`)
    const now = this.deps.now()
    const previousReport = jobStore.getLastReport(jobId)
    const previousMetrics = jobStore.getLastMetrics(jobId)
    const run = jobStore.createRun({ jobId, status: 'scheduled', model: job.model })
    this.spawnClaimedRun(job, run, previousReport, previousMetrics, now)
    return jobStore.getRun(run.id) ?? run
  }

  // Transiciona a run reivindicada scheduled→running (gravando session_id/
  // cc_session_id = o --session-id gerado agora) e DISPARA o runner headless
  // fire-and-forget — ele finaliza a run async (success/failed) ao sair. A
  // finalização NÃO vem mais do PTY 'exit' (o job roda via `claude -p`). Falha
  // síncrona do disparo (genId/updateRun) marca a run 'failed' e segue; o .catch
  // blinda contra uma rejection escapando do próprio runner (defense-in-depth —
  // o runJob não lança, mas nunca deixar a run presa por unhandledRejection).
  private spawnClaimedRun(
    job: ScheduledJob,
    run: JobRun,
    previousReport: string | null,
    previousMetrics: string | null,
    now: number,
  ): void {
    try {
      const ccSessionId = this.deps.genId()
      const running = jobStore.updateRun({
        id: run.id,
        status: 'running',
        sessionId: ccSessionId,
        ccSessionId,
        startedAt: now,
      })
      // Transição scheduled→running fora de IPC → broadcast pra UI acompanhar ao vivo.
      broadcast('jobRun:updated', running)
      void Promise.resolve(
        this.deps.run({
          ...jobToSpawnParams(job, run, previousReport, previousMetrics),
          ccSessionId,
        }),
      ).catch((err) => {
        console.error(`[job-scheduler] runner do job ${job.id} rejeitou:`, err)
        const failed = jobStore.updateRun({
          id: run.id,
          status: 'failed',
          finishedAt: this.deps.now(),
          error: String((err as Error)?.message ?? err),
        })
        broadcast('jobRun:updated', failed)
      })
    } catch (err) {
      console.error(`[job-scheduler] disparo do job ${job.id} falhou:`, err)
      const failed = jobStore.updateRun({
        id: run.id,
        status: 'failed',
        finishedAt: now,
        error: String((err as Error)?.message ?? err),
      })
      broadcast('jobRun:updated', failed)
    }
  }
}

export const jobScheduler = new JobScheduler()

// Registra a impl real do "run now" no seam leaf (job-run-now.ts) — assim tools.ts
// dispara um run sem importar esta cadeia (evita o ciclo com mcp/server + electron).
setRunJobNow((jobId) => jobScheduler.runJobNow(jobId))
