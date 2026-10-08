import { describe, expect, it } from 'vitest'
import { composeHandoffPrompt, type HandoffEdge } from './compose-prompt'
import {
  PROTECTED_BRANCHES,
  handoffChildSettingsJson,
  permissionModeForHandoffMode,
} from '../spawn-flags'

describe('composeHandoffPrompt', () => {
  const edges: HandoffEdge[] = [
    { kind: 'calls-api', label: null, direction: 'from-mother' },
    { kind: 'shares-types', label: null, direction: 'to-mother' },
  ]

  const prompt = composeHandoffPrompt({
    targetRepoLabel: 'backend',
    targetRepoPath: '/repos/backend',
    motherRepoLabel: 'frontend',
    task: 'Adicionar endpoint de health-check',
    edges,
    featureTitle: 'Observabilidade',
    handoffId: 'h-123',
    alias: 'mauricio-h-123',
  })

  it('contém as 4 seções do template', () => {
    expect(prompt).toContain('## Contexto')
    expect(prompt).toContain('## Tarefa')
    expect(prompt).toContain('## Restrições')
    expect(prompt).toContain('## Reporte')
  })

  it('inclui a task e o featureTitle', () => {
    expect(prompt).toContain('Adicionar endpoint de health-check')
    expect(prompt).toContain('Observabilidade')
  })

  it('descreve cada kind com a frase natural correta', () => {
    expect(prompt).toContain('consome a API') // calls-api
    expect(prompt).toContain('compartilha tipos') // shares-types
  })

  it('orienta a frase pela direção da aresta', () => {
    // from-mother: mãe é o sujeito
    expect(prompt).toContain('o repo frontend consome a API este repo (backend)')
    // to-mother: este repo é o sujeito
    expect(prompt).toContain('este repo (backend) compartilha tipos o repo frontend')
  })

  it('embute o handoffId na instrução de handoff_report e o cap 250', () => {
    expect(prompt).toContain('handoff_report')
    expect(prompt).toContain('handoffId="h-123"')
    expect(prompt).toContain('250')
  })

  it('lista o repo alvo e seu path nas restrições', () => {
    expect(prompt).toContain('SOMENTE neste repo (backend, /repos/backend)')
  })

  it('cobre os 4 kinds novos da Wave A com frases PT-BR', () => {
    const cases: Array<[HandoffEdge['kind'], string]> = [
      ['work-hub', 'coordena o trabalho sobre'],
      ['infra', 'provisiona a infra de'],
      ['monorepo', 'contém'],
      ['documents', 'documenta'],
    ]
    for (const [kind, phrase] of cases) {
      const p = composeHandoffPrompt({
        targetRepoLabel: 'svc',
        targetRepoPath: '/repos/svc',
        task: 't',
        edges: [{ kind, label: null, direction: 'from-mother' }],
        handoffId: 'h-x',
        alias: 'mauricio-h-x',
      })
      expect(p).toContain(phrase)
    }
  })

  it('kind desconhecido cai no genérico "se relaciona com"', () => {
    const p = composeHandoffPrompt({
      targetRepoLabel: 'svc',
      targetRepoPath: '/repos/svc',
      task: 't',
      edges: [{ kind: 'whatever', label: null, direction: 'from-mother' }],
      handoffId: 'h-x',
      alias: 'mauricio-h-x',
    })
    expect(p).toContain('se relaciona com')
  })

  it('instrui handoff_progress (andamento) + report só após verificação', () => {
    const p = composeHandoffPrompt({
      targetRepoLabel: 'svc',
      targetRepoPath: '/repos/svc',
      task: 't',
      edges: [],
      handoffId: 'h-prog',
      alias: 'mauricio-h-prog',
    })
    expect(p).toContain('handoff_progress')
    expect(p).toContain('handoff_report')
    expect(p).toMatch(/concluído|verificad/i)
  })

  it('instrui handoff_ask para decisões da mãe (com o handoffId)', () => {
    const p = composeHandoffPrompt({
      targetRepoLabel: 'svc',
      targetRepoPath: '/repos/svc',
      task: 't',
      edges: [],
      handoffId: 'h-ask',
      alias: 'mauricio-h-ask',
    })
    expect(p).toContain('handoff_ask')
    expect(p).toContain('handoffId="h-ask"')
    expect(p).toMatch(/decis|arquitetural/i)
  })

  it('anuncia a identidade da filha: apelido, escopo e handoffId', () => {
    expect(prompt).toContain('## Identidade')
    expect(prompt).toContain('Seu apelido: mauricio-h-123')
    expect(prompt).toContain('Seu escopo: backend — Adicionar endpoint de health-check')
    expect(prompt).toContain('handoffId: h-123')
  })

  it('define o canal de volta sem depender de saber quem é a mãe de antemão', () => {
    expect(prompt).toContain('## Canais')
    // O interlocutor é quem escreveu primeiro; a resposta copia o `from`.
    expect(prompt).toMatch(/remetente da primeira mensagem/i)
    expect(prompt).toContain('<cross-session-message>')
    expect(prompt).toContain('SendMessage')
  })

  it('proíbe falar com o humano e com outras filhas (convenção, não enforcement)', () => {
    expect(prompt).toMatch(/NÃO fala com o humano/i)
    expect(prompt).toMatch(/NÃO fala com outras sessões filhas/i)
  })

  it('exige evidência positiva no report e nega "parece pronto"', () => {
    expect(prompt).toMatch(/EVID[ÊE]NCIA POSITIVA/i)
    expect(prompt).toContain('comando rodado + output observado')
    expect(prompt).toMatch(/Parece pronto/i)
  })

  it('traz circuit breaker de 3 tentativas e o formato de BLOQUEIO', () => {
    expect(prompt).toMatch(/3 tentativas/i)
    expect(prompt).toContain('BLOQUEIO:')
    expect(prompt).toContain('OPÇÕES:')
    expect(prompt).toContain('RECOMENDO:')
    expect(prompt).toContain('CUSTO DE ERRAR:')
  })

  it('plan mode injeta restrição read-only; auto-edits avisa do denylist', () => {
    const plan = composeHandoffPrompt({
      targetRepoLabel: 'svc',
      targetRepoPath: '/repos/svc',
      task: 't',
      edges: [],
      handoffId: 'h1',
      alias: 'mauricio-h1',
      mode: 'plan',
    })
    expect(plan).toMatch(/PLAN MODE|read-only/i)

    const auto = composeHandoffPrompt({
      targetRepoLabel: 'svc',
      targetRepoPath: '/repos/svc',
      task: 't',
      edges: [],
      handoffId: 'h2',
      alias: 'mauricio-h2',
      mode: 'auto-edits',
    })
    expect(auto).toMatch(/auto-edits|destrutivos/i)
  })
})

