// Política de permissões da filha de handoff exercitada contra comandos reais.
// O matcher abaixo reimplementa a semântica DOCUMENTADA do Claude Code
// (https://code.claude.com/docs/en/permissions — "Wildcard patterns",
// "Compound commands", "Manage permissions"):
//   - `*` casa qualquer texto, inclusive espaços; sem `*` o match é exato;
//   - `:*` no fim equivale a ` *`; ` *` no fim (único curinga) também casa o
//     comando nu (`Bash(ls *)` casa `ls`);
//   - compostos são separados em `&&`, `||`, `;`, `|`, `|&`, `&`; deny/ask valem
//     se QUALQUER subcomando casar, allow exige que TODOS casem;
//   - precedência deny > ask > allow.
// As regras vêm do JSON que o spawn entrega (`HANDOFF_CHILD_SETTINGS_JSON`) e da
// lista que vai pro `--disallowedTools` (resolveDisallowedTools) — não de cópia.
import { describe, expect, it } from 'vitest'
import {
  DESTRUCTIVE_DENYLIST,
  HANDOFF_CHILD_DENY,
  HANDOFF_CHILD_SETTINGS_JSON,
  resolveDisallowedTools,
} from './spawn-flags'
import { claudeProvider } from './providers/claude'

type Decision = 'deny' | 'ask' | 'allow' | 'default'

function ruleToRegex(rule: string): RegExp | null {
  const m = /^Bash\((.*)\)$/.exec(rule)
  if (!m) return null
  let body = m[1]
  if (body.endsWith(':*')) body = body.slice(0, -2) + ' *'
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const stars = body.split('*').length - 1
  if (stars === 1 && body.endsWith(' *')) {
    return new RegExp(`^${esc(body.slice(0, -2))}( .*)?$`)
  }
  return new RegExp(`^${body.split('*').map(esc).join('.*')}$`)
}

function matchesAny(rules: readonly string[], cmd: string): boolean {
  return rules.some((r) => ruleToRegex(r)?.test(cmd) ?? false)
}

