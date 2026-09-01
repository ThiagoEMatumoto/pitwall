import { describe, it, expect, afterEach } from 'vitest'
import { E2E_ENV_FLAG, e2eBootLogLine, isE2E } from './e2e-mode'

describe('isE2E', () => {
  afterEach(() => {
    delete process.env[E2E_ENV_FLAG]
  })

  it('é falso por padrão — sem a flag o app se comporta como sempre', () => {
    expect(isE2E({})).toBe(false)
  })

  it('só liga com o valor exato "1"', () => {
    expect(isE2E({ [E2E_ENV_FLAG]: '1' })).toBe(true)
    expect(isE2E({ [E2E_ENV_FLAG]: '0' })).toBe(false)
    expect(isE2E({ [E2E_ENV_FLAG]: 'true' })).toBe(false)
    expect(isE2E({ [E2E_ENV_FLAG]: '' })).toBe(false)
  })

  it('lê process.env a cada chamada quando nenhum env é passado', () => {
    expect(isE2E()).toBe(false)
    process.env[E2E_ENV_FLAG] = '1'
    expect(isE2E()).toBe(true)
    delete process.env[E2E_ENV_FLAG]
    expect(isE2E()).toBe(false)
  })
})

describe('e2eBootLogLine', () => {
  it('nomeia o sync — o vetor do incidente — na prova de que o modo está ativo', () => {
    const line = e2eBootLogLine()
    expect(line).toContain(`${E2E_ENV_FLAG}=1`)
    expect(line).toContain('sync')
    expect(line).toContain('auto-pull')
  })
})
