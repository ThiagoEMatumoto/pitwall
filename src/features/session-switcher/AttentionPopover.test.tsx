import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import xtermHeadless from '@xterm/headless'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { menuFingerprint, parseTuiMenu } from '../../../shared/tui/tui-menu-parser'

const attentionMenu = vi.fn()
const attentionRespond = vi.fn()
const noop = new Proxy({}, { get: () => () => undefined })
vi.stubGlobal(
  'window',
  Object.assign(window, {
    api: new Proxy(
      {},
      {
        get: (_t, ns) =>
          ns === 'sessions'
            ? new Proxy(
                {},
                {
                  get: (_s, m) =>
                    m === 'attentionMenu'
                      ? attentionMenu
                      : m === 'attentionRespond'
                        ? attentionRespond
                        : () => undefined,
                },
              )
            : noop,
      },
    ),
  }),
)

const { AttentionPopover, menuActions } = await import('./AttentionPopover')
type AttentionItem = import('./attention-queue').AttentionItem
type TuiMenu = import('../../../shared/tui/tui-menu-parser').TuiMenu

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

// Menu derivado do PRODUTOR real: a captura bruta do claude 2.1.286 passa pelo
// mesmo xterm headless + parser que o main usa.
async function realPermissionMenu(): Promise<TuiMenu> {
  const raw = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      'shared',
      'tui',
      '__fixtures__',
      'claude-2.1.286-permission-bash.ansi',
    ),
    'utf8',
  )
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  await new Promise<void>((r) => term.write(raw, r))
  const buf = term.buffer.active
  let text = ''
  for (let y = 0; y < buf.length; y++)
    text += (buf.getLine(y)?.translateToString(true) ?? '') + '\n'
  const menu = parseTuiMenu(text)
  if (!menu) throw new Error('fixture real não parseou')
  return menu
}

const item: AttentionItem = {
  key: 'crew:h',
  kind: 'crew',
  sessionId: 'child',
  ccSessionId: 'cc-child',
  handoffId: 'h',
  projectName: 'proj',
  title: 'Auth',
  reason: 'crew',
  detail: 'permission',
  since: 1,
  liveStatus: 'waiting',
}

beforeEach(() => {
  attentionMenu.mockReset()
  attentionRespond.mockReset()
})

describe('menuActions', () => {
  it('permissão real do 2.1.286: Aprovar=Yes, Sempre=always allow, Negar=No', async () => {
    const menu = await realPermissionMenu()
    expect(menuActions(menu).map((a) => [a.key, a.optionIndex])).toEqual([
      ['approve', 0],
      ['always', 1],
      ['deny', 3],
    ])
  })

  it('pergunta multi-select ou com abas não vira botão (responde no terminal)', () => {
    const multi: TuiMenu = {
      kind: 'question',
      options: [
        { index: 0, label: 'A', checked: false },
        { index: 1, label: 'B', checked: false },
      ],
      multiSelect: true,
      submitOnDigit: true,
    }
    expect(menuActions(multi)).toEqual([])
  })
})

