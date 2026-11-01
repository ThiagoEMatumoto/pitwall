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

  // Filha em plan lê o estado (handoff_result, agent_check…) e travava num menu de
  // permissão: toda tool que só lê precisa da anotação.
  it.each([
    'handoff_result',
    'handoff_list',
    'agent_list',
    'agent_check',
    'overview_get',
    'repo_connections_get',
    'service_list',
    'design_guide',
    'design_tree_summary',
    'design_html_get',
    'design_computed_styles',
    'feature_pulse_history',
  ])('%s (só lê) tem readOnlyHint', (name) => {
    expect(registered().get(name)?.annotations?.readOnlyHint).toBe(true)
  })

  it('toda tool *_list / *_get tem readOnlyHint', () => {
    const missing = [...registered()]
      .filter(([name]) => /_(list|get)$/.test(name))
      .filter(([, config]) => config.annotations?.readOnlyHint !== true)
      .map(([name]) => name)
    expect(missing).toEqual([])
  })

  it('tools que escrevem fora do handoff não ganham readOnlyHint', () => {
    const configs = registered()
    for (const name of [
      'session_handoff',
      'task_create',
      'diagram_create',
      // Persiste a altura medida do artboard.
      'design_screenshot',
      // Escrevem arquivos em disco.
      'design_export',
      'feature_loop_export',
      'service_call',
      'agent_ask',
    ]) {
      expect(configs.get(name)?.annotations?.readOnlyHint).not.toBe(true)
    }
  })
})
