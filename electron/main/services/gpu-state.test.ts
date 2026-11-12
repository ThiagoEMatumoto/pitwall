import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  autoDisableRecord,
  countsAsGpuCrash,
  createGpuCrashWatch,
  decideGpuBoot,
  gpuCrashThreshold,
  notifiesGpuLoss,
  parseGpuAutoDisabled,
  resolveGpuBoot,
  GPU_AUTO_PREF_KEY,
  GPU_DISABLED_PREF_KEY,
  type GpuBootInput,
  type GpuPrefs,
} from './gpu-state'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 12)

function boot(overrides: Partial<GpuBootInput>): GpuBootInput {
  return {
    envDisabled: false,
    prefDisabled: false,
    disabledByUser: false,
    autoDisabled: null,
    version: '1.0.0',
    now: T0,
    ...overrides,
  }
}

// O registro que entra nos testes de boot sai do mesmo produtor que o handler de
// child-process-gone usa, e passa pelo JSON do app_prefs como em produção.
function storedRecord(strikes: number, version = '1.0.0', at = T0) {
  let record = autoDisableRecord({ previous: null, reason: 'crashed', version, now: at })
  for (let i = 1; i < strikes; i++) {
    record = autoDisableRecord({ previous: record, reason: 'crashed', version, now: at })
  }
  const parsed = parseGpuAutoDisabled(JSON.parse(JSON.stringify(record)))
  if (parsed === null) throw new Error('o registro produzido não foi lido de volta')
  return parsed
}

describe('crash de GPU que conta', () => {
  it('morte externa avisa os terminais mas não conta como crash de driver', () => {
    expect(notifiesGpuLoss('killed')).toBe(true)
    expect(countsAsGpuCrash('killed')).toBe(false)
  })

  it('crash, falta de memória e falha ao subir contam e avisam', () => {
    for (const reason of ['crashed', 'oom', 'launch-failed']) {
      expect(countsAsGpuCrash(reason)).toBe(true)
      expect(notifiesGpuLoss(reason)).toBe(true)
    }
  })

  it('saída limpa não avisa nem conta', () => {
    expect(notifiesGpuLoss('clean-exit')).toBe(false)
    expect(countsAsGpuCrash('clean-exit')).toBe(false)
  })

  it('um boot de teste desliga no primeiro crash; um boot normal, no segundo', () => {
    expect(gpuCrashThreshold(true)).toBe(1)
    expect(gpuCrashThreshold(false)).toBe(2)
  })
})

describe('autoDisableRecord', () => {
  it('o primeiro desligamento automático vale um strike', () => {
    expect(autoDisableRecord({ previous: null, reason: 'oom', version: '1.0.0', now: T0 })).toEqual(
      {
        at: T0,
        reason: 'oom',
        version: '1.0.0',
        strikes: 1,
      },
    )
  })

  it('um crash no boot de teste soma um strike ao registro anterior', () => {
    const previous = storedRecord(1)
    const next = autoDisableRecord({
      previous,
      reason: 'crashed',
      version: '1.1.0',
      now: T0 + DAY,
    })
    expect(next).toEqual({ at: T0 + DAY, reason: 'crashed', version: '1.1.0', strikes: 2 })
    expect(previous.strikes).toBe(1)
  })
})

describe('parseGpuAutoDisabled', () => {
  it('devolve null para pref ausente, apagada ou fora do formato', () => {
    expect(parseGpuAutoDisabled(null)).toBeNull()
    expect(parseGpuAutoDisabled(undefined)).toBeNull()
    expect(parseGpuAutoDisabled(true)).toBeNull()
    expect(parseGpuAutoDisabled({ at: T0, reason: 'crashed', version: '1.0.0' })).toBeNull()
    expect(
      parseGpuAutoDisabled({ at: T0, reason: 'crashed', version: '1.0.0', strikes: 0 }),
    ).toBeNull()
  })
})

