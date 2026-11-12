// Estado de GPU decidido no boot, ANTES do app.whenReady (disableHardwareAcceleration
// e switches de ozone só valem pré-ready). O IPC gpu:status lê daqui o que está EM
// VIGOR neste processo — as prefs podem já ter mudado e só aplicam no próximo relaunch.

import { z } from 'zod'
import type { GpuAutoDisabled } from '../../../shared/types/ipc'

export const OZONE_PREF_KEY = 'gpu.ozoneWayland'
// Wayland nativo é o default no Linux: o hint `auto` usa Wayland quando há
// compositor e cai para X11 quando não há, então serve em qualquer sessão. Boot
// e gpu:status leem o default daqui pra não divergirem — divergência viraria um
// "requer reiniciar" fantasma na UI.
export const OZONE_PREF_DEFAULT = true

// gpu.disabled é só a escolha manual. A marca diz que foi o usuário quem gravou:
// sem ela, um gpu.disabled=true é do automático antigo e entra na re-tentativa.
export const GPU_DISABLED_PREF_KEY = 'gpu.disabled'
export const GPU_DISABLED_BY_USER_PREF_KEY = 'gpu.disabledByUser'
export const GPU_AUTO_PREF_KEY = 'gpu.autoDisabled'

export interface GpuState {
  hwAccelDisabled: boolean
  ozoneWayland: boolean
  // Boot que religou a GPU para testar um desligamento automático anterior.
  probation: boolean
}

let state: GpuState = { hwAccelDisabled: false, ozoneWayland: false, probation: false }

export function setGpuState(next: GpuState): void {
  state = next
}

export function getGpuState(): GpuState {
  return state
}

const autoDisabledSchema = z.object({
  at: z.number(),
  reason: z.string(),
  version: z.string(),
  strikes: z.number().int().positive(),
})

