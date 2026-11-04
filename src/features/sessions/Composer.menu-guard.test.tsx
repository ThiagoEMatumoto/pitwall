import { act, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { menuFingerprint, parseTuiMenu, type TuiMenu } from '../../../shared/tui/tui-menu-parser'

vi.mock('@/lib/ipc', () => {
  const inert = new Proxy(
    {},
    {
      get: (_t, key: string) =>
        key.startsWith('on') ? () => () => {} : () => Promise.resolve(null),
    },
  )
  // vi.mock confere as chaves exportadas: lista explícita das apis do preload.
  return Object.fromEntries(
    [
      'projectsApi',
      'sessionsApi',
      'chatApi',
      'shellApi',
      'appApi',
      'gpuApi',
      'dialogApi',
      'prefsApi',
      'secretsApi',
      'vaultApi',
      'fsApi',
      'repoApi',
      'workspaceApi',
      'ccConfigsApi',
      'ccPluginsApi',
      'ccSettingsApi',
      'updatesApi',
      'usageApi',
      'metricsApi',
      'featuresApi',
      'loopApi',
      'objectivesApi',
      'handoffsApi',
      'batonApi',
      'sessionGraphApi',
      'motherPinsApi',
      'attentionApi',
      'roomApi',
      'agentBusApi',
      'canvasApi',
      'sendToApi',
      'architectureApi',
      'tasksApi',
      'diagramsApi',
      'windowApi',
      'notificationsApi',
      'mcpApi',
      'syncApi',
      'voiceApi',
      'designApi',
    ].map((k) => [k, inert]),
  )
})
// Destinos de @menção vêm do grafo de sessões vivo; aqui não há outras sessões.
vi.mock('@/features/quick-composer/quick-composer-store', () => ({ useSendTargets: () => [] }))

import { Composer } from './Composer'

// Telas reais do claude (sondas 2.1.316/2.1.317): o menu que o composer encontra aberto.
const screenOf = (name: string): TuiMenu =>
  parseTuiMenu(
    readFileSync(join(__dirname, '../../../shared/tui/__fixtures__', `claude-${name}.txt`), 'utf8'),
  )!

function setup(menu: TuiMenu | null) {
  const onSend = vi.fn(async () => {})
  const onInsert = vi.fn(async () => {})
  const onForwardKey = vi.fn()
  const onMenuAnswer = vi.fn(async () => {})
  render(
    <Composer
      sessionId="s1"
      onSend={onSend}
      onInsert={onInsert}
      onForwardKey={onForwardKey}
      readMenu={() => menu}
      onMenuAnswer={onMenuAnswer}
    />,
  )
  const box = screen.getByRole('textbox')
  return { onSend, onInsert, onForwardKey, onMenuAnswer, box }
}

describe('Composer — guarda de menu aberto', () => {
  it('plano aberto: enviar texto vira o pedido de mudanças, nunca paste + Enter', async () => {
    const menu = screenOf('2.1.317-plan-default')
    const { onSend, onMenuAnswer, box } = setup(menu)
    fireEvent.change(box, { target: { value: 'use bye.txt' } })
    await act(async () => fireEvent.keyDown(box, { key: 'Enter' }))
    expect(onSend).not.toHaveBeenCalled()
    expect(onMenuAnswer).toHaveBeenCalledWith(menu, { kind: 'plan-feedback' }, 'use bye.txt')
    expect(box).toHaveValue('')
    expect(screen.getByTestId('composer-route')).toHaveTextContent('Mudanças enviadas ao plano.')
  })

  it('o aviso de mudanças enviadas some quando o plano replanejado aparece', async () => {
    const menu = screenOf('2.1.317-plan-default')
    const fp = (name: string) => menuFingerprint(screenOf(name))
    const props = {
      sessionId: 's1',
      onSend: vi.fn(async () => {}),
      onInsert: vi.fn(async () => {}),
      readMenu: () => menu,
      onMenuAnswer: vi.fn(async () => {}),
    }
    const { rerender } = render(<Composer {...props} openMenuFp={fp('2.1.317-plan-default')} />)
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'use bye.txt' } })
    await act(async () => fireEvent.keyDown(box, { key: 'Enter' }))
    const notice = () => screen.queryByTestId('composer-route')?.textContent ?? ''
    // O campo com o texto digitado e o diálogo fechando são o próprio diálogo respondido.
    rerender(<Composer {...props} openMenuFp={fp('2.1.317-plan-feedback-typed')} />)
    rerender(<Composer {...props} openMenuFp={null} />)
    expect(notice()).toContain('Mudanças enviadas ao plano.')
    rerender(<Composer {...props} openMenuFp={fp('2.1.317-plan-replanned')} />)
    expect(notice()).not.toContain('Mudanças enviadas ao plano.')
  })

  it('plano aberto: Enter com o composer vazio não aprova às cegas', () => {
    const { onForwardKey, box } = setup(screenOf('2.1.317-plan-default'))
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onForwardKey).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-route')).toHaveTextContent('Enter não aprova o plano')
  })

  it('sem menu, Enter vazio segue pra TUI e o texto vai pelo envio normal', async () => {
    const { onSend, onForwardKey, onMenuAnswer, box } = setup(null)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onForwardKey).toHaveBeenCalledWith('\r')
    fireEvent.change(box, { target: { value: 'oi' } })
    await act(async () => fireEvent.keyDown(box, { key: 'Enter' }))
    expect(onSend).toHaveBeenCalledWith('oi')
    expect(onMenuAnswer).not.toHaveBeenCalled()
  })

  it('pergunta com "Type something.": o texto vira a resposta Other', async () => {
    const menu = screenOf('2.1.317-question-chat-sentinel')
    const { onSend, onMenuAnswer, box } = setup(menu)
    fireEvent.change(box, { target: { value: 'Rust' } })
    await act(async () => fireEvent.keyDown(box, { key: 'Enter' }))
    expect(onSend).not.toHaveBeenCalled()
    expect(onMenuAnswer).toHaveBeenCalledWith(
      menu,
      { kind: 'question-other', optionIndex: 3 },
      'Rust',
    )
  })

  it('permissão aberta: bloqueia com aviso e mantém o rascunho', async () => {
    const { onSend, onMenuAnswer, onInsert, box } = setup(screenOf('2.1.316-permission-bash-curl'))
    fireEvent.change(box, { target: { value: 'continua' } })
    await act(async () => fireEvent.keyDown(box, { key: 'Enter' }))
    expect(onSend).not.toHaveBeenCalled()
    expect(onMenuAnswer).not.toHaveBeenCalled()
    expect(box).toHaveValue('continua')
    expect(screen.getByTestId('composer-route')).toHaveTextContent('pedido de permissão aberto')
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Inserir sem enviar' })),
    )
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('multi-select aberto: o texto vira o Other, sem enviar como prompt', async () => {
    const menu = screenOf('2.1.317-question-multi-other')
    const { onSend, onMenuAnswer, box } = setup(menu)
    fireEvent.change(box, { target: { value: 'roxo' } })
    await act(async () => fireEvent.keyDown(box, { key: 'Enter' }))
    expect(onSend).not.toHaveBeenCalled()
    expect(onMenuAnswer).toHaveBeenCalledWith(
      menu,
      { kind: 'question-other', optionIndex: 3, multi: true },
      'roxo',
    )
    expect(screen.getByTestId('composer-route')).toHaveTextContent('Envie as respostas pelo card')
  })

  it('plano aberto: Shift+Tab não chega ao diálogo, que aprovaria pelo atalho', () => {
    const { onForwardKey, box } = setup(screenOf('2.1.317-plan-default'))
    fireEvent.keyDown(box, { key: 'Tab', shiftKey: true })
    fireEvent.change(box, { target: { value: 'rascunho' } })
    fireEvent.keyDown(box, { key: 'Tab', shiftKey: true })
    expect(onForwardKey).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-route')).toHaveTextContent('Shift+Tab aprovaria')
  })

  it('plano aberto: Esc com rascunho não descarta o plano; vazio descarta', () => {
    const { onForwardKey, box } = setup(screenOf('2.1.317-plan-default'))
    fireEvent.change(box, { target: { value: 'use bye.txt' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onForwardKey).not.toHaveBeenCalled()
    expect(box).toHaveValue('use bye.txt')
    expect(screen.getByTestId('composer-route')).toHaveTextContent('Esc descartaria o plano')
    fireEvent.change(box, { target: { value: '' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onForwardKey).toHaveBeenCalledWith('\x1b')
  })

  it('sem menu, Shift+Tab segue pra TUI (troca o modo de permissão)', () => {
    const { onForwardKey, box } = setup(null)
    fireEvent.keyDown(box, { key: 'Tab', shiftKey: true })
    expect(onForwardKey).toHaveBeenCalledWith('\x1b[Z')
  })

  it('nudge do auto mode: bloqueia e aponta o card do menu', async () => {
    const { onSend, box } = setup(screenOf('2.1.317-auto-mode-env-nudge'))
    fireEvent.change(box, { target: { value: 'oi' } })
    await act(async () => fireEvent.keyDown(box, { key: 'Enter' }))
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-route')).toHaveTextContent('responda no card acima')
  })

  it('a resposta falhou: mantém o rascunho e avisa', async () => {
    const { onMenuAnswer, box } = setup(screenOf('2.1.317-plan-default'))
    onMenuAnswer.mockRejectedValueOnce(new Error('campo já tem texto'))
    fireEvent.change(box, { target: { value: 'x' } })
    await act(async () => fireEvent.keyDown(box, { key: 'Enter' }))
    expect(box).toHaveValue('x')
    expect(screen.getByTestId('composer-route')).toHaveTextContent('Não deu pra responder')
  })
})
