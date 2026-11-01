import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// O MarkdownViewer do raciocínio importa o preload; aqui ele é inerte.
vi.mock('@/lib/ipc', () => {
  const inert = new Proxy({}, { get: () => () => Promise.resolve(null) })
  return new Proxy({}, { get: () => inert })
})
import type { ChatMessage } from '../../../../shared/types/ipc'
import type { GroupEntry, ToolEntry } from './chat-rows'
import { ToolGroup, ToolRow } from './ToolCard'

function entry(
  index: number,
  name: string,
  input: unknown,
  result?: { content: string; isError?: boolean },
): ToolEntry {
  const use = { kind: 'tool_use', id: `t${index}`, name, input } as Extract<ChatMessage, { kind: 'tool_use' }>
  return {
    kind: 'tool',
    index,
    use,
    result: result && {
      kind: 'tool_result',
      forId: use.id,
      content: result.content,
      isError: result.isError === true,
    },
  }
}

describe('ToolRow', () => {
  it('Bash fechado diz o que rodou; aberto mostra "$ comando" e a saída', () => {
    render(<ToolRow entry={entry(0, 'Bash', { command: 'npm test' }, { content: 'ok 12 testes' })} />)
    const row = screen.getByRole('button', { name: /Rodou/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('ok 12 testes')).not.toBeInTheDocument()
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('$')).toBeInTheDocument()
    expect(screen.getByText('ok 12 testes')).toBeInTheDocument()
  })

  it('Edit abre como diff colorido e esconde a confirmação redundante', () => {
    render(
      <ToolRow
        entry={entry(
          0,
          'Edit',
          { file_path: '/r/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' },
          { content: 'The file /r/a.ts has been updated.' },
        )}
      />,
    )
    expect(screen.getByText('+1 −1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Editou/ }))
    const diff = screen.getByTestId('permission-diff')
    expect(diff.querySelector('[data-sign="-"]')?.textContent).toContain('const a = 1')
    expect(diff.querySelector('[data-sign="+"]')?.textContent).toContain('const a = 2')
    expect(screen.queryByText(/has been updated/)).not.toBeInTheDocument()
  })

  it('saída longa abre nas primeiras linhas, com "mostrar mais"', () => {
    const long = Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`).join('\n')
    render(<ToolRow entry={entry(0, 'Read', { file_path: '/r/a.ts' }, { content: long })} />)
    fireEvent.click(screen.getByRole('button', { name: /Leu/ }))
    expect(screen.queryByText(/linha 30/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais 18 linhas' }))
    expect(screen.getByText(/linha 30/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mostrar menos' })).toBeInTheDocument()
  })

  it('erro aparece fechado e chamada sem resultado em andamento gira', () => {
    const { rerender } = render(
      <ToolRow entry={entry(0, 'Bash', { command: 'x' }, { content: 'boom', isError: true })} />,
    )
    expect(screen.getByText('falhou')).toBeInTheDocument()
    rerender(<ToolRow entry={entry(1, 'Bash', { command: 'y' })} running />)
    expect(screen.getByLabelText('rodando')).toBeInTheDocument()
  })
})

describe('ToolGroup', () => {
  const entries: GroupEntry[] = [
    entry(0, 'Read', { file_path: '/r/a.ts' }, { content: 'a' }),
    entry(1, 'Read', { file_path: '/r/b.ts' }, { content: 'b' }),
    { kind: 'thinking', index: 2, text: 'agora testar' },
    entry(3, 'Bash', { command: 'npm test' }, { content: 'falhou', isError: true }),
  ]

  it('resume a sequência e abre a lista sob demanda', () => {
    render(<ToolGroup entries={entries} />)
    const summary = screen.getByRole('button', { name: /Leu 2 arquivos · rodou 1 comando/ })
    expect(summary).toHaveTextContent('1 erro')
    expect(screen.queryByText('/r/b.ts')).not.toBeInTheDocument()
    fireEvent.click(summary)
    expect(screen.getByText('/r/b.ts')).toBeInTheDocument()
    expect(screen.getByText('Raciocínio')).toBeInTheDocument()
  })

  it('com uma chamada só, mostra a linha direto, sem resumo', () => {
    render(<ToolGroup entries={[entries[0]]} />)
    expect(screen.getByRole('button', { name: /Leu/ })).toBeInTheDocument()
    expect(screen.queryByText(/arquivos/)).not.toBeInTheDocument()
  })

  it('chamadas paralelas sem resultado giram todas', () => {
    render(
      <ToolGroup
        entries={[entry(5, 'Read', { file_path: '/r/x.ts' }), entry(6, 'Read', { file_path: '/r/y.ts' })]}
        running
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Leu 2 arquivos/ }))
    expect(screen.getAllByLabelText('rodando')).toHaveLength(3)
  })

  it('em andamento, o resumo diz o que está rodando agora', () => {
    render(
      <ToolGroup
        entries={[entries[0], entry(4, 'Bash', { command: 'npm run build' })]}
        running
      />,
    )
    expect(screen.getByText(/agora: rodou/)).toHaveTextContent('npm run build')
  })
})
