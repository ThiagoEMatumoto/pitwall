/** @vitest-environment node */
// Unit das funções puras extraídas do handler de spawn:
//  - formatPtyInjection: bracketed-paste correto + \r final, multi-linha íntegra.
//  - buildSpawnInnerCmd: montagem das flags (--append-system-prompt-file, --model,
//    --session-id, mcpConfigArg) sem I/O.
// E, com os seams de I/O falsificados, os TRÊS call sites de spawn: cada um
// carimba a identidade da sessão no --mcp-config (arquivo por sessions.id).
import { beforeEach, describe, expect, it, vi } from 'vitest'

// sessions.ts importa electron + módulos de serviço no topo. Mockamos as
// dependências de I/O pra o import não tocar db/pty/mcp reais; o estado
// compartilhado com os fakes vive num objeto hoisted (vi.mock é içado).
const seam = vi.hoisted(() => ({
  // Handlers registrados por registerSessionIpc (ipcMain.handle).
  handlers: new Map<string, (event: unknown, ...args: never[]) => unknown>(),
  // PTYs disparadas: { sessionId, innerCmd }.
  spawns: [] as Array<{ sessionId: string; innerCmd: string }>,
  // Linhas gravadas em `sessions` (args do INSERT).
  insertedSessionIds: [] as string[],
  // Configs MCP por sessão escritas/removidas.
  writtenSessionConfigs: [] as string[],
  removedSessionConfigs: [] as string[],
  // Runtime do MCP server (null = server não subiu).
  runtime: null as { url: string; token: string } | null,
  transcriptPath: null as string | null,
  handoff: null as Record<string, unknown> | null,
  childRow: null as { cc_session_id: string | null; title: string | null } | null,
}))

