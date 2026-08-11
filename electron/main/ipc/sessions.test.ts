/** @vitest-environment node */
// Unit das funções puras extraídas do handler de spawn:
//  - formatPtyInjection: bracketed-paste correto + \r final, multi-linha íntegra.
//  - buildSpawnInnerCmd: montagem das flags (--append-system-prompt-file, --model,
//    --session-id, mcpConfigArg) sem I/O.
import { describe, expect, it, vi } from 'vitest'

// sessions.ts importa electron + módulos de serviço no topo. O teste só exercita
// as funções puras, então mockamos as dependências de I/O pra o import não tocar
// db/pty/mcp reais.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cm-test-userdata' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}))
vi.mock('../services/db', () => ({ getDb: () => ({}) }))
vi.mock('../services/pty-manager', () => ({
  ptyManager: { on: () => {}, off: () => {}, write: () => {} },
}))
vi.mock('../services/feature-store', () => ({ get: () => null }))
vi.mock('../services/feature-memory', () => ({ featureMemory: {} }))
vi.mock('../services/mcp/server', () => ({ getMcpRuntime: () => null }))
vi.mock('../services/mcp/config', () => ({ mcpClientConfigPath: () => '/tmp/mcp.json' }))
vi.mock('../services/session-activity', () => ({
  sessionActivityService: {},
  findTranscriptPath: () => null,
  buildSessionsFileIndex: () => new Map(),
  readTranscriptTitle: () => null,
  readTail: () => null,
  deriveEnrichment: () => ({}),
  isPidAlive: () => false,
  mapStatus: () => 'idle',
}))

import {
  formatPtyInjection,
  buildSpawnInnerCmd,
  resolvePermissionMode,
  resolveDisallowedTools,
} from './sessions'
import { HANDOFF_CHILD_SETTINGS_JSON } from '../services/spawn-flags'
import { buildHandoffAlias } from '../services/handoff/alias'

describe('formatPtyInjection', () => {
  const START = '\x1b[200~'
  const END = '\x1b[201~'

  it('envelopa em bracketed-paste e termina com \\r', () => {
    const out = formatPtyInjection('hello')
    expect(out).toBe(`${START}hello${END}\r`)
    expect(out.startsWith(START)).toBe(true)
    expect(out.endsWith(`${END}\r`)).toBe(true)
  })

  it('preserva conteúdo multi-linha sem \\r entre as linhas internas', () => {
    const cmd = ['## Contexto', 'linha 1', '', 'linha 2'].join('\n')
    const out = formatPtyInjection(cmd)
    // O único Enter (\r) é o final; as quebras internas continuam \n.
    expect(out).toBe(`${START}${cmd}${END}\r`)
    expect((out.match(/\r/g) ?? []).length).toBe(1)
    expect(out.includes('## Contexto\nlinha 1\n\nlinha 2')).toBe(true)
  })
})

