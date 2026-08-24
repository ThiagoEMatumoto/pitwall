import { act, render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LiveSessionInfo, Repo } from '../../../shared/types/ipc'

// O diálogo puxa features por IPC e prefs persistidas; aqui só interessa a
// SAÍDA nova: "abrir como sessão filha" e o payload que ela entrega ao caller.
vi.mock('@/lib/ipc', () => ({
  featuresApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/lib/session-prefs-store', () => ({
  loadRepoSessionDefaults: vi.fn().mockResolvedValue(null),
  saveRepoSessionDefaults: vi.fn(),
  clearRepoSessionDefaults: vi.fn(),
  useSessionPrefsStore: {
    getState: () => ({
      load: () => Promise.resolve(),
      defaultModel: '',
      defaultEffort: '',
      defaultPermission: 'default',
      defaultAdvisor: '',
      defaultPaneMode: 'terminal',
    }),
  },
}))

const liveSessions: LiveSessionInfo[] = [
  {
    id: 'sess-mother',
    ccSessionId: 'cc-1',
    name: null,
    title: 'orquestrador',
    status: 'idle',
    repo: { label: 'legal-core' } as Repo,
    projectName: 'lexter',
    projectIcon: null,
    projectColor: null,
    lastActivityAt: null,
    lastText: null,
  },
]
vi.mock('@/store/appStore', () => ({
  setNextPaneMode: vi.fn(),
  useAppStore: (selector: (s: { liveSessions: LiveSessionInfo[] }) => unknown) =>
    selector({ liveSessions }),
}))

const { SpawnSessionDialog } = await import('./SpawnSessionDialog')

const repo = { id: 'repo-1', label: 'legal-core' } as Repo

// act assíncrono: o diálogo resolve prefs/features no mount, e sem esperar esse
// tick o React reclama de update fora de act.
async function setup(onConfirmChild?: ReturnType<typeof vi.fn>) {
  const onConfirm = vi.fn()
  await act(async () => {
    render(
      <SpawnSessionDialog
        open
        onClose={() => {}}
        repo={repo}
        onConfirm={onConfirm}
        onConfirmChild={onConfirmChild}
      />,
    )
  })
  return { onConfirm }
}

describe('SpawnSessionDialog — abrir como sessão filha', () => {
  it('não oferece a opção quando o caller não sabe criar filha', async () => {
    await setup(undefined)
    expect(screen.queryByTestId('as-child-toggle')).toBeNull()
  })

  it('marcada, revela campo de tarefa e picker da mãe', async () => {
    await setup(vi.fn())
    expect(screen.queryByTestId('child-task')).toBeNull()
    fireEvent.click(screen.getByTestId('as-child-toggle'))
    expect(screen.getByTestId('child-task')).toBeInTheDocument()
    expect(screen.getByTestId('mother-session-picker')).toBeInTheDocument()
  })

  it('confirma pela saída de filha, com tarefa e mãe escolhida', async () => {
    const onConfirmChild = vi.fn()
    const { onConfirm } = await setup(onConfirmChild)
    fireEvent.click(screen.getByTestId('as-child-toggle'))
    fireEvent.change(screen.getByTestId('child-task'), {
      target: { value: 'refatorar o auth' },
    })
    fireEvent.change(screen.getByTestId('mother-session-picker'), {
      target: { value: 'sess-mother' },
    })
    fireEvent.click(screen.getByText('Abrir como filha'))

    expect(onConfirmChild).toHaveBeenCalledWith({
      task: 'refatorar o auth',
      motherSessionId: 'sess-mother',
      featureId: undefined,
      permission: 'default',
    })
    // A saída normal (abrir aba) NÃO dispara: filha nasce no painel lateral.
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('sem mãe escolhida não confirma (escolha explícita, sem inferir do foco)', async () => {
    const onConfirmChild = vi.fn()
    await setup(onConfirmChild)
    fireEvent.click(screen.getByTestId('as-child-toggle'))
    fireEvent.change(screen.getByTestId('child-task'), { target: { value: 'refatorar' } })
    fireEvent.click(screen.getByText('Abrir como filha'))
    expect(onConfirmChild).not.toHaveBeenCalled()
  })

  it('sem tarefa o botão fica desabilitado (apelido sem escopo não existe)', async () => {
    await setup(vi.fn())
    fireEvent.click(screen.getByTestId('as-child-toggle'))
    expect(screen.getByText('Abrir como filha')).toBeDisabled()
  })
})
