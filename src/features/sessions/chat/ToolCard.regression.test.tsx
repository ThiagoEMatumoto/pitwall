import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../../../shared/types/ipc'
import type { ToolEntry } from './chat-rows'

vi.mock('@/lib/ipc', () => {
  const inert = new Proxy({}, { get: () => () => Promise.resolve(null) })
  return new Proxy({}, { get: () => inert })
})

// Espiões sobre as funções reais: contam quantas vezes a apresentação e o diff
// (LCS) são calculados.
const spies = vi.hoisted(() => ({ toolView: vi.fn(), toolDiff: vi.fn() }))
vi.mock('./tool-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tool-view')>()
  spies.toolView.mockImplementation(actual.toolView)
  spies.toolDiff.mockImplementation(actual.toolDiff)
  return { ...actual, toolView: spies.toolView, toolDiff: spies.toolDiff }
})

import { ToolGroup, ToolRow } from './ToolCard'

// Como o transcript chega a cada broadcast: objetos novos, mesmo id.
function edit(): ToolEntry {
  return {
    kind: 'tool',
    index: 0,
    use: {
      kind: 'tool_use',
      id: 'e1',
      name: 'Edit',
      input: { file_path: '/r/a.ts', old_string: 'a\nb', new_string: 'a\nB' },
    },
  }
}
function bash(index: number, out: string): ToolEntry {
  const use = { kind: 'tool_use', id: `b${index}`, name: 'Bash', input: { command: `cmd ${index}` } } as Extract<
    ChatMessage,
    { kind: 'tool_use' }
  >
  return { kind: 'tool', index, use, result: { kind: 'tool_result', forId: use.id, content: out, isError: false } }
}

describe('ToolRow — custo por broadcast', () => {
  it('reparse com input novo não recalcula, e o diff só roda ao abrir', () => {
    spies.toolView.mockClear()
    spies.toolDiff.mockClear()
    const { rerender } = render(<ToolRow entry={edit()} />)
    rerender(<ToolRow entry={edit()} />)
    rerender(<ToolRow entry={edit()} />)
    expect(spies.toolView).toHaveBeenCalledTimes(1)
    expect(spies.toolDiff).not.toHaveBeenCalled()
    expect(screen.getByText('+1 −1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Editou/ }))
    rerender(<ToolRow entry={edit()} />)
    expect(spies.toolDiff).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('permission-diff')).toBeInTheDocument()
  })
})

describe('ToolGroup — 1 → 2 chamadas', () => {
  it('a linha aberta não desmonta e o grupo nasce expandido', () => {
    const { rerender } = render(<ToolGroup entries={[bash(0, 'saída lida')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Rodou/ }))
    const output = screen.getByText('saída lida')

    rerender(<ToolGroup entries={[bash(0, 'saída lida'), bash(1, 'outra')]} />)
    expect(screen.getByRole('button', { name: /Rodou 2 comandos/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    // Mesmo nó: não houve remontagem.
    expect(screen.getByText('saída lida')).toBe(output)
  })

  it('sem linha aberta, o grupo nasce fechado', () => {
    const { rerender } = render(<ToolGroup entries={[bash(0, 'x')]} />)
    rerender(<ToolGroup entries={[bash(0, 'x'), bash(1, 'y')]} />)
    expect(screen.getByRole('button', { name: /Rodou 2 comandos/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })
})