describe('composeHandoffPrompt — filha Codex', () => {
  // O Codex sobe sem -n e sem inbox cross-session: SendMessage não existe pra ele.
  const codex = composeHandoffPrompt({
    targetRepoLabel: 'backend',
    targetRepoPath: '/repos/backend',
    task: 'Investigar a fila',
    edges: [],
    handoffId: 'h-9',
    alias: 'leitor-fila',
    mode: 'plan',
    provider: 'codex',
  })

  it('não manda responder por SendMessage nem cita <cross-session-message>', () => {
    expect(codex).not.toContain('SendMessage')
    expect(codex).not.toContain('<cross-session-message>')
  })

  it('o canal é o terminal (handoff_message) e o log é handoff_progress/handoff_ask', () => {
    expect(codex).toContain('handoff_progress')
    expect(codex).toContain('handoff_ask')
    expect(codex).toContain('handoff_report')
  })
})

describe('composeHandoffPrompt — context da mãe', () => {
  const base = {
    targetRepoLabel: 'backend',
    targetRepoPath: '/repos/backend',
    task: 'Implementar endpoint',
    edges: [],
    handoffId: 'h-ctx',
    alias: 'mauricio-endpoint',
  }

  it('renderiza o context numa seção própria, antes da Tarefa', () => {
    const prompt = composeHandoffPrompt({ ...base, context: '  Já decidido: usar zod.  ' })
    expect(prompt).toContain('## Contexto da mãe\nJá decidido: usar zod.\n\n## Tarefa')
  })

  it('omite a seção quando o context é ausente ou só espaço', () => {
    expect(composeHandoffPrompt(base)).not.toContain('## Contexto da mãe')
    expect(composeHandoffPrompt({ ...base, context: '   ' })).not.toContain('## Contexto da mãe')
  })
})

