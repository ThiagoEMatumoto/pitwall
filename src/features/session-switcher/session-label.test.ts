import { describe, expect, it } from 'vitest'
import { liveSessionLabel, liveSessionTitleIsAuto } from './session-label'

const repo = { label: 'pitwall' } as never

describe('liveSessionLabel — rótulo único das superfícies de sessão', () => {
  it('mãe com auto-título mostra o auto-título no lugar do nome do repo', () => {
    expect(
      liveSessionLabel({ title: null, name: 'pitwall', repo, autoTitle: 'Corrige login' }),
    ).toBe('Corrige login')
  })

  it('rename manual vence o auto-título', () => {
    expect(
      liveSessionLabel({
        title: 'meu nome',
        titleSource: 'manual',
        name: 'pitwall',
        repo,
        autoTitle: 'Corrige login',
      }),
    ).toBe('meu nome')
  })

  it('sem manual nem auto, comportamento atual (título do transcript > nome > repo)', () => {
    expect(liveSessionLabel({ title: 'ai title', name: 'pitwall', repo })).toBe('ai title')
    expect(liveSessionLabel({ title: null, name: null, repo })).toBe('pitwall')
    expect(liveSessionLabel({ title: null, name: null, repo: null })).toBe('Avulsa')
  })

  it('o título derivado do transcript não conta como manual', () => {
    expect(
      liveSessionLabel({
        title: 'ai title',
        titleSource: null,
        name: 'x',
        repo,
        autoTitle: 'Auto',
      }),
    ).toBe('Auto')
  })

  it('liveSessionTitleIsAuto diz se o rótulo veio do auto-título', () => {
    expect(liveSessionTitleIsAuto({ title: null, autoTitle: 'Auto' })).toBe(true)
    expect(liveSessionTitleIsAuto({ title: 'm', titleSource: 'manual', autoTitle: 'Auto' })).toBe(
      false,
    )
    expect(liveSessionTitleIsAuto({ title: null, autoTitle: null })).toBe(false)
  })
})
