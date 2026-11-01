import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-annot-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { registerTools, type McpNotify } from './tools'

// Filha em --permission-mode plan: o claude 2.1.316 pede permissão para toda MCP
// tool sem readOnlyHint, e o allow do --settings (mcp__pitwall ou o nome exato)
// NÃO vale em plan (sonda `claude -p --permission-mode plan` com servidor stdio:
// allow → DENIED, readOnlyHint → chamada passa). As tools de reporte do handoff
// precisam passar em todo modo de filha.
describe('anotações das tools de reporte da filha', () => {
  function registered() {
    const configs = new Map<string, { annotations?: { readOnlyHint?: boolean } }>()
    const server = {
      registerTool: (name: string, config: { annotations?: { readOnlyHint?: boolean } }) =>
        configs.set(name, config),
    }
    const notify: McpNotify = {
      broadcast: () => {},
      affectedObjectives: () => {},
      affectedObjectivesForFeatureLinks: () => {},
    }
    registerTools(server as never, notify)
    return configs
  }

  it.each(['handoff_report', 'handoff_progress', 'handoff_ask', 'handoff_wait'])('%s tem readOnlyHint', (name) => {
    expect(registered().get(name)?.annotations?.readOnlyHint).toBe(true)
  })

  it('tools que escrevem fora do handoff não ganham readOnlyHint', () => {
    const configs = registered()
    for (const name of ['session_handoff', 'task_create', 'diagram_create']) {
      expect(configs.get(name)?.annotations?.readOnlyHint).not.toBe(true)
    }
  })
})