describe('AttentionPopover', () => {
  it('mostra o motivo e as opções e manda a intenção com o fingerprint visto', async () => {
    const menu = await realPermissionMenu()
    attentionMenu.mockResolvedValue({
      sessionId: 'child',
      fingerprint: menuFingerprint(menu),
      menuSeq: 1,
      menu,
    })
    attentionRespond.mockResolvedValue({ ok: true })
    render(<AttentionPopover item={item} />)
    expect(await screen.findByText('Quer continuar?')).toBeInTheDocument()
    expect(screen.getByText('Pede permissão')).toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByTestId('attention-action-approve')))
    expect(attentionRespond).toHaveBeenCalledWith({
      sessionId: 'child',
      fingerprint: menuFingerprint(menu),
      menuSeq: 1,
      action: { kind: 'select', optionIndex: 0 },
    })
    expect(screen.getByTestId('attention-notice')).toHaveTextContent('Resposta enviada.')
  })

  it('menu mudou: avisa e troca para o menu novo devolvido pelo main', async () => {
    const menu = await realPermissionMenu()
    const changed: TuiMenu = { ...menu, question: 'Do you want to make this edit?' }
    attentionMenu.mockResolvedValue({
      sessionId: 'child',
      fingerprint: menuFingerprint(menu),
      menuSeq: 1,
      menu,
    })
    attentionRespond.mockResolvedValue({
      ok: false,
      error: 'menu-changed',
      snapshot: {
        sessionId: 'child',
        fingerprint: menuFingerprint(changed),
        menuSeq: 2,
        menu: changed,
      },
    })
    render(<AttentionPopover item={item} />)
    await screen.findByText('Quer continuar?')
    await act(async () => fireEvent.click(screen.getByTestId('attention-action-deny')))
    expect(screen.getByTestId('attention-notice')).toHaveTextContent('O menu mudou')
    expect(screen.getByText('Do you want to make this edit?')).toBeInTheDocument()
  })

  it('depois de enviar some com os botões: 2º clique não vai pro próximo prompt', async () => {
    const menu = await realPermissionMenu()
    attentionMenu.mockResolvedValue({
      sessionId: 'child',
      fingerprint: menuFingerprint(menu),
      menuSeq: 1,
      menu,
    })
    attentionRespond.mockResolvedValue({ ok: true })
    const { rerender } = render(<AttentionPopover item={item} />)
    await screen.findByText('Quer continuar?')
    await act(async () => fireEvent.click(screen.getByTestId('attention-action-approve')))
    expect(screen.queryByTestId('attention-action-approve')).toBeNull()
    expect(screen.getByTestId('attention-notice')).toHaveTextContent('Resposta enviada.')

    // Próximo prompt no mesmo projeto: o status dá a volta e o menu é relido.
    const next: TuiMenu = { ...menu, context: 'rm -rf outra-coisa' }
    attentionMenu.mockResolvedValue({
      sessionId: 'child',
      fingerprint: menuFingerprint(next),
      menuSeq: 2,
      menu: next,
    })
    rerender(<AttentionPopover item={{ ...item, liveStatus: 'working' }} />)
    await act(async () => rerender(<AttentionPopover item={item} />))
    expect(await screen.findByText('rm -rf outra-coisa')).toBeInTheDocument()
    expect(screen.queryByTestId('attention-notice')).toBeNull()
    await act(async () => fireEvent.click(screen.getByTestId('attention-action-approve')))
    expect(attentionRespond).toHaveBeenLastCalledWith(
      expect.objectContaining({ fingerprint: menuFingerprint(next), menuSeq: 2 }),
    )
  })

  it('"Sempre" mostra o que a opção real concede e o Tip de opção não oferecida some', async () => {
    const menu = await realPermissionMenu()
    attentionMenu.mockResolvedValue({
      sessionId: 'child',
      fingerprint: menuFingerprint(menu),
      menuSeq: 1,
      menu,
    })
    render(<AttentionPopover item={item} />)
    await screen.findByText('Quer continuar?')
    const always = menu.options[1].label
    expect(always).toMatch(/always allow access/)
    expect(menu.context).toMatch(/^Tip:/m)
    expect(screen.getByTestId('attention-action-always')).toHaveAttribute('title', always)
    // Em português, com o caminho curto (a TUI quebra o caminho entre label e descrição).
    expect(screen.getByTestId('attention-always-hint')).toHaveTextContent(
      /^Sempre: permitir acesso a …\/[^/]+\/cwd-\d+ em todo o projeto$/,
    )
    expect(screen.getByTestId('attention-popover')).not.toHaveTextContent('Tip:')
    // Cabeçalho da caixa da TUI e o resto quebrado do Tip somem; o comando fica.
    const ctx = screen.getByTestId('attention-context')
    expect(ctx).not.toHaveTextContent('Bash command')
    expect(ctx.textContent).not.toMatch(/^below$/m)
    expect(ctx).toHaveTextContent('touch permissao-fixture.txt')
  })

  it('comando invertido por U+202E aparece sem o bidi (não disfarça o que se aprova)', async () => {
    const real = await realPermissionMenu()
    const menu = {
      ...real,
      question: `${real.question}\u202e`,
      context: real.context!.replace('touch permissao-fixture.txt', 'echo ok \u202efr- mr\u202c\x07'),
    }
    attentionMenu.mockResolvedValue({
      sessionId: 'child',
      fingerprint: menuFingerprint(menu),
      menuSeq: 1,
      menu,
    })
    render(<AttentionPopover item={item} />)
    const ctx = await screen.findByTestId('attention-context')
    expect(ctx.textContent).not.toMatch(/[\u202a-\u202e\u2066-\u2069\x00-\x08]/)
    expect(ctx).toHaveTextContent('echo ok fr- mr')
    expect(screen.getByTestId('attention-popover').textContent).not.toContain('\u202e')
  })

  it('fixado: é diálogo rotulado, e o Esc fecha sem vazar pro terminal', async () => {
    const menu = await realPermissionMenu()
    attentionMenu.mockResolvedValue({
      sessionId: 'child',
      fingerprint: menuFingerprint(menu),
      menuSeq: 1,
      menu,
    })
    const onClose = vi.fn()
    const leaked = vi.fn()
    window.addEventListener('keydown', leaked)
    render(<AttentionPopover item={item} onClose={onClose} pinned />)
    const dialog = await screen.findByRole('dialog', { name: 'Pede permissão' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    window.removeEventListener('keydown', leaked)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(leaked).not.toHaveBeenCalled()
  })

  it('outra resposta em voo (busy): avisa e não oferece botões', async () => {
    const menu = await realPermissionMenu()
    attentionMenu.mockResolvedValue({
      sessionId: 'child',
      fingerprint: menuFingerprint(menu),
      menuSeq: 1,
      menu,
    })
    attentionRespond.mockResolvedValue({ ok: false, error: 'busy', snapshot: null })
    render(<AttentionPopover item={item} />)
    await screen.findByText('Quer continuar?')
    await act(async () => fireEvent.click(screen.getByTestId('attention-action-approve')))
    expect(screen.getByTestId('attention-notice')).toHaveTextContent('já está a caminho')
    expect(screen.queryByTestId('attention-action-approve')).toBeNull()
  })

  // Comando longo (heredoc, pipeline) não pode chegar cortado a quem aprova.
  it('contexto do comando aparece inteiro, em área rolável', async () => {
    const menu = await realPermissionMenu()
    const lines = Array.from({ length: 20 }, (_, i) => `linha-${i + 1} do comando`)
    const long: TuiMenu = { ...menu, context: lines.join('\n') }
    attentionMenu.mockResolvedValue({
      sessionId: 'child',
      fingerprint: menuFingerprint(long),
      menuSeq: 1,
      menu: long,
    })
    render(<AttentionPopover item={item} />)
    const ctx = await screen.findByTestId('attention-context')
    expect(ctx).toHaveTextContent('linha-1 do comando')
    expect(ctx).toHaveTextContent('linha-20 do comando')
    expect(ctx.className).toMatch(/overflow-auto/)
    expect(ctx.className).toMatch(/max-h-/)
  })

  it('fim de turno: sem ler menu, só o botão Abrir', () => {
    render(<AttentionPopover item={{ ...item, detail: 'turn-end' }} />)
    expect(attentionMenu).not.toHaveBeenCalled()
    expect(screen.getByText('Terminou o turno')).toBeInTheDocument()
    expect(screen.getByTestId('attention-open')).toBeInTheDocument()
    expect(screen.queryByTestId('attention-action-approve')).toBeNull()
  })
})
