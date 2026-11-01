/** @vitest-environment node */
// Snapshots do innerCmd gerados pela implementação ANTERIOR ao seam
// (buildSpawnInnerCmd em ipc/sessions.ts). O refactor só é válido se o provider
// devolve a mesma string byte a byte.
import { describe, expect, it } from 'vitest'
import { claudeProvider } from './claude'
import { getProvider } from './registry'

const base = {
  command: 'claude',
  sessionId: '11111111-1111-1111-1111-111111111111',
  name: "repo do Thiago's",
  mcpConfigArg: " --mcp-config '/tmp/mcp.json'",
  model: null,
  systemPromptFilePath: null,
}

describe('claudeProvider.buildLaunch', () => {
  it('sessão nova', () => {
    expect(claudeProvider.buildLaunch(base)).toBe(
      "claude --session-id 11111111-1111-1111-1111-111111111111 -n 'repo do Thiago'\\''s' --mcp-config '/tmp/mcp.json'",
    )
  })

  it('resume', () => {
    expect(claudeProvider.buildLaunch({ ...base, resume: true })).toBe(
      "claude --resume 11111111-1111-1111-1111-111111111111 -n 'repo do Thiago'\\''s' --mcp-config '/tmp/mcp.json'",
    )
  })

  it('com modelo, effort, advisor, permission-mode, settings e system-prompt', () => {
    const cmd = claudeProvider.buildLaunch({
      ...base,
      model: 'opus',
      effort: 'high',
      advisorModel: 'sonnet',
      permissionMode: 'acceptEdits',
      settingsFilePath: '/tmp/cm/session-settings/s1.json',
      systemPromptFilePath: '/tmp/cm/feat-1.md',
    })
    expect(cmd).toBe(
      "claude --session-id 11111111-1111-1111-1111-111111111111 -n 'repo do Thiago'\\''s' --mcp-config '/tmp/mcp.json' --model 'opus' --effort 'high' --advisor 'sonnet' --permission-mode 'acceptEdits' --settings '/tmp/cm/session-settings/s1.json' --append-system-prompt-file '/tmp/cm/feat-1.md'",
    )
  })

  // O denylist e a política da filha vão no ARQUIVO: o argv só leva o path.
  it('filha de handoff: --settings <path> e posicional aparado no fim', () => {
    const cmd = claudeProvider.buildLaunch({
      ...base,
      name: 'mauricio-auth-refactor',
      permissionMode: 'acceptEdits',
      settingsFilePath: '/tmp/cm/session-settings/s1.json',
      systemPromptFilePath: '/tmp/cm/handoff-1.md',
      initialPrompt: '  Comece a tarefa\n',
    })
    expect(cmd).toBe(
      "claude --session-id 11111111-1111-1111-1111-111111111111 -n 'mauricio-auth-refactor' --mcp-config '/tmp/mcp.json' --permission-mode 'acceptEdits'" +
        " --settings '/tmp/cm/session-settings/s1.json'" +
        " --append-system-prompt-file '/tmp/cm/handoff-1.md' 'Comece a tarefa'",
    )
  })
})

describe('claudeProvider.mcpInject', () => {
  it('gera o --mcp-config com o path quotado e espaço inicial', () => {
    expect(claudeProvider.mcpInject({ configPath: '/tmp/a b/mcp.json' })).toBe(
      " --mcp-config '/tmp/a b/mcp.json'",
    )
  })
})

describe('claudeProvider.resolveCommand', () => {
  it('usa app_prefs.claude_command quando definido', () => {
    const prefs: Record<string, string> = { claude_command: '/opt/bin/claude' }
    expect(claudeProvider.resolveCommand((k) => prefs[k])).toBe('/opt/bin/claude')
  })

  it("cai em 'claude' sem pref (ou pref vazia)", () => {
    expect(claudeProvider.resolveCommand(() => undefined)).toBe('claude')
    expect(claudeProvider.resolveCommand(() => '')).toBe('claude')
  })
})

describe('getProvider', () => {
  it('default e null resolvem para o claude', () => {
    expect(getProvider()).toBe(claudeProvider)
    expect(getProvider(null)).toBe(claudeProvider)
    expect(getProvider('claude')).toBe(claudeProvider)
  })

  it('provider sem implementação lança em vez de cair no claude', () => {
    expect(() => getProvider('opencode' as never)).toThrow('opencode')
  })
})