describe('buildSpawnInnerCmd', () => {
  const base = {
    claudeCmd: 'claude',
    sessionId: '11111111-1111-1111-1111-111111111111',
    name: 'meu repo',
    mcpConfigArg: ' --mcp-config /tmp/mcp.json',
    model: null as string | null,
    systemPromptFilePath: null as string | null,
  }

  it('inclui --session-id, -n quotado e o mcpConfigArg', () => {
    const cmd = buildSpawnInnerCmd(base)
    expect(cmd).toContain('--session-id 11111111-1111-1111-1111-111111111111')
    expect(cmd).toContain("-n 'meu repo'")
    expect(cmd).toContain('--mcp-config /tmp/mcp.json')
  })

  it('anexa --append-system-prompt-file <path quotado> quando há system-prompt-file', () => {
    const cmd = buildSpawnInnerCmd({ ...base, systemPromptFilePath: '/tmp/cm/handoff-1.md' })
    expect(cmd).toContain("--append-system-prompt-file '/tmp/cm/handoff-1.md'")
  })

  it('NÃO inclui --append-system-prompt-file quando não há path', () => {
    const cmd = buildSpawnInnerCmd(base)
    expect(cmd).not.toContain('--append-system-prompt-file')
  })

  it('anexa --model quando há modelo (já validado)', () => {
    const cmd = buildSpawnInnerCmd({ ...base, model: 'opus' })
    expect(cmd).toContain("--model 'opus'")
  })

  it('anexa --model opusplan (alias hibrido, ja validado contra a whitelist)', () => {
    const cmdOpusplan = buildSpawnInnerCmd({ ...base, model: 'opusplan' })
    expect(cmdOpusplan).toContain("--model 'opusplan'")
  })

  it('anexa --advisor <model> corretamente quotado quando presente', () => {
    const cmdAdvisor = buildSpawnInnerCmd({ ...base, advisorModel: 'opus' })
    expect(cmdAdvisor).toContain("--advisor 'opus'")
  })

  it('nao inclui --advisor quando o advisorModel e null/ausente', () => {
    expect(buildSpawnInnerCmd({ ...base, advisorModel: null })).not.toContain('--advisor')
    expect(buildSpawnInnerCmd(base)).not.toContain('--advisor')
  })

  it('NÃO inclui --model quando o modelo é null', () => {
    const cmd = buildSpawnInnerCmd(base)
    expect(cmd).not.toContain('--model')
  })

  it('anexa --effort quando há nível (já validado)', () => {
    const cmd = buildSpawnInnerCmd({ ...base, effort: 'high' })
    expect(cmd).toContain("--effort 'high'")
  })

  it('NÃO inclui --effort quando o nível é null/ausente', () => {
    expect(buildSpawnInnerCmd({ ...base, effort: null })).not.toContain('--effort')
    expect(buildSpawnInnerCmd(base)).not.toContain('--effort')
  })

  it('anexa --permission-mode quando passado (handoff plan/auto-edits)', () => {
    expect(buildSpawnInnerCmd({ ...base, permissionMode: 'plan' })).toContain(
      "--permission-mode 'plan'",
    )
    expect(buildSpawnInnerCmd({ ...base, permissionMode: 'acceptEdits' })).toContain(
      "--permission-mode 'acceptEdits'",
    )
  })

  it('NÃO inclui --permission-mode quando ausente (comportamento legado)', () => {
    expect(buildSpawnInnerCmd(base)).not.toContain('--permission-mode')
  })

  it('anexa --disallowedTools com cada spec quotado (denylist destrutivo)', () => {
    const cmd = buildSpawnInnerCmd({
      ...base,
      disallowedTools: ['Bash(rm:*)', 'Bash(git push:*)'],
    })
    expect(cmd).toContain("--disallowedTools 'Bash(rm:*)' 'Bash(git push:*)'")
  })

  it('NÃO inclui --disallowedTools quando a lista é vazia/ausente', () => {
    expect(buildSpawnInnerCmd({ ...base, disallowedTools: [] })).not.toContain('--disallowedTools')
    expect(buildSpawnInnerCmd(base)).not.toContain('--disallowedTools')
  })

  it('anexa --settings com o JSON inline quotado (filha de handoff)', () => {
    const cmd = buildSpawnInnerCmd({ ...base, settingsJson: HANDOFF_CHILD_SETTINGS_JSON })
    expect(cmd).toContain(`--settings '${HANDOFF_CHILD_SETTINGS_JSON}'`)
    expect(cmd).toContain('crossSessionInbound')
  })

  // A filha nasce em acceptEdits, que só auto-aceita EDIÇÃO — sem esta política
  // ela para a cada `rg`/`git`/`npm`. O allow/ask/deny viaja no MESMO --settings
  // do crossSessionInbound: um argumento só, uma fonte só.
  it('leva a política allow/ask/deny junto do crossSessionInbound no mesmo --settings', () => {
    const cmd = buildSpawnInnerCmd({ ...base, settingsJson: HANDOFF_CHILD_SETTINGS_JSON })
    const settingsArg = cmd.slice(cmd.indexOf("--settings '") + "--settings '".length)
    const json = settingsArg.slice(0, settingsArg.indexOf("'"))
    const parsed = JSON.parse(json) as {
      crossSessionInbound: string
      permissions: { allow: string[]; ask: string[]; deny: string[] }
    }
    expect(parsed.crossSessionInbound).toBe('accept')
    expect(parsed.permissions.allow).toContain('Bash(rg:*)')
    expect(parsed.permissions.allow).toContain('Bash(git status:*)')
    expect(parsed.permissions.allow).toContain('mcp__claude-manager')
    expect(parsed.permissions.ask).toContain('Bash(git merge:*)')
    expect(parsed.permissions.deny).toContain('Bash(rm:*)')
    // Nada de merge/delete escapando pelo allow.
    expect(parsed.permissions.allow).not.toContain('Bash(git merge:*)')
    expect(parsed.permissions.allow).not.toContain('Bash(rm:*)')
  })

  it('NÃO inclui --settings quando ausente/null (sessão normal, nada global)', () => {
    expect(buildSpawnInnerCmd(base)).not.toContain('--settings')
    expect(buildSpawnInnerCmd({ ...base, settingsJson: null })).not.toContain('--settings')
  })

  it('monta -n <alias> + --settings juntos, e o posicional segue por último', () => {
    const alias = buildHandoffAlias({ role: 'implementer', task: 'Auth refactor (v2)' })
    const cmd = buildSpawnInnerCmd({
      ...base,
      name: alias,
      settingsJson: HANDOFF_CHILD_SETTINGS_JSON,
      systemPromptFilePath: '/tmp/cm/handoff-1.md',
      initialPrompt: 'Comece a tarefa do handoff',
    })
    expect(cmd).toContain("-n 'mauricio-auth-refactor-v2'")
    expect(cmd).toContain(`--settings '${HANDOFF_CHILD_SETTINGS_JSON}'`)
    // --settings precede o system-prompt-file e o posicional fecha o comando.
    expect(cmd.indexOf('--settings')).toBeLessThan(cmd.indexOf('--append-system-prompt-file'))
    expect(cmd.endsWith("'Comece a tarefa do handoff'")).toBe(true)
  })

  it('anexa o initialPrompt como posicional quotado no FIM (auto-submit do 1º turno)', () => {
    const cmd = buildSpawnInnerCmd({
      ...base,
      systemPromptFilePath: '/tmp/cm/handoff-1.md',
      initialPrompt: 'Comece a tarefa do handoff',
    })
    // Posicional TEM que ser o último token, depois de todas as flags.
    expect(cmd.endsWith("'Comece a tarefa do handoff'")).toBe(true)
    // E vem depois do --append-system-prompt-file (não antes de nenhuma flag).
    expect(cmd.indexOf('--append-system-prompt-file')).toBeLessThan(
      cmd.indexOf("'Comece a tarefa do handoff'"),
    )
  })

  it('NÃO anexa posicional quando initialPrompt é ausente/vazio', () => {
    expect(buildSpawnInnerCmd(base)).toContain('--mcp-config /tmp/mcp.json')
    // Sem initialPrompt o comando termina numa flag, não num posicional quotado.
    expect(buildSpawnInnerCmd(base).endsWith('/tmp/mcp.json')).toBe(true)
    expect(buildSpawnInnerCmd({ ...base, initialPrompt: '   ' }).endsWith('/tmp/mcp.json')).toBe(
      true,
    )
  })
})