describe('decideGpuBoot', () => {
  it('sem pref nem registro, a GPU sobe ligada e fora de teste', () => {
    expect(decideGpuBoot(boot({}))).toEqual({
      hwAccelDisabled: false,
      probation: false,
      prefDisabled: false,
      autoDisabled: null,
    })
  })

  it('mesma versão e dentro do prazo: fica desligada e o registro não muda', () => {
    const record = storedRecord(1)
    const decision = decideGpuBoot(boot({ autoDisabled: record, now: T0 + 2 * DAY }))
    expect(decision.hwAccelDisabled).toBe(true)
    expect(decision.probation).toBe(false)
    // Mesma referência = nada a gravar: o boot só escreve a pref que mudou.
    expect(decision.autoDisabled).toBe(record)
  })

  it('versão nova religa uma vez, e o registro regravado não religa no boot seguinte', () => {
    const record = storedRecord(1)
    const retry = decideGpuBoot(boot({ autoDisabled: record, version: '1.1.0', now: T0 + DAY }))
    expect(retry.hwAccelDisabled).toBe(false)
    expect(retry.probation).toBe(true)
    expect(retry.autoDisabled).toEqual({ ...record, at: T0 + DAY, version: '1.1.0' })

    const next = decideGpuBoot(
      boot({ autoDisabled: retry.autoDisabled, version: '1.1.0', now: T0 + DAY + 60_000 }),
    )
    expect(next.hwAccelDisabled).toBe(true)
    expect(next.probation).toBe(false)
  })

  it('prazo vencido religa uma vez, e o registro regravado não religa no boot seguinte', () => {
    const record = storedRecord(1)
    expect(
      decideGpuBoot(boot({ autoDisabled: record, now: T0 + 3 * DAY - 1 })).hwAccelDisabled,
    ).toBe(true)

    const retry = decideGpuBoot(boot({ autoDisabled: record, now: T0 + 3 * DAY }))
    expect(retry.hwAccelDisabled).toBe(false)
    expect(retry.probation).toBe(true)

    const next = decideGpuBoot(
      boot({ autoDisabled: retry.autoDisabled, now: T0 + 3 * DAY + 60_000 }),
    )
    expect(next.hwAccelDisabled).toBe(true)
  })

  it('o prazo dobra a cada strike e para em 30 dias', () => {
    const waits = [1, 2, 3, 4, 5, 9].map((strikes) => {
      const record = storedRecord(strikes)
      const stillOff = decideGpuBoot(boot({ autoDisabled: record, now: T0 + 30 * DAY - 1 }))
      const firstRetryDay = [3, 6, 12, 24, 30].find(
        (days) =>
          !decideGpuBoot(boot({ autoDisabled: record, now: T0 + days * DAY })).hwAccelDisabled,
      )
      return { firstRetryDay, offJustBefore30d: stillOff.hwAccelDisabled }
    })
    expect(waits.map((w) => w.firstRetryDay)).toEqual([3, 6, 12, 24, 30, 30])
    expect(waits.slice(4).every((w) => w.offJustBefore30d)).toBe(true)
  })

  it('a partir do terceiro strike a troca de versão não religa: só o prazo', () => {
    const record = storedRecord(3)
    const newVersion = decideGpuBoot(
      boot({ autoDisabled: record, version: '2.0.0', now: T0 + DAY }),
    )
    expect(newVersion.hwAccelDisabled).toBe(true)

    const afterWait = decideGpuBoot(
      boot({ autoDisabled: record, version: '2.0.0', now: T0 + 12 * DAY }),
    )
    expect(afterWait.hwAccelDisabled).toBe(false)
    expect(afterWait.probation).toBe(true)
  })

  it('crash no boot de teste soma um strike e o boot seguinte fica desligado', () => {
    const retry = decideGpuBoot(boot({ autoDisabled: storedRecord(1), now: T0 + 3 * DAY }))
    const afterCrash = autoDisableRecord({
      previous: retry.autoDisabled,
      reason: 'crashed',
      version: '1.0.0',
      now: T0 + 3 * DAY + 5_000,
    })
    expect(afterCrash.strikes).toBe(2)
    expect(
      decideGpuBoot(boot({ autoDisabled: afterCrash, now: T0 + 3 * DAY + 60_000 })).hwAccelDisabled,
    ).toBe(true)
  })

  it('desligado pelo usuário nunca é revertido, nem com versão nova e prazo vencido', () => {
    const record = storedRecord(1)
    const decision = decideGpuBoot(
      boot({
        prefDisabled: true,
        disabledByUser: true,
        autoDisabled: record,
        version: '9.0.0',
        now: T0 + 365 * DAY,
      }),
    )
    expect(decision).toEqual({
      hwAccelDisabled: true,
      probation: false,
      prefDisabled: true,
      autoDisabled: record,
    })
  })

  it('CM_DISABLE_GPU desliga sem gastar a tentativa do registro', () => {
    const record = storedRecord(1)
    const decision = decideGpuBoot(
      boot({ envDisabled: true, autoDisabled: record, version: '1.1.0', now: T0 + 10 * DAY }),
    )
    expect(decision.hwAccelDisabled).toBe(true)
    expect(decision.probation).toBe(false)
    // Mesma referência = nada a gravar: o boot só escreve a pref que mudou.
    expect(decision.autoDisabled).toBe(record)
  })

  describe('legado: gpu.disabled=true gravado pelo automático antigo', () => {
    const legacy = boot({ prefDisabled: true, disabledByUser: false, autoDisabled: null })

    it('vira registro automático com um strike e religa na troca de versão', () => {
      const decision = decideGpuBoot(legacy)
      expect(decision).toEqual({
        hwAccelDisabled: false,
        probation: true,
        prefDisabled: false,
        autoDisabled: { at: T0, reason: 'legacy', version: '1.0.0', strikes: 1 },
      })
    })

    it('religa uma vez só: o boot seguinte na mesma versão fica desligado', () => {
      const first = decideGpuBoot(legacy)
      const second = decideGpuBoot(
        boot({
          prefDisabled: first.prefDisabled,
          autoDisabled: first.autoDisabled,
          now: T0 + 60_000,
        }),
      )
      expect(second.hwAccelDisabled).toBe(true)
      expect(second.probation).toBe(false)
      expect(second.prefDisabled).toBe(false)
    })

    it('com CM_DISABLE_GPU migra a pref mas guarda a tentativa para o boot sem a variável', () => {
      const withEnv = decideGpuBoot({ ...legacy, envDisabled: true })
      expect(withEnv.hwAccelDisabled).toBe(true)
      expect(withEnv.prefDisabled).toBe(false)
      expect(withEnv.autoDisabled?.strikes).toBe(1)

      const withoutEnv = decideGpuBoot(
        boot({
          prefDisabled: withEnv.prefDisabled,
          autoDisabled: withEnv.autoDisabled,
          now: T0 + 60_000,
        }),
      )
      expect(withoutEnv.hwAccelDisabled).toBe(false)
      expect(withoutEnv.probation).toBe(true)
    })
  })
})