describe('composeHandoffPrompt — briefing alinhado à política de permissões da filha', () => {
  // A filha kaizen travou porque o briefing proibia push/PR que o settings libera.
  // O settings vem do produtor real (handoffChildSettingsJson), não de fixture.
  const base = {
    targetRepoLabel: 'svc',
    targetRepoPath: '/repos/svc',
    task: 't',
    edges: [] as HandoffEdge[],
    handoffId: 'h-pol',
    alias: 'mauricio-h-pol',
  }
  const settings = JSON.parse(handoffChildSettingsJson(permissionModeForHandoffMode('auto-edits')))
  const { allow, ask, deny } = settings.permissions as Record<'allow' | 'ask' | 'deny', string[]>

  for (const mode of ['auto-edits', 'interactive', undefined] as const) {
    it(`mode=${mode ?? 'default'}: libera push de branch de trabalho e PR, como o settings`, () => {
      const p = composeHandoffPrompt({ ...base, mode })
      expect(p).not.toMatch(/Proibido: git push/)
      expect(p).not.toMatch(/Proibido:[^\n]*criar PR/)
      for (const prefix of ['feat/*', 'fix/*', 'chore/*']) {
        expect(p).toContain(prefix)
        expect(allow).toContain(`Bash(git push -u origin ${prefix})`)
      }
      expect(p).toContain('gh pr create')
      expect(allow).toContain('Bash(gh pr create:*)')
    })

    it(`mode=${mode ?? 'default'}: proíbe push em protegida, force push e merge — e o settings também`, () => {
      const p = composeHandoffPrompt({ ...base, mode })
      const proibido = p.split('\n').find((l) => l.includes('Proibido:')) ?? ''
      for (const b of PROTECTED_BRANCHES) {
        expect(proibido).toContain(b)
        expect(deny).toContain(`Bash(git push * ${b})`)
      }
      expect(proibido).toContain('force push')
      expect(deny).toContain('Bash(git push * --force)')
      expect(proibido).toMatch(/merge de PR/)
      expect(ask).toContain('Bash(gh pr merge:*)')
      expect(allow).not.toContain('Bash(gh pr merge:*)')
      for (const item of ['deploy', 'migration destrutiva', 'alterar config global']) {
        expect(proibido).toContain(item)
      }
    })
  }

  it('auto-edits descreve rm como confirmação e rm -r como bloqueado, como o settings', () => {
    const p = composeHandoffPrompt({ ...base, mode: 'auto-edits' })
    expect(p).toContain('`rm` pede confirmação')
    expect(ask).toContain('Bash(rm:*)')
    expect(deny).toContain('Bash(rm -r*)')
    expect(deny).toContain('Bash(git reset --hard:*)')
    expect(deny).toContain('Bash(git clean:*)')
  })

  it('plan e Codex (read-only) seguem proibindo commit/push/PR, como o deny do plan', () => {
    const planDeny = JSON.parse(handoffChildSettingsJson(permissionModeForHandoffMode('plan')))
      .permissions.deny as string[]
    expect(planDeny).toContain('Bash(git push:*)')
    expect(planDeny).toContain('Bash(git commit:*)')
    for (const p of [
      composeHandoffPrompt({ ...base, mode: 'plan' }),
      composeHandoffPrompt({ ...base, mode: 'plan', provider: 'codex' }),
    ]) {
      expect(p).toMatch(/Proibido: commit, git push, criar PR/)
      expect(p).not.toContain('Publicar é livre')
    }
  })
})