export function parseGpuAutoDisabled(value: unknown): GpuAutoDisabled | null {
  const parsed = autoDisabledSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

const DRIVER_CRASH_REASONS = ['crashed', 'oom', 'launch-failed']

// 'killed' é morte externa (OOM killer do sistema, kill manual): o contexto WebGL
// morre do mesmo jeito, então os terminais são avisados, mas não diz nada sobre o
// driver e não conta para o desligamento.
export function notifiesGpuLoss(reason: string): boolean {
  return reason === 'killed' || countsAsGpuCrash(reason)
}

export function countsAsGpuCrash(reason: string): boolean {
  return DRIVER_CRASH_REASONS.includes(reason)
}

export function gpuCrashThreshold(probation: boolean): number {
  return probation ? 1 : 2
}

export function autoDisableRecord(args: {
  previous: GpuAutoDisabled | null
  reason: string
  version: string
  now: number
}): GpuAutoDisabled {
  return {
    at: args.now,
    reason: args.reason,
    version: args.version,
    strikes: (args.previous?.strikes ?? 0) + 1,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
const RETRY_BASE_MS = 3 * DAY_MS
const RETRY_MAX_MS = 30 * DAY_MS
const VERSION_RETRY_MAX_STRIKES = 3
// Nenhuma versão real é vazia: o registro legado sempre conta como troca de versão.
const LEGACY_VERSION = ''

function retryWaitMs(strikes: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (strikes - 1))
}

function shouldRetryGpu(record: GpuAutoDisabled, version: string, now: number): boolean {
  const versionChanged = record.version !== version && record.strikes < VERSION_RETRY_MAX_STRIKES
  return versionChanged || now - record.at >= retryWaitMs(record.strikes)
}

export interface GpuBootInput {
  envDisabled: boolean
  prefDisabled: boolean
  disabledByUser: boolean
  autoDisabled: GpuAutoDisabled | null
  version: string
  now: number
}

// prefDisabled e autoDisabled são o estado das prefs DEPOIS da decisão: quem chama
// grava o que mudou antes de ligar a GPU.
export interface GpuBootDecision {
  hwAccelDisabled: boolean
  probation: boolean
  prefDisabled: boolean
  autoDisabled: GpuAutoDisabled | null
}

export function decideGpuBoot(input: GpuBootInput): GpuBootDecision {
  const legacy = input.prefDisabled && !input.disabledByUser && input.autoDisabled === null
  const prefDisabled = legacy ? false : input.prefDisabled
  const record = legacy
    ? { at: input.now, reason: 'legacy', version: LEGACY_VERSION, strikes: 1 }
    : input.autoDisabled

  if (input.envDisabled || prefDisabled || record === null) {
    return {
      hwAccelDisabled: input.envDisabled || prefDisabled,
      probation: false,
      prefDisabled,
      autoDisabled: record,
    }
  }
  if (!shouldRetryGpu(record, input.version, input.now)) {
    return { hwAccelDisabled: true, probation: false, prefDisabled, autoDisabled: record }
  }
  // Regravar at/version ANTES de ligar consome a tentativa: se o app morrer no
  // teste sem conseguir registrar o crash, o próximo boot volta desligado.
  return {
    hwAccelDisabled: false,
    probation: true,
    prefDisabled,
    autoDisabled: { ...record, at: input.now, version: input.version },
  }
}

// Fiação do boot e do processo: as dependências entram por parâmetro para a
// regra rodar em teste sem Electron nem banco.
export interface GpuPrefs {
  getPref<T>(key: string, fallback: T): T
  setPref(key: string, value: unknown): void
}

// O boot lê as prefs antes do ready: falha de I/O cai no default (GPU ligada).
function readPref<T>(prefs: GpuPrefs, key: string, fallback: T): T {
  try {
    return prefs.getPref(key, fallback)
  } catch {
    return fallback
  }
}

// gpu.disabled é só a escolha manual; o desligamento por crash vive em
// gpu.autoDisabled e é re-tentado (regra em decideGpuBoot). A tentativa é gravada
// ANTES de ligar a GPU: é o que impede um driver quebrado de virar loop de crash.
export function resolveGpuBoot(args: {
  prefs: GpuPrefs
  envDisabled: boolean
  version: string
  now: number
}): { hwAccelDisabled: boolean; probation: boolean } {
  const { prefs } = args
  const input = {
    envDisabled: args.envDisabled,
    prefDisabled: readPref(prefs, GPU_DISABLED_PREF_KEY, false),
    disabledByUser: readPref(prefs, GPU_DISABLED_BY_USER_PREF_KEY, false),
    autoDisabled: parseGpuAutoDisabled(readPref<unknown>(prefs, GPU_AUTO_PREF_KEY, null)),
    version: args.version,
    now: args.now,
  }
  const decision = decideGpuBoot(input)
  try {
    if (decision.prefDisabled !== input.prefDisabled) {
      prefs.setPref(GPU_DISABLED_PREF_KEY, decision.prefDisabled)
    }
    if (decision.autoDisabled !== input.autoDisabled) {
      prefs.setPref(GPU_AUTO_PREF_KEY, decision.autoDisabled)
    }
  } catch (err) {
    console.warn('[gpu] não gravou a decisão de boot:', String(err))
    if (decision.probation) return { hwAccelDisabled: true, probation: false }
  }
  return { hwAccelDisabled: decision.hwAccelDisabled, probation: decision.probation }
}

export interface GpuCrashWatchDeps {
  prefs: GpuPrefs
  // O que resolveGpuBoot decidiu para este processo.
  hwAccelDisabled: boolean
  probation: boolean
  version: string
  now: () => number
  onAutoDisabled: () => void
  notifyCrashed: (payload: { reason: string; count: number }) => void
}

export interface GpuCrashWatch {
  processGone(reason: string): void
  endProbation(): void
}

// Auto-fallback em crash do processo de GPU (driver instável, ex: NVIDIA/
// Wayland): avisa os renderers pra largarem o WebGL (seguem em DOM na mesma
// sessão). No 2º crash do driver (1º num boot de teste), registra o
// desligamento pro PRÓXIMO boot (a flag só vale antes do ready) e avisa o
// usuário. O registro vai antes do aviso: quem reagir ao gpu:crashed já lê o
// gpu:status atualizado.
export function createGpuCrashWatch(deps: GpuCrashWatchDeps): GpuCrashWatch {
  // Crashes de driver nesta execução. Morte externa ('killed') não entra na conta.
  let crashCount = 0
  // Boot de teste: a GPU foi religada depois de um desligamento automático.
  let onProbation = deps.probation

  function recordCrash(reason: string): void {
    crashCount += 1
    // Com a aceleração já desligada o processo que morre é o de software: não diz
    // nada sobre o driver.
    if (deps.hwAccelDisabled || crashCount !== gpuCrashThreshold(onProbation)) return
    // Falha de escrita não pode subir: quem chama ainda precisa avisar os
    // terminais, que só largam o WebGL ao receber o gpu:crashed.
    try {
      deps.prefs.setPref(
        GPU_AUTO_PREF_KEY,
        autoDisableRecord({
          previous: parseGpuAutoDisabled(deps.prefs.getPref<unknown>(GPU_AUTO_PREF_KEY, null)),
          reason,
          version: deps.version,
          now: deps.now(),
        }),
      )
    } catch (err) {
      console.warn('[gpu] não gravou o desligamento automático:', String(err))
      return
    }
    deps.onAutoDisabled()
  }

  return {
    processGone(reason) {
      if (!notifiesGpuLoss(reason)) return
      if (countsAsGpuCrash(reason)) recordCrash(reason)
      console.warn(`[gpu] processo de GPU morreu (${reason}) — crash #${crashCount}`)
      deps.notifyCrashed({ reason, count: crashCount })
    },
    // Com crash no teste o boot segue em teste até o fim: o strike já foi somado e
    // um crash seguinte não pode somar outro na mesma execução.
    endProbation() {
      if (!onProbation || crashCount > 0) return
      // Roda num timer e no shutdown final, antes de matar as PTYs e fechar o
      // banco: falha de escrita não pode interromper nenhum dos dois. O teste só
      // passa quando o registro sai do banco, então a próxima chamada tenta de novo.
      try {
        deps.prefs.setPref(GPU_AUTO_PREF_KEY, null)
        onProbation = false
      } catch (err) {
        console.warn('[gpu] não apagou o registro do boot de teste:', String(err))
      }
    },
  }
}