// Mesmo contrato do prefs-store: JSON por chave, fallback quando não há linha.
function memoryPrefs() {
  const rows = new Map<string, string>()
  const failing = new Set<string>()
  const prefs: GpuPrefs = {
    getPref<T>(key: string, fallback: T): T {
      const raw = rows.get(key)
      return raw === undefined ? fallback : (JSON.parse(raw) as T)
    },
    setPref(key, value) {
      if (failing.has(key)) throw new Error(`disk I/O error (${key})`)
      rows.set(key, JSON.stringify(value))
    },
  }
  return {
    prefs,
    read: (key: string) => prefs.getPref<unknown>(key, undefined),
    failWritesTo: (key: string) => failing.add(key),
    writesWorkAgain: () => failing.clear(),
  }
}

type MemoryPrefs = ReturnType<typeof memoryPrefs>

// Um processo do app: o boot decide, e a mesma decisão alimenta a escuta de
// crashes, como em electron/main/index.ts.
function startApp(store: MemoryPrefs, at = T0, version = '1.0.0') {
  const boot = resolveGpuBoot({ prefs: store.prefs, envDisabled: false, version, now: at })
  const crashed: Array<{ reason: string; count: number }> = []
  const toasts: number[] = []
  const watch = createGpuCrashWatch({
    prefs: store.prefs,
    hwAccelDisabled: boot.hwAccelDisabled,
    probation: boot.probation,
    version,
    now: () => at + 60_000,
    onAutoDisabled: () => toasts.push(at),
    notifyCrashed: (payload) => crashed.push(payload),
  })
  return { boot, watch, crashed, toasts }
}