// O alias é o `-n <name>` da filha e, por tabela, o endereço do SendMessage.
// Aqui olhamos o par alias→innerCmd; as regras do slug em si vivem em
// services/handoff/alias.test.ts.
describe('alias da filha de handoff no innerCmd', () => {
  const base = {
    claudeCmd: 'claude',
    sessionId: '11111111-1111-1111-1111-111111111111',
    name: '',
    mcpConfigArg: '',
    model: null as string | null,
    systemPromptFilePath: null as string | null,
  }

  it('entrada com acento/espaço/parêntese vira kebab estrito no -n', () => {
    const alias = buildHandoffAlias({
      role: 'investigator',
      task: 'Investigar migração de sessões (peer)',
    })
    expect(alias).toBe('otavio-investigar-migracao-sessoes')
    expect(alias).toMatch(/^[a-z0-9-]+$/)
    // Sem espaço no alias, o -n sai quotado mas sem escape interno.
    expect(buildSpawnInnerCmd({ ...base, name: alias })).toContain(
      "-n 'otavio-investigar-migracao-sessoes'",
    )
  })

  it('é único contra as sessões vivas (não repete o -n de quem já está no ar)', () => {
    const live = ['mauricio-auth-refactor']
    const alias = buildHandoffAlias({
      role: 'implementer',
      task: 'Auth refactor',
      taken: live,
    })
    expect(live).not.toContain(alias)
    expect(buildSpawnInnerCmd({ ...base, name: alias })).toContain("-n 'rafael-auth-refactor'")
  })
})

describe('resolvePermissionMode', () => {
  const VALID = ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk']

  it('aceita TODOS os 6 modos da CLI', () => {
    for (const mode of VALID) {
      expect(resolvePermissionMode(mode)).toBe(mode)
    }
  })

  it('rejeita valores inválidos (vira null = sem flag)', () => {
    expect(resolvePermissionMode('yolo')).toBeNull()
    expect(resolvePermissionMode('Plan')).toBeNull() // case-sensitive
    expect(resolvePermissionMode('')).toBeNull()
    expect(resolvePermissionMode(null)).toBeNull()
    expect(resolvePermissionMode(undefined)).toBeNull()
  })
})

describe('resolveDisallowedTools', () => {
  it('mescla o denylist destrutivo nos modos autônomos', () => {
    for (const mode of ['acceptEdits', 'auto', 'bypassPermissions']) {
      const out = resolveDisallowedTools(mode, [])
      expect(out).toContain('Bash(rm:*)')
      expect(out).toContain('Bash(git push:*)')
    }
  })

  it('NÃO mescla o denylist em modos não-autônomos (plan/default/dontAsk/null)', () => {
    for (const mode of ['plan', 'default', 'dontAsk', null]) {
      expect(resolveDisallowedTools(mode, [])).toBeNull()
    }
  })

  it('preserva o denylist do renderer e deduplica ao mesclar', () => {
    const out = resolveDisallowedTools('acceptEdits', ['Bash(rm:*)', 'Custom(x)'])
    expect(out).toContain('Custom(x)')
    // 'Bash(rm:*)' veio do renderer E do canônico — sem duplicata.
    expect(out!.filter((t) => t === 'Bash(rm:*)')).toHaveLength(1)
  })

  it('em modo não-autônomo devolve só o denylist do renderer (ou null se vazio)', () => {
    expect(resolveDisallowedTools('plan', ['Custom(x)'])).toEqual(['Custom(x)'])
    expect(resolveDisallowedTools(null, [])).toBeNull()
    expect(resolveDisallowedTools('default', ['', 123 as unknown as string])).toBeNull()
  })
})
