/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { codexProvider, CODEX_MCP_TOKEN_ENV } from './codex'
import { getProvider } from './registry'

const URL = 'http://127.0.0.1:47821/mcp?s=22222222-2222-2222-2222-222222222222'
const mcpConfigArg = codexProvider.mcpInject({ configPath: '', url: URL })

const base = {
  command: 'codex',
  sessionId: '11111111-1111-1111-1111-111111111111',
  name: 'ignorado pelo codex',
  mcpConfigArg,
  model: null,
  systemPromptFilePath: null,
}

describe('codexProvider.mcpInject', () => {
  it('url do MCP do Pitwall como string TOML e bearer lido de env', () => {
    expect(mcpConfigArg).toBe(
      ` -c 'mcp_servers.pitwall.url="${URL}"'` +
        ` -c 'mcp_servers.pitwall.bearer_token_env_var="${CODEX_MCP_TOKEN_ENV}"'`,
    )
  })

  it('sem url (server MCP não subiu) não injeta nada', () => {
    expect(codexProvider.mcpInject({ configPath: '/x.json' })).toBe('')
  })

  it('o token vai pelo env da PTY, nunca pela linha de comando', () => {
    expect(codexProvider.mcpEnv?.({ token: 'tok-123' })).toEqual({
      [CODEX_MCP_TOKEN_ENV]: 'tok-123',
    })
    expect(mcpConfigArg).not.toContain('tok-123')
  })
})

describe('codexProvider.buildLaunch', () => {
  it('sessão nova padrão: workspace-write + on-request, inline e com o MCP', () => {
    expect(codexProvider.buildLaunch(base)).toBe(
      `codex --no-alt-screen -s 'workspace-write' -a 'on-request'${mcpConfigArg}`,
    )
  })

  it('plan vira read-only', () => {
    expect(codexProvider.buildLaunch({ ...base, permissionMode: 'plan' })).toBe(
      `codex --no-alt-screen -s 'read-only' -a 'on-request'${mcpConfigArg}`,
    )
  })

  it('modelo, instruções de sistema e prompt inicial posicional no fim', () => {
    const cmd = codexProvider.buildLaunch({
      ...base,
      model: 'gpt-5-codex',
      permissionMode: 'acceptEdits',
      systemPromptText: 'Contexto "do" repo\nlinha 2',
      initialPrompt: "  Comece a tarefa do Thiago's\n",
    })
    expect(cmd).toBe(
      `codex --no-alt-screen -s 'workspace-write' -a 'on-request'${mcpConfigArg}` +
        ` -m 'gpt-5-codex'` +
        ` -c 'developer_instructions="Contexto \\"do\\" repo\\nlinha 2"'` +
        ` 'Comece a tarefa do Thiago'\\''s'`,
    )
  })

  it('ignora o que é só do claude (resume, effort, advisor, denylist, settings)', () => {
    const cmd = codexProvider.buildLaunch({
      ...base,
      resume: true,
      effort: 'high',
      advisorModel: 'opus',
      disallowedTools: ['Bash(rm:*)'],
      settingsJson: '{"a":1}',
    })
    expect(cmd).toBe(codexProvider.buildLaunch(base))
  })

  it('nunca sai com sandbox aberta nem sem aprovação, nem em bypassPermissions', () => {
    const cmd = codexProvider.buildLaunch({ ...base, permissionMode: 'bypassPermissions' })
    expect(cmd).not.toContain('danger-full-access')
    expect(cmd).not.toContain('--dangerously')
    expect(cmd).not.toMatch(/-a 'never'/)
  })
})

describe('codexProvider', () => {
  it('resolveCommand usa app_prefs.codex_command e cai em codex', () => {
    expect(
      codexProvider.resolveCommand((k) => (k === 'codex_command' ? '/opt/codex' : undefined)),
    ).toBe('/opt/codex')
    expect(codexProvider.resolveCommand(() => undefined)).toBe('codex')
  })

  it('sem id nativo: resume/transcript/menus/chat desligados', () => {
    expect(codexProvider.supports).toEqual({
      resume: false,
      nativeTranscript: false,
      tuiMenus: false,
      permissionModes: true,
      chatView: false,
    })
    expect(codexProvider.discoverNativeId()).toBeNull()
  })

  it('está registrado', () => {
    expect(getProvider('codex')).toBe(codexProvider)
  })
})