// Chega ao boot de teste pelo caminho real: dois crashes desligam, e o prazo de
// 3 dias religa.
function startProbationBoot(store: MemoryPrefs) {
  const first = startApp(store)
  first.watch.processGone('crashed')
  first.watch.processGone('crashed')
  const app = startApp(store, T0 + 3 * DAY + 60_000)
  expect(app.boot).toEqual({ hwAccelDisabled: false, probation: true })
  return app
}

describe('fiação do crash e do boot de teste', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('boot normal: o segundo crash de driver grava o registro e avisa uma vez', () => {
    const store = memoryPrefs()
    const app = startApp(store)
    expect(app.boot).toEqual({ hwAccelDisabled: false, probation: false })

    app.watch.processGone('crashed')
    expect(store.read(GPU_AUTO_PREF_KEY)).toBeUndefined()

    app.watch.processGone('oom')
    app.watch.processGone('crashed')
    expect(store.read(GPU_AUTO_PREF_KEY)).toEqual({
      at: T0 + 60_000,
      reason: 'oom',
      version: '1.0.0',
      strikes: 1,
    })
    expect(app.toasts).toHaveLength(1)
    expect(app.crashed).toEqual([
      { reason: 'crashed', count: 1 },
      { reason: 'oom', count: 2 },
      { reason: 'crashed', count: 3 },
    ])
    expect(startApp(store, T0 + 120_000).boot).toEqual({ hwAccelDisabled: true, probation: false })
  })

  it('quit limpo no boot de teste apaga o registro e o boot seguinte sobe fora de teste', () => {
    const store = memoryPrefs()
    const app = startProbationBoot(store)

    app.watch.endProbation()

    expect(store.read(GPU_AUTO_PREF_KEY)).toBeNull()
    expect(startApp(store, T0 + 4 * DAY).boot).toEqual({ hwAccelDisabled: false, probation: false })
  })

  it('crash durante a tentativa soma um strike e impede o quit de apagar o registro', () => {
    const store = memoryPrefs()
    const app = startProbationBoot(store)

    app.watch.processGone('crashed')
    app.watch.endProbation()

    expect(store.read(GPU_AUTO_PREF_KEY)).toMatchObject({ reason: 'crashed', strikes: 2 })
    expect(app.toasts).toHaveLength(1)
    expect(startApp(store, T0 + 4 * DAY).boot).toEqual({ hwAccelDisabled: true, probation: false })
  })

  it('um crash a mais na mesma tentativa não soma outro strike', () => {
    const store = memoryPrefs()
    const app = startProbationBoot(store)

    app.watch.processGone('crashed')
    app.watch.processGone('crashed')

    expect(store.read(GPU_AUTO_PREF_KEY)).toMatchObject({ strikes: 2 })
  })

  it("'killed' avisa os terminais mas não conta: o teste ainda passa no quit", () => {
    const store = memoryPrefs()
    const app = startProbationBoot(store)

    app.watch.processGone('killed')

    expect(app.crashed).toEqual([{ reason: 'killed', count: 0 }])
    expect(store.read(GPU_AUTO_PREF_KEY)).toMatchObject({ strikes: 1 })
    expect(app.toasts).toHaveLength(0)

    app.watch.endProbation()
    expect(store.read(GPU_AUTO_PREF_KEY)).toBeNull()
  })

  it("'killed' num boot normal nunca desliga, por mais que se repita", () => {
    const store = memoryPrefs()
    const app = startApp(store)

    for (let i = 0; i < 5; i++) app.watch.processGone('killed')

    expect(store.read(GPU_AUTO_PREF_KEY)).toBeUndefined()
    expect(app.crashed).toHaveLength(5)
  })

  it('saída limpa do processo de GPU não avisa ninguém', () => {
    const app = startApp(memoryPrefs())
    app.watch.processGone('clean-exit')
    expect(app.crashed).toEqual([])
  })

  it('depois que o teste passa o limite volta a ser dois crashes', () => {
    const store = memoryPrefs()
    const app = startProbationBoot(store)
    app.watch.endProbation()

    app.watch.processGone('crashed')
    expect(store.read(GPU_AUTO_PREF_KEY)).toBeNull()

    app.watch.processGone('crashed')
    expect(store.read(GPU_AUTO_PREF_KEY)).toMatchObject({ strikes: 1 })
  })

  it('falha ao gravar o registro não impede o aviso de crash aos terminais', () => {
    const store = memoryPrefs()
    const app = startApp(store)
    store.failWritesTo(GPU_AUTO_PREF_KEY)

    app.watch.processGone('crashed')
    expect(() => app.watch.processGone('crashed')).not.toThrow()

    expect(app.crashed).toEqual([
      { reason: 'crashed', count: 1 },
      { reason: 'crashed', count: 2 },
    ])
    // Nada foi desligado: o toast diria o contrário.
    expect(store.read(GPU_AUTO_PREF_KEY)).toBeUndefined()
    expect(app.toasts).toHaveLength(0)
  })

  it('falha ao gravar o strike do boot de teste também não impede o aviso', () => {
    const store = memoryPrefs()
    const app = startProbationBoot(store)
    store.failWritesTo(GPU_AUTO_PREF_KEY)

    expect(() => app.watch.processGone('crashed')).not.toThrow()

    expect(app.crashed).toEqual([{ reason: 'crashed', count: 1 }])
    expect(store.read(GPU_AUTO_PREF_KEY)).toMatchObject({ strikes: 1 })
  })

  it('falha ao apagar o registro não sobe para o shutdown, e o quit tenta de novo', () => {
    const store = memoryPrefs()
    const app = startProbationBoot(store)
    store.failWritesTo(GPU_AUTO_PREF_KEY)

    // O timer de 10 min.
    expect(() => app.watch.endProbation()).not.toThrow()
    expect(store.read(GPU_AUTO_PREF_KEY)).toMatchObject({ strikes: 1 })

    // O shutdown final, com o banco gravando de novo.
    store.writesWorkAgain()
    app.watch.endProbation()
    expect(store.read(GPU_AUTO_PREF_KEY)).toBeNull()
  })

  it('enquanto o registro não sai do banco, um crash ainda soma strike sobre ele', () => {
    const store = memoryPrefs()
    const app = startProbationBoot(store)
    store.failWritesTo(GPU_AUTO_PREF_KEY)
    app.watch.endProbation()
    store.writesWorkAgain()

    app.watch.processGone('crashed')

    expect(store.read(GPU_AUTO_PREF_KEY)).toMatchObject({ strikes: 2 })
  })

  it('com a aceleração já desligada um crash não diz nada sobre o driver', () => {
    const store = memoryPrefs()
    const first = startApp(store)
    first.watch.processGone('crashed')
    first.watch.processGone('crashed')
    const app = startApp(store, T0 + 60_000)
    expect(app.boot.hwAccelDisabled).toBe(true)

    app.watch.processGone('crashed')
    app.watch.processGone('crashed')

    expect(store.read(GPU_AUTO_PREF_KEY)).toMatchObject({ strikes: 1 })
    expect(app.toasts).toHaveLength(0)
    expect(app.crashed).toHaveLength(2)
  })
})