const SESSION_CONFIG_DIR = '/tmp/cm-test-userdata/mcp-sessions'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cm-test-userdata' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: never[]) => unknown) => {
      seam.handlers.set(channel, fn)
    },
  },
}))
vi.mock('../services/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT INTO sessions')) seam.insertedSessionIds.push(args[0] as string)
        return { changes: 1 }
      },
      get: (..._args: unknown[]) => {
        if (sql.includes('FROM repos')) return { path: '/tmp', label: 'Repo X' }
        if (sql.includes('FROM sessions')) return seam.childRow ?? undefined
        return undefined
      },
      all: () => [],
    }),
  }),
}))
vi.mock('../services/pty-manager', () => ({
  ptyManager: {
    on: () => {},
    off: () => {},
    write: () => {},
    isRunning: () => true,
    runningIds: () => [],
    spawn: (opts: { sessionId: string; args: string[] }) => {
      seam.spawns.push({ sessionId: opts.sessionId, innerCmd: opts.args.join(' ') })
    },
  },
}))
vi.mock('../services/custom-env', () => ({ sessionSpawnEnv: () => ({}) }))
vi.mock('../services/feature-store', () => ({ get: () => null, linkedObjectiveTitles: () => [] }))
vi.mock('../services/feature-memory', () => ({ featureMemory: { onSessionExit: () => {} } }))
vi.mock('../services/handoff-store', () => ({
  get: () => seam.handoff,
  markRunning: (id: string, childSessionId: string) => ({ id, childSessionId, status: 'running' }),
  getByChildSession: () => null,
  failIfRunning: () => null,
}))
vi.mock('../services/mcp/server', () => ({ getMcpRuntime: () => seam.runtime }))
vi.mock('../services/mcp/config', () => ({
  mcpClientConfigPath: () => '/tmp/mcp.json',
  writeSessionMcpClientConfig: (_info: unknown, sessionId: string) => {
    const path = `${SESSION_CONFIG_DIR}/${sessionId}.json`
    seam.writtenSessionConfigs.push(path)
    return path
  },
  removeSessionMcpConfig: (sessionId: string) => {
    seam.removedSessionConfigs.push(sessionId)
  },
}))
vi.mock('../services/session-activity', () => ({
  sessionActivityService: {},
  findTranscriptPath: () => seam.transcriptPath,
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
  registerSessionIpc,
  resolvePermissionMode,
  resolveDisallowedTools,
  spawnSession,
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

// O servidor MCP é compartilhado por todas as sessões: sem carimbo no spawn, uma
// tool não sabe quem a chamou (era o mother_session_id null em 62/62 registros).
// Aqui provamos o carimbo nos TRÊS call sites — e que o id do arquivo é o mesmo
// sessions.id gravado no banco.
describe('carimbo de identidade no --mcp-config (3 call sites)', () => {
  const CC_SESSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

  beforeEach(() => {
    seam.handlers.clear()
    seam.spawns.length = 0
    seam.insertedSessionIds.length = 0
    seam.writtenSessionConfigs.length = 0
    seam.removedSessionConfigs.length = 0
    seam.runtime = { url: 'http://127.0.0.1:41956/mcp', token: 'tok' }
    seam.transcriptPath = '/tmp/transcript.jsonl'
    seam.childRow = { cc_session_id: CC_SESSION_ID, title: 'mauricio-tarefa' }
    seam.handoff = {
      id: 'h1',
      status: 'interrupted',
      childSessionId: 'child-1',
      targetRepoId: 'r1',
      featureId: null,
    }
    registerSessionIpc()
  })

  function handler(channel: string): (event: unknown, ...args: never[]) => unknown {
    const fn = seam.handlers.get(channel)
    if (!fn) throw new Error(`handler não registrado: ${channel}`)
    return fn
  }

  // O contrato que interessa: o --mcp-config aponta pro arquivo DESTA sessão, e
  // o nome do arquivo é exatamente o sessions.id persistido.
  function expectStampedSpawn(): string {
    expect(seam.spawns).toHaveLength(1)
    const { sessionId, innerCmd } = seam.spawns[0]
    expect(innerCmd).toContain(`--mcp-config '${SESSION_CONFIG_DIR}/${sessionId}.json'`)
    expect(innerCmd).not.toContain('/tmp/mcp.json')
    expect(seam.writtenSessionConfigs).toEqual([`${SESSION_CONFIG_DIR}/${sessionId}.json`])
    expect(seam.insertedSessionIds).toEqual([sessionId])
    return sessionId
  }

  it('spawn novo (spawnSession) carimba a sessão', () => {
    const session = spawnSession({ repoId: 'r1', name: 'sessao nova' })
    expect(expectStampedSpawn()).toBe(session.id)
  })

  it('sessions:resume carimba a sessão retomada (mãe em potencial)', () => {
    const session = handler('sessions:resume')(null, {
      repoId: 'r1',
      ccSessionId: CC_SESSION_ID,
    } as never) as { id: string }
    expect(expectStampedSpawn()).toBe(session.id)
    expect(seam.spawns[0].innerCmd).toContain(`--resume ${CC_SESSION_ID}`)
  })

  it('handoffs:resume carimba a filha retomada (que também vira mãe)', () => {
    handler('handoffs:resume')(null, 'h1' as never)
    const sessionId = expectStampedSpawn()
    // O alias fixado no spawn sobrevive ao resume — o carimbo não o desloca.
    expect(seam.spawns[0].innerCmd).toContain("-n 'mauricio-tarefa'")
    expect(seam.spawns[0].innerCmd).toContain(`--mcp-config '${SESSION_CONFIG_DIR}/${sessionId}.json'`)
  })

  it('sem MCP server no ar não injeta --mcp-config nem escreve config por sessão', () => {
    seam.runtime = null
    spawnSession({ repoId: 'r1', name: 'sem mcp' })
    expect(seam.spawns[0].innerCmd).not.toContain('--mcp-config')
    expect(seam.writtenSessionConfigs).toEqual([])
  })

  it('falha ao escrever a config da sessão degrada pro arquivo global (não derruba o spawn)', async () => {
    const config = await import('../services/mcp/config')
    const spy = vi.spyOn(config, 'writeSessionMcpClientConfig').mockImplementation(() => {
      throw new Error('EACCES')
    })
    try {
      spawnSession({ repoId: 'r1', name: 'degradada' })
      expect(seam.spawns[0].innerCmd).toContain("--mcp-config '/tmp/mcp.json'")
    } finally {
      spy.mockRestore()
    }
  })
})