function subcommands(cmd: string): string[] {
  return cmd
    .split(/\|&|&&|\|\||;|\||&|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const settings = JSON.parse(HANDOFF_CHILD_SETTINGS_JSON) as {
  permissions: { allow: string[]; ask: string[]; deny: string[] }
}
const childDisallowed = resolveDisallowedTools('acceptEdits', null, { handoffChild: true }) ?? []

function decide(cmd: string): Decision {
  const subs = subcommands(cmd)
  const { allow, ask, deny } = settings.permissions
  if (subs.some((s) => matchesAny(childDisallowed, s) || matchesAny(deny, s))) return 'deny'
  if (subs.some((s) => matchesAny(ask, s))) return 'ask'
  if (subs.every((s) => matchesAny(allow, s))) return 'allow'
  return 'default'
}

describe('matcher de teste reproduz os exemplos da doc oficial', () => {
  const cases: Array<[string, string, boolean]> = [
    ['Bash(npm run build)', 'npm run build', true],
    ['Bash(npm run build)', 'npm run build --watch', false],
    ['Bash(npm run *)', 'npm run', true],
    ['Bash(npm run *)', 'npm install', false],
    ['Bash(git log * main)', 'git log --oneline main', true],
    ['Bash(git log * main)', 'git log main', false],
    ['Bash(git * main)', 'git push origin main', true],
    ['Bash(ls *)', 'ls', true],
    ['Bash(ls *)', 'lsof', false],
    ['Bash(ls*)', 'lsof', true],
    ['Bash(ls:*)', 'ls -la', true],
    ['Bash(* --help *)', 'npm --help', false],
  ]
  it.each(cases)('%s vs %s → %s', (rule, cmd, expected) => {
    expect(matchesAny([rule], cmd)).toBe(expected)
  })
})

describe('política da filha — ALLOW', () => {
  it.each([
    'git push -u origin feat/child-permission-policy',
    'git push -u origin fix/x',
    'git push -u origin chore/bump-deps',
    'git push --set-upstream origin feat/x',
    'git push origin feat/x',
    'git push origin fix/x',
    'git push origin chore/x',
    'gh pr create --title "x" --body "y"',
    'gh pr create',
    'git status && git push -u origin feat/x',
    // nomes que CONTÊM um protegido sem ser ele
    'git push -u origin feat/main',
    'git push origin fix/maintenance-window',
  ])('%s', (cmd) => {
    expect(decide(cmd)).toBe('allow')
  })
})

describe('política da filha — ASK', () => {
  it.each([
    'git push',
    'git push -u',
    'git push origin',
    'git push -u origin',
    'git push origin HEAD',
    'git push -u origin HEAD',
    'git push --set-upstream origin HEAD',
    'git push -u origin feat/x --force-with-lease',
    'git push origin feat/x --tags',
    'git push origin feat/x --no-verify',
    // refspecs/flags extras que atualizam a protegida ou forçam sem nomeá-la
    'git push origin feat/x :',
    "git push origin feat/x 'refs/heads/*:refs/heads/*'",
    'git push origin feat/x HEAD',
    'git push origin feat/x @',
    'git push -u origin feat/x -uf',
    'git push origin feat/x -uf',
    'git push origin feat/x --delet',
    'git push origin feat/x --tag',
    'git push --set-upstream origin feat/x --receive-pack=evil',
    'rm foo.txt',
    'rm -f build.log',
    'rm my-report.txt',
    'bq query "SELECT 1"',
    'bq --project_id=lexter-prod query "DELETE FROM t WHERE 1=1"',
    'bq --location=US --project_id=p query --use_legacy_sql=false "SELECT 1"',
    'git merge main',
    'psql -c "select 1"',
  ])('%s', (cmd) => {
    expect(decide(cmd)).toBe('ask')
  })

  it('push para outro remote ou com flags na frente cai no default (pergunta em acceptEdits)', () => {
    expect(decide('git push upstream feat/x')).toBe('default')
    expect(decide('git push --force-with-lease origin feat/x')).toBe('ask')
  })
})

describe('política da filha — DENY', () => {
  const protectedPushes = ['main', 'master', 'staging', 'develop'].flatMap((b) => [
    `git push origin ${b}`,
    `git push -u origin ${b}`,
    `git push --set-upstream origin ${b}`,
    `git push origin HEAD:${b}`,
    `git push origin feat/x:${b}`,
    `git push -u origin feat/x:${b}`,
    `git push origin feat/x ${b}`,
    `git push origin ${b} --tags`,
    `git push origin HEAD:refs/heads/${b}`,
    `git push origin refs/heads/${b}`,
    `git push origin feat/x:heads/${b}`,
    `git push origin heads/${b}`,
    `git push --force-with-lease origin ${b}`,
    `git push -u origin feat/x --force-with-lease ${b}`,
  ])
  it.each(protectedPushes)('protegida: %s', (cmd) => {
    expect(decide(cmd)).toBe('deny')
  })

  it.each([
    'git push --force',
    'git push --force origin feat/x',
    'git push -f origin feat/x',
    'git push origin feat/x --force',
    'git push -u origin feat/x -f',
    'git push origin +feat/x',
    'git push origin feat/a +feat/b',
    'git push origin --delete feat/x',
    'git push -d origin feat/x',
    'git push origin feat/x :feat/old',
    'git push origin --all',
    'git push --mirror origin',
    'rm -rf node_modules',
    'rm -r dist',
    'rm -fr dist',
    'rm -Rf dist',
    'rm -f -r dist',
    'rm dist -rf',
    'rm --recursive dist',
    'git reset --hard origin/main',
    'git clean -fdx',
    'gcloud run services delete svc',
    'terraform destroy',
    'bq rm -f ds.t',
    'bq --project_id=p rm -f ds.t',
    'find . -delete',
    // deny casa em qualquer subcomando
    'git status && git push origin main',
    'cd /tmp && rm -rf x',
  ])('%s', (cmd) => {
    expect(decide(cmd)).toBe('deny')
  })
})

describe('camada --disallowedTools da filha', () => {
  it('filha autônoma recebe HANDOFF_CHILD_DENY, sem os bloqueios relaxados', () => {
    expect(childDisallowed).toEqual(HANDOFF_CHILD_DENY)
    expect(childDisallowed).not.toContain('Bash(git push:*)')
    expect(childDisallowed).not.toContain('Bash(rm:*)')
  })

  it('o que o settings libera ou pergunta não é bloqueado antes pelo --disallowedTools', () => {
    for (const cmd of ['git push -u origin feat/x', 'gh pr create', 'rm foo.txt', 'git push']) {
      expect(subcommands(cmd).some((s) => matchesAny(childDisallowed, s))).toBe(false)
    }
  })

  it('renderer só reforça: specs extras somam ao canônico da filha', () => {
    const out = resolveDisallowedTools('acceptEdits', ['Bash(curl:*)'], { handoffChild: true })
    expect(out).toContain('Bash(curl:*)')
    for (const spec of HANDOFF_CHILD_DENY) expect(out).toContain(spec)
  })

  it('filha em plan (não autônoma) não ganha --disallowedTools; o settings ainda nega', () => {
    expect(resolveDisallowedTools('plan', null, { handoffChild: true })).toBeNull()
  })

  it('sessão normal autônoma continua com o DESTRUCTIVE_DENYLIST intacto', () => {
    expect(resolveDisallowedTools('acceptEdits', null)).toEqual(DESTRUCTIVE_DENYLIST)
    expect(resolveDisallowedTools('acceptEdits', null, { handoffChild: false })).toEqual(
      DESTRUCTIVE_DENYLIST,
    )
    expect(DESTRUCTIVE_DENYLIST).toContain('Bash(git push:*)')
    expect(DESTRUCTIVE_DENYLIST).toContain('Bash(rm:*)')
  })

  it('o comando montado da filha não carrega git push:* nem rm:* em lugar nenhum', () => {
    const cmd = claudeProvider.buildLaunch({
      command: 'claude',
      sessionId: '00000000-0000-4000-8000-000000000000',
      name: 'handoff: x',
      mcpConfigArg: '',
      model: null,
      systemPromptFilePath: null,
      permissionMode: 'acceptEdits',
      disallowedTools: childDisallowed,
      settingsJson: HANDOFF_CHILD_SETTINGS_JSON,
    })
    expect(cmd).toContain('--disallowedTools')
    expect(cmd).not.toContain("'Bash(git push:*)'")
    expect(cmd).not.toContain('"Bash(git push:*)"')
    expect(cmd).not.toContain("'Bash(rm:*)'")
    expect(cmd).toContain("'Bash(git push * main)'")
  })
})
