import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignDocument } from '@shared/types/design'

const mockApi = {
  activeDocSet: vi.fn().mockResolvedValue(undefined),
  selectionSet: vi.fn().mockResolvedValue(undefined),
}
vi.mock('@/lib/ipc', () => ({ api: { design: mockApi } }))
vi.mock('@/features/notifications/toast-store', () => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
}))

const { useDesignStore } = await import('@/store/designStore')
const { DesignBreadcrumb } = await import('./DesignBreadcrumb')

function openDoc(folderId: string | null): void {
  const doc = {
    id: 'd1',
    title: 'Landing',
    status: 'active',
    folderId,
    thumbnailVersion: null,
    createdAt: 1,
    updatedAt: 1,
    tokens: {},
    fonts: [],
    globalCss: '',
    nodeIds: [],
    pages: [],
  } as unknown as DesignDocument
  useDesignStore.setState({
    docId: 'd1',
    doc,
    hubFolder: 'recent',
    folders: [
      {
        id: 'f1',
        name: 'Cliente Acme',
        color: null,
        sortOrder: 0,
        docCount: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('DesignBreadcrumb', () => {
  it('shows Designs / folder / document', () => {
    openDoc('f1')
    render(<DesignBreadcrumb />)
    expect(screen.getByRole('button', { name: 'Designs' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cliente Acme' })).toBeInTheDocument()
    expect(screen.getByText('Landing')).toHaveAttribute('aria-current', 'page')
  })

  it('the folder crumb closes the document and lands on that folder', async () => {
    openDoc('f1')
    render(<DesignBreadcrumb />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cliente Acme' }))
    })
    expect(useDesignStore.getState().docId).toBeNull()
    expect(useDesignStore.getState().hubFolder).toBe('f1')
    expect(mockApi.activeDocSet).toHaveBeenCalledWith(null)
  })

  it('an unfiled document goes back to Sem pasta; Designs goes to Recentes', async () => {
    openDoc(null)
    const view = render(<DesignBreadcrumb />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sem pasta' }))
    })
    expect(useDesignStore.getState().hubFolder).toBe('unfiled')
    view.unmount()

    openDoc(null)
    useDesignStore.setState({ hubFolder: 'archived' })
    render(<DesignBreadcrumb />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Designs' }))
    })
    expect(useDesignStore.getState().hubFolder).toBe('recent')
    expect(useDesignStore.getState().docId).toBeNull()
  })
})
