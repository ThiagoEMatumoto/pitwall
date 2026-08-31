import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Feature } from '../../../shared/types/ipc'

// A área inteira só pra provar a COSTURA do gesto de voltar: as views e as
// seções pesadas do dossiê viram stubs, o que fica de pé é selectedId + view.
vi.mock('./FeaturesSidebar', () => ({ FeaturesSidebar: () => null }))
vi.mock('./NewFeatureDialog', () => ({ NewFeatureDialog: () => null }))
vi.mock('./FeatureTriage', () => ({ FeatureTriage: () => null }))
vi.mock('./FeatureBoard', () => ({ FeatureBoard: () => <div data-testid="board-view" /> }))
vi.mock('./FeatureWall', () => ({
  FeatureWall: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <div data-testid="wall-view">
      <button type="button" onClick={() => onSelect('f1')}>
        abrir da parede
      </button>
    </div>
  ),
}))
vi.mock('./FeatureList', () => ({
  // O dossiê importa o StatusBadge daqui — o stub precisa devolver os dois.
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
  FeatureList: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <div data-testid="list-view">
      <button type="button" onClick={() => onSelect('f1')}>
        abrir da lista
      </button>
    </div>
  ),
}))
vi.mock('./useLoopSnapshots', () => ({ useLoopSnapshots: () => new Map() }))
vi.mock('./useFeatureLiveSessions', () => ({ useFeatureLiveSessions: () => new Map() }))
vi.mock('./useFeatures', () => ({ useFeatures: () => {} }))
vi.mock('./FeatureTasksSection', () => ({ FeatureTasksSection: () => null }))
vi.mock('./FeatureObjectiveLinksSection', () => ({ FeatureObjectiveLinksSection: () => null }))
vi.mock('./FeatureSessions', () => ({ FeatureSessions: () => null }))
vi.mock('./useObjectiveLookups', () => ({
  useObjectiveLookups: () => ({ objectives: [], krTitles: new Map(), krObjectiveId: new Map() }),
}))
vi.mock('@/features/sessions/SpawnSessionDialog', () => ({ SpawnSessionDialog: () => null }))
vi.mock('@/store/appStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({ openSession: vi.fn(), setArea: vi.fn() }),
}))
vi.mock('@/lib/keybindings-store', () => ({
  useKeybindingsStore: (sel: (s: unknown) => unknown) => sel({ overrides: {} }),
}))

const NOW = Date.UTC(2026, 7, 31)

function makeFeature(over: Partial<Feature> = {}): Feature {
  return {
    id: 'f1',
    projectId: 'p1',
    slug: 'trf4',
    title: 'Extração TRF4',
    status: 'in-progress',
    objective: null,
    docPath: '/tmp/f1.md',
    synthMode: 'auto',
    model: null,
    repos: [],
    origin: 'manual',
    objectiveLinkCount: 0,
    isAppDev: false,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    archivedAt: null,
    body: '# Doc',
    ...over,
  }
}

vi.mock('@/lib/ipc', () => ({
  shellApi: { openPath: vi.fn() },
  projectsApi: {
    list: vi.fn().mockResolvedValue([]),
    listRepos: vi.fn().mockResolvedValue([]),
  },
  objectivesApi: { list: vi.fn().mockResolvedValue([]), get: vi.fn() },
  featuresApi: {
    list: vi.fn().mockResolvedValue([]),
    listWithStats: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    create: vi.fn(),
    archive: vi.fn(),
    backfill: vi.fn(),
    setPinned: vi.fn(),
    dismissDuplicate: vi.fn(),
    onUpdated: vi.fn(() => () => {}),
  },
  loopApi: {
    snapshot: vi.fn().mockResolvedValue(null),
    setPulse: vi.fn(),
    pulseHistory: vi.fn().mockResolvedValue([]),
    onUpdated: vi.fn(() => () => {}),
  },
}))

const { FeaturesArea } = await import('./FeaturesArea')
const { useFeaturesStore } = await import('@/store/featuresStore')
const { featuresApi } = await import('@/lib/ipc')

beforeEach(() => {
  ;(featuresApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(makeFeature())
  useFeaturesStore.setState({
    features: [makeFeature({ body: undefined })],
    byProject: {},
    withStats: [],
    sessionCounts: new Map(),
    selectedId: null,
    selectedDoc: null,
    docLoading: false,
  })
})

async function openDoc(label: string) {
  fireEvent.click(screen.getByText(label))
  return screen.findByRole('heading', { name: 'Extração TRF4' })
}

describe('FeaturesArea — voltar do dossiê', () => {
  it('da parede: o botão de voltar fecha o dossiê e devolve a parede', async () => {
    render(<FeaturesArea />)
    expect(screen.getByTestId('wall-view')).toBeInTheDocument()

    await openDoc('abrir da parede')
    expect(screen.queryByTestId('wall-view')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('feature-back-button'))

    expect(await screen.findByTestId('wall-view')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Extração TRF4' })).not.toBeInTheDocument()
  })

  it('da lista: voltar devolve a LISTA, não a parede (a view sobrevive ao dossiê)', async () => {
    render(<FeaturesArea />)
    fireEvent.click(screen.getByTitle('Lista'))
    expect(screen.getByTestId('list-view')).toBeInTheDocument()

    await openDoc('abrir da lista')
    fireEvent.click(screen.getByTestId('feature-back-button'))

    expect(await screen.findByTestId('list-view')).toBeInTheDocument()
    expect(screen.queryByTestId('wall-view')).not.toBeInTheDocument()
  })

  it('dossiê vazio (get falhou) também tem saída — senão o selectedId prende a área', async () => {
    ;(featuresApi.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('nope'))
    render(<FeaturesArea />)

    fireEvent.click(screen.getByText('abrir da parede'))
    const back = await screen.findByTestId('feature-back-button')
    expect(screen.queryByTestId('wall-view')).not.toBeInTheDocument()

    fireEvent.click(back)
    expect(await screen.findByTestId('wall-view')).toBeInTheDocument()
  })
})
