import { describe, it, expect } from 'vitest'
import {
  autoDisableRecord,
  countsAsGpuCrash,
  decideGpuBoot,
  gpuCrashThreshold,
  notifiesGpuLoss,
  parseGpuAutoDisabled,
  type GpuBootInput,
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
