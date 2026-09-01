import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FeatureWithStats, Repo } from '../../../shared/types/ipc'

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
  featuresApi: { listWithStats: () => listMock() },
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

function makeFeature(id: string, title: string) {
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
    repos: [{ repoId: 'r1', branch: null, worktreePath: null }],
    origin: 'manual',
    objectiveLinkCount: 0,
    isAppDev: false,
    pinned: false,
    focusRank: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    archivedAt: null,
    sessionCount: 0,
    recordCount: 0,
    lastRecordAt: null,
  } as FeatureWithStats
}

const many = Array.from({ length: 30 }, (_, i) => makeFeature(`f${i}`, `Frente ${i}`))

describe('SpawnSessionDialog — o picker não é recortado pelo corpo do diálogo', () => {
  it('portaliza o painel para fora do diálogo, com lista longa e rolagem própria', async () => {
    listMock.mockResolvedValue(many)
    render(<SpawnSessionDialog open onClose={() => {}} repo={repo} onConfirm={() => {}} />)

    fireEvent.click(await screen.findByTestId('spawn-feature-select'))
    const panel = await screen.findByTestId('spawn-feature-picker')

    // O bug era o `overflow-y-auto` do corpo do Dialog recortar um painel
    // `absolute`: o painel tem de ser filho direto do body, não do diálogo.
    expect(panel.parentElement).toBe(document.body)
    expect(panel.closest('[data-testid="spawn-feature-select"]')).toBeNull()

    // Muito mais que "uma opção e meia", e com teto de altura + rolagem própria.
    expect(screen.getAllByRole('option').length).toBeGreaterThan(2)
    expect(panel.style.maxHeight).toBe('288px')
    expect(panel.style.position).toBe('')
    const list = panel.querySelector('.overflow-y-auto')
    expect(list).not.toBeNull()
    expect(list?.querySelectorAll('[role="option"]').length).toBe(31)
  })

  it('Esc fecha só o picker — o diálogo por baixo continua aberto', async () => {
    listMock.mockResolvedValue(many)
    const onClose = vi.fn()
    render(<SpawnSessionDialog open onClose={onClose} repo={repo} onConfirm={() => {}} />)

    fireEvent.click(await screen.findByTestId('spawn-feature-select'))
    fireEvent.keyDown(screen.getByTestId('spawn-feature-picker-search'), { key: 'Escape' })

    expect(screen.queryByTestId('spawn-feature-picker')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('spawn-feature-select')).toBeInTheDocument()
  })
})
