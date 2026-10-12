/** @vitest-environment node */
// Guard-rail de spawn autônomo (filha de handoff, ninguém olhando o terminal):
// para TODO provider registrado e TODO modo de permissão, ou o spawn é recusado
// ou a linha de comando final carrega uma trava — denylist destrutivo no claude,
// sandbox read-only no Codex (que não tem denylist equivalente).
import { describe, expect, it } from 'vitest'
import {
  DESTRUCTIVE_DENYLIST,
  SPAWN_PERMISSION_MODES,
  assertAutonomousSpawnGuarded,
  codexPolicyFor,
  permissionModeForHandoffMode,
  resolveCodexModel,
  resolveDisallowedTools,
  resolvePermissionMode,
} from './spawn-flags'
import { getProvider, registeredProviderIds } from './providers/registry'
import { buildSessionSettings } from './session-settings'
import type { AgentProviderId } from '../../../shared/types/ipc'

// Do registry: um provider novo entra aqui sozinho e tem de provar a trava.
const PROVIDERS = registeredProviderIds()
const MODES: (string | null)[] = [...SPAWN_PERMISSION_MODES, null]
// O claude em default/dontAsk/plan não age sozinho (pergunta, nega ou só lê).
const CLAUDE_AUTONOMOUS = new Set(['acceptEdits', 'auto', 'bypassPermissions'])

const SETTINGS_PATH = '/tmp/cm/session-settings/filha.json'

// O denylist do claude vai no arquivo de settings (o argv só leva o path).
function autonomousLaunch(
  provider: AgentProviderId,
  rawMode: string | null,
): { cmd: string; deny: string[] } | null {
  const permissionMode = resolvePermissionMode(rawMode)
  try {
    assertAutonomousSpawnGuarded(provider, permissionMode, true)
  } catch {
    return null
  }
  const settings = buildSessionSettings(null, resolveDisallowedTools(permissionMode, null))
  const cmd = getProvider(provider).buildLaunch({
    command: provider,
    sessionId: '11111111-1111-1111-1111-111111111111',
    name: 'filha',
    mcpConfigArg: '',
    model: null,
    systemPromptFilePath: null,
    permissionMode,
    settingsFilePath: settings ? SETTINGS_PATH : null,
  })
  return { cmd, deny: settings?.permissions?.deny ?? [] }
}

describe('spawn autônomo sempre sai com guard-rail', () => {
  for (const provider of PROVIDERS) {
    for (const mode of MODES) {
      it(`${provider} · ${mode ?? 'sem modo'}`, () => {
        const launch = autonomousLaunch(provider, mode)
        if (launch === null) return // recusado: nada sobe
        const { cmd, deny } = launch
        if (provider === 'claude') {
          if (!mode || !CLAUDE_AUTONOMOUS.has(mode)) return
          expect(cmd).toContain(`--settings '${SETTINGS_PATH}'`)
          expect(deny).toEqual(expect.arrayContaining(DESTRUCTIVE_DENYLIST))
        } else {
          expect(cmd).toContain("-s 'read-only'")
        }
      })
    }
  }
})

describe('assertAutonomousSpawnGuarded', () => {
  it('handoff auto-edits para Codex é recusado com erro claro', () => {
    const mode = resolvePermissionMode(permissionModeForHandoffMode('auto-edits'))
    expect(() => assertAutonomousSpawnGuarded('codex', mode, true)).toThrow(/Codex.*plan/s)
  })

  it('handoff plan para Codex passa (read-only)', () => {
    expect(() => assertAutonomousSpawnGuarded('codex', 'plan', true)).not.toThrow()
  })

  it('provider sem trava conhecida é recusado por padrão (fail-closed)', () => {
    const novo = 'opencode' as AgentProviderId
    expect(() => assertAutonomousSpawnGuarded(novo, 'acceptEdits', true)).toThrow()
    expect(() => assertAutonomousSpawnGuarded(novo, 'plan', true)).toThrow()
  })

  it('o registry lista claude e codex', () => {
    expect(PROVIDERS).toEqual(expect.arrayContaining(['claude', 'codex']))
  })

  it('sessão interativa (alguém olhando) não é barrada', () => {
    expect(() => assertAutonomousSpawnGuarded('codex', 'acceptEdits', false)).not.toThrow()
  })
})

describe('codexPolicyFor', () => {
  it('plan → read-only; o resto → workspace-write; sempre on-request', () => {
    expect(codexPolicyFor('plan')).toEqual({ sandbox: 'read-only', approval: 'on-request' })
    for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', null]) {
      expect(codexPolicyFor(mode)).toEqual({ sandbox: 'workspace-write', approval: 'on-request' })
    }
  })
})

describe('resolveCodexModel', () => {
  it('aceita nome de modelo, recusa o que quebraria a linha de comando', () => {
    expect(resolveCodexModel('gpt-5-codex')).toBe('gpt-5-codex')
    expect(resolveCodexModel('o3')).toBe('o3')
    expect(resolveCodexModel("x' ; rm -rf /")).toBeNull()
    expect(resolveCodexModel('')).toBeNull()
    expect(resolveCodexModel(undefined)).toBeNull()
  })
})
