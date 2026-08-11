/** @vitest-environment node */
// Unit dos pedaços puros do config MCP: resolvedor de porta (env > pref >
// default, '0' = efêmera) e decisão/execução do cleanup de configs stale no
// caminho de EADDRINUSE — tudo sem subir server nem electron real.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync: mkTmp } = await import('node:fs')
  const { tmpdir: osTmp } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const dir = mkTmp(joinPath(osTmp(), 'mcp-config-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import {
  DEFAULT_MCP_PORT,
  cleanupStaleMcpConfigs,
  decideStaleConfigCleanup,
  parseMcpPortEnv,
  removeSessionMcpConfig,
  resolveMcpPort,
  sessionMcpConfigPath,
  sweepSessionMcpConfigs,
  writeMcpClientConfig,
  writeSessionMcpClientConfig,
} from './config'

const tmpDirs: string[] = []
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-stale-test-'))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

describe('parseMcpPortEnv', () => {
  it('aceita porta válida e 0 (efêmera)', () => {
    expect(parseMcpPortEnv('41957')).toBe(41957)
    expect(parseMcpPortEnv('0')).toBe(0)
    expect(parseMcpPortEnv(' 8080 ')).toBe(8080)
  })

  it('rejeita ausente, vazio, não-numérico e fora de range', () => {
    expect(parseMcpPortEnv(undefined)).toBeNull()
    expect(parseMcpPortEnv('')).toBeNull()
    expect(parseMcpPortEnv('  ')).toBeNull()
    expect(parseMcpPortEnv('abc')).toBeNull()
    expect(parseMcpPortEnv('65536')).toBeNull()
    expect(parseMcpPortEnv('-1')).toBeNull()
    expect(parseMcpPortEnv('41957.5')).toBeNull()
  })
})

describe('resolveMcpPort — precedência env > pref > default', () => {
  it('env vence a pref', () => {
    expect(resolveMcpPort('5000', 6000)).toBe(5000)
  })

  it("env '0' é válido e vence a pref", () => {
    expect(resolveMcpPort('0', 6000)).toBe(0)
  })

  it('env inválido cai pra pref', () => {
    expect(resolveMcpPort('not-a-port', 6000)).toBe(6000)
  })

  it('sem env usa a pref', () => {
    expect(resolveMcpPort(undefined, 6000)).toBe(6000)
  })

  it('pref inválida (0, fora de range, não-inteira, null) cai pro default', () => {
    expect(resolveMcpPort(undefined, 0)).toBe(DEFAULT_MCP_PORT)
    expect(resolveMcpPort(undefined, 65536)).toBe(DEFAULT_MCP_PORT)
    expect(resolveMcpPort(undefined, 41957.5)).toBe(DEFAULT_MCP_PORT)
    expect(resolveMcpPort(undefined, null)).toBe(DEFAULT_MCP_PORT)
  })

  it('sem env e sem pref usa o default', () => {
    expect(resolveMcpPort(undefined, null)).toBe(DEFAULT_MCP_PORT)
  })
})

describe('decideStaleConfigCleanup', () => {
  const alive = () => true
  const dead = () => false

  it('mantém quando o pid é de OUTRO processo vivo (instância legítima)', () => {
    expect(decideStaleConfigCleanup(1234, 9999, alive)).toBe('keep')
  })

  it('deleta quando o pid é o nosso (sobra do próprio boot)', () => {
    expect(decideStaleConfigCleanup(1234, 1234, alive)).toBe('delete')
  })

  it('deleta quando o pid está morto', () => {
    expect(decideStaleConfigCleanup(1234, 9999, dead)).toBe('delete')
  })

  it('deleta quando não há pid (arquivo sem pid/corrompido/ausente)', () => {
    expect(decideStaleConfigCleanup(null, 9999, alive)).toBe('delete')
  })
})

describe('cleanupStaleMcpConfigs', () => {
  it('deleta mcp.json e mcp-client-config.json quando o pid registrado está morto', () => {
    const dir = makeTmpDir()
    const configPath = join(dir, 'mcp.json')
    const clientConfigPath = join(dir, 'mcp-client-config.json')
    // PID improvável de existir: além do range típico de pid_max em uso.
    writeFileSync(
      configPath,
      JSON.stringify({ url: 'http://127.0.0.1:1/mcp', token: 'x'.repeat(64), pid: 2 ** 30 }),
    )
    writeFileSync(clientConfigPath, JSON.stringify({ mcpServers: {} }))

    expect(cleanupStaleMcpConfigs(configPath, clientConfigPath)).toBe('delete')
    expect(existsSync(configPath)).toBe(false)
    expect(existsSync(clientConfigPath)).toBe(false)
  })

  it('deleta config stale herdado mesmo quando o mcp.json é corrompido', () => {
    const dir = makeTmpDir()
    const configPath = join(dir, 'mcp.json')
    const clientConfigPath = join(dir, 'mcp-client-config.json')
    writeFileSync(configPath, 'not json{{')
    writeFileSync(clientConfigPath, JSON.stringify({ mcpServers: {} }))

    expect(cleanupStaleMcpConfigs(configPath, clientConfigPath)).toBe('delete')
    expect(existsSync(configPath)).toBe(false)
    expect(existsSync(clientConfigPath)).toBe(false)
  })

  it('mantém os arquivos quando o pid é de outro processo vivo', () => {
    const dir = makeTmpDir()
    const configPath = join(dir, 'mcp.json')
    const clientConfigPath = join(dir, 'mcp-client-config.json')
    // PID 1 (init/systemd) está sempre vivo e nunca é o processo de teste.
    writeFileSync(
      configPath,
      JSON.stringify({ url: 'http://127.0.0.1:1/mcp', token: 'x'.repeat(64), pid: 1 }),
    )
    writeFileSync(clientConfigPath, JSON.stringify({ mcpServers: {} }))

    expect(cleanupStaleMcpConfigs(configPath, clientConfigPath)).toBe('keep')
    expect(existsSync(configPath)).toBe(true)
    expect(existsSync(clientConfigPath)).toBe(true)
  })

  it('é no-op seguro quando os arquivos não existem', () => {
    const dir = makeTmpDir()
    expect(cleanupStaleMcpConfigs(join(dir, 'mcp.json'), join(dir, 'mcp-client-config.json'))).toBe(
      'delete',
    )
  })
})

describe('mcp-config por sessão (carimbo de identidade da mãe)', () => {
  const INFO = { url: 'http://127.0.0.1:41956/mcp', token: 'x'.repeat(64), pid: 4242 }
  const SESSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

  interface ClientConfig {
    mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
  }

  const readConfig = (path: string): ClientConfig =>
    JSON.parse(readFileSync(path, 'utf8')) as ClientConfig

  it('sem sessionId escreve a config GLOBAL inalterada (url sem query)', () => {
    const path = join(makeTmpDir(), 'mcp-client-config.json')
    writeMcpClientConfig(INFO, path)
    const server = readConfig(path).mcpServers['claude-manager']
    expect(server.url).toBe(INFO.url)
    expect(server.type).toBe('http')
    expect(server.headers.Authorization).toBe(`Bearer ${INFO.token}`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('com sessionId a url ganha ?s=<id> — e o NOME do server não muda', () => {
    const path = join(makeTmpDir(), 'sessao.json')
    writeMcpClientConfig(INFO, path, SESSION_ID)
    const config = readConfig(path)
    // Allowlists de usuário e transcripts referenciam mcp__claude-manager__*.
    expect(Object.keys(config.mcpServers)).toEqual(['claude-manager'])
    const server = config.mcpServers['claude-manager']
    expect(new URL(server.url).searchParams.get('s')).toBe(SESSION_ID)
    expect(server.headers.Authorization).toBe(`Bearer ${INFO.token}`)
  })

  it('writeSessionMcpClientConfig cria <dir>/<id>.json com mode 0600', () => {
    const dir = join(makeTmpDir(), 'mcp-sessions')
    const path = writeSessionMcpClientConfig(INFO, SESSION_ID, dir)
    expect(path).toBe(sessionMcpConfigPath(SESSION_ID, dir))
    expect(path.endsWith(`${SESSION_ID}.json`)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const server = readConfig(path).mcpServers['claude-manager']
    expect(new URL(server.url).searchParams.get('s')).toBe(SESSION_ID)
  })

  it('removeSessionMcpConfig apaga só a config da sessão dada (e é no-op se já sumiu)', () => {
    const dir = join(makeTmpDir(), 'mcp-sessions')
    const other = '11111111-2222-3333-4444-555555555555'
    const path = writeSessionMcpClientConfig(INFO, SESSION_ID, dir)
    const otherPath = writeSessionMcpClientConfig(INFO, other, dir)

    removeSessionMcpConfig(SESSION_ID, dir)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(otherPath)).toBe(true)
    expect(() => removeSessionMcpConfig(SESSION_ID, dir)).not.toThrow()
  })

  it('sweepSessionMcpConfigs limpa os órfãos do boot (nenhuma PTY sobrevive ao quit)', () => {
    const dir = join(makeTmpDir(), 'mcp-sessions')
    writeSessionMcpClientConfig(INFO, SESSION_ID, dir)
    writeSessionMcpClientConfig(INFO, '11111111-2222-3333-4444-555555555555', dir)

    expect(sweepSessionMcpConfigs(dir)).toBe(2)
    expect(existsSync(sessionMcpConfigPath(SESSION_ID, dir))).toBe(false)
    // Diretório ausente é no-op seguro (primeiro boot).
    expect(sweepSessionMcpConfigs(join(makeTmpDir(), 'nao-existe'))).toBe(0)
  })

  it('cleanupStaleMcpConfigs remove TAMBÉM o diretório de configs por sessão', () => {
    const dir = makeTmpDir()
    const configPath = join(dir, 'mcp.json')
    const clientConfigPath = join(dir, 'mcp-client-config.json')
    const sessionDir = join(dir, 'mcp-sessions')
    writeFileSync(
      configPath,
      JSON.stringify({ url: INFO.url, token: INFO.token, pid: 2 ** 30 }),
    )
    writeFileSync(clientConfigPath, JSON.stringify({ mcpServers: {} }))
    writeSessionMcpClientConfig(INFO, SESSION_ID, sessionDir)

    expect(cleanupStaleMcpConfigs(configPath, clientConfigPath, sessionDir)).toBe('delete')
    expect(existsSync(sessionDir)).toBe(false)
  })

  it('mantendo as configs (outra instância viva), o diretório por sessão sobrevive', () => {
    const dir = makeTmpDir()
    const configPath = join(dir, 'mcp.json')
    const clientConfigPath = join(dir, 'mcp-client-config.json')
    const sessionDir = join(dir, 'mcp-sessions')
    // PID 1 (init/systemd) está sempre vivo e nunca é o processo de teste.
    writeFileSync(configPath, JSON.stringify({ url: INFO.url, token: INFO.token, pid: 1 }))
    writeFileSync(clientConfigPath, JSON.stringify({ mcpServers: {} }))
    const path = writeSessionMcpClientConfig(INFO, SESSION_ID, sessionDir)

    expect(cleanupStaleMcpConfigs(configPath, clientConfigPath, sessionDir)).toBe('keep')
    expect(existsSync(path)).toBe(true)
  })
})
