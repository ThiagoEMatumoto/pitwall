import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Feature, Repo } from '../../../shared/types/ipc'

// Só o vínculo com a feature está sob teste: o picker de mãe e o store de
// defaults têm IPC próprio e não interessam aqui.
vi.mock('@/features/handoffs/MotherSessionPicker', () => ({ MotherSessionPicker: () => null }))
vi.mock('@/lib/session-prefs-store', () => ({
  clearRepoSessionDefaults: vi.fn(),
  loadRepoSessionDefaults: vi.fn().mockResolvedValue(null),
  saveRepoSessionDefaults: vi.fn(),
  useSessionPrefsStore: {
    getState: () => ({
      load: vi.fn().mockResolvedValue(undefined),
      defaultModel: '',
      defaultEffort: '',
      defaultPermission: 'default',
      defaultAdvisor: '',
      defaultPaneMode: 'terminal',
    }),
  },
}))

const listMock = vi.fn()
vi.mock('@/lib/ipc', () => ({
  featuresApi: { list: () => listMock() },
  sessionsApi: {},
  prefsApi: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
}))

const { SpawnSessionDialog } = await import('./SpawnSessionDialog')

const repo: Repo = {
  id: 'r1',
  projectId: 'p1',
  label: 'claude-manager',
  path: '/repo',
  role: null,
  linkKind: 'local',
  source: null,
  position: 0,
  createdAt: 0,
  canvasX: null,
  canvasY: null,
  isHub: false,
}

function makeFeature(id: string, title: string): Feature {
  return {
    id,
    projectId: 'p1',
    slug: id,
    title,
    status: 'in-progress',
    objective: null,
    docPath: `/tmp/${id}.md`,
    synthMode: 'auto',
    model: null,
    repos: [{ featureId: id, repoId: 'r1', branch: null }],
    origin: 'manual',
    objectiveLinkCount: 0,
    isAppDev: false,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    archivedAt: null,
  }
}

describe('SpawnSessionDialog — initialFeatureId', () => {
  it('abre com a feature já selecionada quando o caller a informa', async () => {
    listMock.mockResolvedValue([makeFeature('f1', 'Loop'), makeFeature('f2', 'Extração TRF4')])
    render(
      <SpawnSessionDialog
        open
        onClose={() => {}}
        repo={repo}
        onConfirm={() => {}}
        initialFeatureId="f2"
      />,
    )

    const select = await screen.findByTestId('spawn-feature-select')
    expect(await screen.findByRole('option', { name: /Extração TRF4/ })).toBeInTheDocument()
    expect(select).toHaveValue('f2')
  })

  it('sem initialFeatureId segue abrindo sem vínculo', async () => {
    listMock.mockResolvedValue([makeFeature('f1', 'Loop')])
    render(<SpawnSessionDialog open onClose={() => {}} repo={repo} onConfirm={() => {}} />)

    const select = await screen.findByTestId('spawn-feature-select')
    expect(await screen.findByRole('option', { name: /Loop/ })).toBeInTheDocument()
    expect(select).toHaveValue('')
  })
})
