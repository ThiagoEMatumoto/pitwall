import { describe, expect, it } from 'vitest'
import {
  DESTRUCTIVE_DENYLIST,
  HANDOFF_CHILD_ALLOW,
  HANDOFF_CHILD_ASK,
  HANDOFF_CHILD_DENY,
  HANDOFF_CHILD_RELAXED_FROM_DESTRUCTIVE,
  HANDOFF_CHILD_PLAN_DENY,
  HANDOFF_CHILD_SETTINGS_JSON,
  HANDOFF_CHILD_WRITE_ALLOW,
  deriveChildAllowRule,
  handoffChildSettings,
  isLearnableChildRule,
  handoffChildSettingsJson,
  permissionModeForHandoffMode,
  resolvePermissionMode,
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
    expect(settings.permissions.allow).toEqual([
      ...HANDOFF_CHILD_ALLOW,
      ...HANDOFF_CHILD_WRITE_ALLOW,
    ])
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
    // merge, escrita em banco e delete simples continuam PEDINDO (o humano
    // autoriza na hora); delete recursivo/cloud é bloqueado de vez.
    expect(HANDOFF_CHILD_ASK).toContain('Bash(git merge:*)')
    expect(HANDOFF_CHILD_ASK).toContain('Bash(gh pr merge:*)')
    expect(HANDOFF_CHILD_ASK).toContain('Bash(psql:*)')
    expect(HANDOFF_CHILD_ASK).toContain('Bash(bq query:*)')
    expect(HANDOFF_CHILD_ASK).toContain('Bash(rm:*)')
    expect(HANDOFF_CHILD_DENY).toContain('Bash(rm -r*)')
    expect(HANDOFF_CHILD_DENY).toContain('Bash(gcloud * delete*)')
  })

  it('preserva o denylist destrutivo canônico, menos o relaxado (rm simples, push de feat/*)', () => {
    for (const spec of DESTRUCTIVE_DENYLIST) {
      if (HANDOFF_CHILD_RELAXED_FROM_DESTRUCTIVE.includes(spec)) {
        expect(HANDOFF_CHILD_DENY).not.toContain(spec)
      } else {
        expect(HANDOFF_CHILD_DENY).toContain(spec)
      }
    }
    expect(HANDOFF_CHILD_RELAXED_FROM_DESTRUCTIVE).toEqual(['Bash(rm:*)', 'Bash(git push:*)'])
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

// Filha plan: o deny de escrita mora no settings do PROCESSO, então sobrevive ao
// ExitPlanMode aprovado no TUI (que troca o modo sem tocar handoffs.mode).
describe('handoffChildSettingsJson', () => {
  type Settings = {
    crossSessionInbound: string
    permissions: { allow: string[]; ask: string[]; deny: string[] }
  }
  const planSettings = JSON.parse(
    handoffChildSettingsJson(resolvePermissionMode(permissionModeForHandoffMode('plan'))),
  ) as Settings

  it('nega edição, commit, add, push e rm à filha plan', () => {
    for (const rule of [
      'Edit',
      'Write',
      'NotebookEdit',
      'Bash(git commit:*)',
      'Bash(git push:*)',
      'Bash(git add:*)',
      'Bash(rm:*)',
    ]) {
      expect(planSettings.permissions.deny).toContain(rule)
    }
    expect(planSettings.permissions.deny).toEqual(expect.arrayContaining(HANDOFF_CHILD_DENY))
  })

  it('mantém leitura, testes e o canal peer na filha plan', () => {
    expect(planSettings.crossSessionInbound).toBe('accept')
    expect(planSettings.permissions.allow).toEqual(HANDOFF_CHILD_ALLOW)
    expect(planSettings.permissions.allow).toContain('Bash(rg:*)')
    expect(planSettings.permissions.allow).toContain('Bash(npm run test:*)')
    expect(planSettings.permissions.allow).toContain('mcp__pitwall')
    expect(planSettings.permissions.ask).toEqual(HANDOFF_CHILD_ASK)
  })

  it('não muda a política das filhas que escrevem', () => {
    for (const mode of ['auto-edits', 'interactive']) {
      const pm = resolvePermissionMode(permissionModeForHandoffMode(mode))
      expect(handoffChildSettingsJson(pm)).toBe(HANDOFF_CHILD_SETTINGS_JSON)
    }
    const common = JSON.parse(HANDOFF_CHILD_SETTINGS_JSON) as Settings
    for (const rule of HANDOFF_CHILD_PLAN_DENY.filter((r) => !r.startsWith('Bash('))) {
      expect(common.permissions.deny).not.toContain(rule)
    }
  })

  it('não leva aspa simples (vai inline num argumento shell-quoted)', () => {
    expect(handoffChildSettingsJson('plan')).not.toContain("'")
  })
})

// Filha que implementa: allow de escrita local (forense: `cd … &&`, stash, install,
// mkdir/cp eram os pedidos que paravam a filha). plan não ganha nada disso.
describe('handoffChildSettings — escrita por modo', () => {
  const WRITE_SAMPLES = [
    'Bash(cd:*)',
    'Bash(mkdir:*)',
    'Bash(npm install:*)',
    'Bash(npx:*)',
    'Bash(git add:*)',
    'Bash(git commit:*)',
    'Bash(git stash push:*)',
    'Bash(git worktree add:*)',
    'Bash(sed:*)',
    'Bash(make:*)',
  ]

  it('acceptEdits, interactive (null) e auto recebem o allow de escrita', () => {
    for (const mode of ['acceptEdits', null, 'auto']) {
      const allow = handoffChildSettings(mode).permissions.allow
      for (const r of WRITE_SAMPLES) expect(allow, `${mode}: ${r}`).toContain(r)
    }
  })

  it('plan NÃO recebe o allow de escrita e mantém o deny de escrita', () => {
    const { allow, deny } = handoffChildSettings('plan').permissions
    for (const r of HANDOFF_CHILD_WRITE_ALLOW) expect(allow).not.toContain(r)
    for (const r of ['Edit', 'Write', 'Bash(git commit:*)', 'Bash(git add:*)']) {
      expect(deny).toContain(r)
    }
  })

  it('o deny destrutivo continua igual em modo de escrita', () => {
    const { deny, ask } = handoffChildSettings('acceptEdits').permissions
    for (const r of [
      'Bash(rm -r*)',
      'Bash(git push * main)',
      'Bash(git push * --force)',
      'Bash(gcloud * delete*)',
      'Bash(gcloud * add-iam-policy-binding*)',
    ]) {
      expect(deny).toContain(r)
    }
    for (const r of [
      'Bash(git merge:*)',
      'Bash(gh pr merge:*)',
      'Bash(npm run migrate:*)',
      'Bash(psql:*)',
      'Bash(chmod *-R*)',
      'Bash(git commit *--no-verify*)',
      'Bash(git switch *--discard-changes*)',
      'Bash(git switch -f*)',
    ]) {
      expect(ask).toContain(r)
    }
  })

  it('nenhuma regra de escrita é anulada por deny exato (estaria morta)', () => {
    const { deny } = handoffChildSettings('acceptEdits').permissions
    for (const r of HANDOFF_CHILD_WRITE_ALLOW) expect(deny).not.toContain(r)
  })

  it('libera push da branch do worktree automático (child/*)', () => {
    expect(HANDOFF_CHILD_ALLOW).toContain('Bash(git push -u origin child/*)')
  })
})

describe('regras aprendidas ("Sempre permitir para filhas")', () => {
  it('entram no allow de todos os modos', () => {
    for (const mode of ['acceptEdits', 'plan', null]) {
      const allow = handoffChildSettings(mode, [
        'Bash(bq ls *)',
        'Bash(terraform fmt *)',
        'Bash(jest *)',
      ]).permissions.allow
      expect(allow).toContain('Bash(jest *)')
    }
  })

  it('regra adulterada na pref (deny/ask, curinga solto, wrapper) é descartada', () => {
    const allow = handoffChildSettings('acceptEdits', [
      'Bash(rm *)',
      'Bash(git push *)',
      'Bash(git *)',
      'Bash(*)',
      'Bash(sudo *)',
      'Bash(bq query *)',
      'Edit',
      42,
    ]).permissions.allow
    for (const r of [
      'Bash(rm *)',
      'Bash(git push *)',
      'Bash(git *)',
      'Bash(*)',
      'Bash(sudo *)',
      'Bash(bq query *)',
    ]) {
      expect(allow).not.toContain(r)
    }
  })

  it('isLearnableChildRule: aceita prefixo de comando seguro e MCP', () => {
    expect(isLearnableChildRule('Bash(jest *)')).toBe(true)
    expect(isLearnableChildRule('Bash(docker-compose *)')).toBe(false) // down -v apaga volume
    expect(isLearnableChildRule('mcp__linear__get_issue')).toBe(true)
    expect(isLearnableChildRule('mcp__*')).toBe(false)
    expect(isLearnableChildRule('Bash(gh api *)')).toBe(false) // gh api -X PUT .../merge contorna o ask
    expect(isLearnableChildRule('Bash(gh pr *)')).toBe(false) // gh pr merge é ask
    expect(isLearnableChildRule('Bash(gcloud run *)')).toBe(false) // família com deny
  })
})

describe('deriveChildAllowRule', () => {
  it('composto com cd: ignora o cd e usa o primeiro comando real', () => {
    expect(deriveChildAllowRule('Bash', 'cd /home/u/repo && jest --watch=false')).toBe(
      'Bash(jest *)',
    )
  })

  it('ferramenta com subcomando leva dois tokens', () => {
    expect(deriveChildAllowRule('Bash', 'gh issue view 3')).toBe('Bash(gh issue *)')
    expect(deriveChildAllowRule('Bash', 'cargo clippy --all')).toBe('Bash(cargo clippy *)')
  })

  it('nunca deriva regra para comando do deny/ask ou wrapper', () => {
    for (const cmd of [
      'rm -rf node_modules',
      'git push origin main',
      'git stash drop',
      'bq query "select 1"',
      'gcloud run deploy x',
      'sudo apt install x',
      'bash -c "rm -rf /"',
      'echo $(rm x)',
      './scripts/deploy.sh',
      'FOO=1 jest',
      // `*` aprendido contornaria ask/deny ou destruiria trabalho
      'gh api -X PUT repos/a/b/pulls/1/merge',
      'git restore .',
      'git branch -D feat/x',
      'git tag -d v1',
      'unlink f.txt',
      'truncate -s0 f.txt',
      'rsync -a --delete a/ b/',
      'terraform apply',
      'perl -e 1',
      'awk 1 f',
    ]) {
      expect(deriveChildAllowRule('Bash', cmd), cmd).toBeNull()
    }
  })

  it('MCP: a regra é o nome exato da tool', () => {
    expect(deriveChildAllowRule(undefined, 'linear - get_issue (MCP) mcp__linear__get_issue')).toBe(
      'mcp__linear__get_issue',
    )
  })

  it('Edit/Write não viram regra', () => {
    expect(deriveChildAllowRule('Edit', 'src/a.ts')).toBeNull()
  })
})
