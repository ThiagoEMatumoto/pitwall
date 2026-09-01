import { describe, expect, it } from 'vitest'
import {
  DESTRUCTIVE_DENYLIST,
  HANDOFF_CHILD_ALLOW,
  HANDOFF_CHILD_ASK,
  HANDOFF_CHILD_DENY,
  HANDOFF_CHILD_SETTINGS_JSON,
  resolveModel,
} from './spawn-flags'

// resolveModel: whitelist do --model derivada do registro canônico
// (shared/models.ts). Fora da lista → null = sem flag (fail-closed).
describe('resolveModel', () => {
  it('aceita todos os aliases canônicos, incluindo fable e opusplan', () => {
    for (const alias of ['fable', 'opus', 'sonnet', 'haiku', 'opusplan']) {
      expect(resolveModel(alias)).toBe(alias)
    }
  })

  it('rejeita valores fora da whitelist (texto livre nunca vira flag)', () => {
    expect(resolveModel('claude-fable-5')).toBeNull()
    expect(resolveModel('opus; rm -rf /')).toBeNull()
    expect(resolveModel('')).toBeNull()
    expect(resolveModel(null)).toBeNull()
    expect(resolveModel(undefined)).toBeNull()
  })
})

// Política de permissões da filha de handoff. O contrato do usuário: pesquisa/
// leitura + MCP + leitura de cloud passam direto; merge, escrita em banco e
// delete não. Os testes travam a regra, não a redação das listas.
describe('HANDOFF_CHILD permissions', () => {
  const settings = JSON.parse(HANDOFF_CHILD_SETTINGS_JSON) as {
    crossSessionInbound: string
    permissions: { allow: string[]; ask: string[]; deny: string[] }
  }

  it('mantém crossSessionInbound=accept (canal peer) ao lado das permissões', () => {
    expect(settings.crossSessionInbound).toBe('accept')
    expect(settings.permissions.allow).toEqual(HANDOFF_CHILD_ALLOW)
    expect(settings.permissions.ask).toEqual(HANDOFF_CHILD_ASK)
    expect(settings.permissions.deny).toEqual(HANDOFF_CHILD_DENY)
  })

  it('libera pesquisa/leitura, git de leitura e inspeção de projeto', () => {
    for (const spec of [
      'Bash(rg:*)',
      'Bash(grep:*)',
      'Bash(find:*)',
      'Bash(ls:*)',
      'Bash(cat:*)',
      'Bash(head:*)',
      'Bash(tail:*)',
      'Bash(wc:*)',
      'Bash(git status:*)',
      'Bash(git log:*)',
      'Bash(git diff:*)',
      'Bash(npm run typecheck:*)',
      'Bash(npm test:*)',
    ]) {
      expect(HANDOFF_CHILD_ALLOW).toContain(spec)
    }
  })

  it('libera leitura de GCP/AWS e o MCP injetado pelo app', () => {
    expect(HANDOFF_CHILD_ALLOW).toContain('Bash(gcloud * describe*)')
    expect(HANDOFF_CHILD_ALLOW).toContain('Bash(gcloud * list*)')
    expect(HANDOFF_CHILD_ALLOW).toContain('Bash(aws * describe-*)')
    expect(HANDOFF_CHILD_ALLOW).toContain('Bash(aws * list-*)')
    // O CLI não aceita curinga entre servidores MCP (mcp__* não casa) — só o
    // nome do servidor. Este é o que o app injeta via --mcp-config.
    expect(HANDOFF_CHILD_ALLOW).toContain('mcp__pitwall')
  })

  it('NÃO libera merge, escrita em banco nem delete', () => {
    const forbidden = [
      'Bash(git merge:*)',
      'Bash(gh pr merge:*)',
      'Bash(psql:*)',
      'Bash(bq query:*)',
      'Bash(rm:*)',
    ]
    for (const spec of forbidden) {
      expect(HANDOFF_CHILD_ALLOW).not.toContain(spec)
    }
    // merge e escrita em banco continuam PEDINDO (reversível com o humano no loop);
    // delete é bloqueado de vez.
    expect(HANDOFF_CHILD_ASK).toContain('Bash(git merge:*)')
    expect(HANDOFF_CHILD_ASK).toContain('Bash(gh pr merge:*)')
    expect(HANDOFF_CHILD_ASK).toContain('Bash(psql:*)')
    expect(HANDOFF_CHILD_ASK).toContain('Bash(bq query:*)')
    expect(HANDOFF_CHILD_DENY).toContain('Bash(rm:*)')
    expect(HANDOFF_CHILD_DENY).toContain('Bash(gcloud * delete*)')
  })

  it('preserva o denylist destrutivo canônico como segunda camada', () => {
    for (const spec of DESTRUCTIVE_DENYLIST) {
      expect(HANDOFF_CHILD_DENY).toContain(spec)
    }
  })

  it('fecha o buraco do allow de find (delete/exec caem no deny)', () => {
    expect(HANDOFF_CHILD_ALLOW).toContain('Bash(find:*)')
    expect(HANDOFF_CHILD_DENY).toContain('Bash(find * -delete*)')
    expect(HANDOFF_CHILD_DENY).toContain('Bash(find * -exec*)')
  })

  it('nenhum spec aparece em duas listas com intenção conflitante', () => {
    const allow = new Set(HANDOFF_CHILD_ALLOW)
    for (const spec of [...HANDOFF_CHILD_ASK, ...HANDOFF_CHILD_DENY]) {
      expect(allow.has(spec)).toBe(false)
    }
  })

  it('o JSON inline sobrevive ao shquote (sem aspas simples nos specs)', () => {
    expect(HANDOFF_CHILD_SETTINGS_JSON).not.toContain("'")
  })
})
