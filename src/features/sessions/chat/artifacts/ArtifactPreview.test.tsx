import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { exportToSvg } = vi.hoisted(() => ({
  exportToSvg: vi.fn(async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
}))

vi.mock('@/lib/ipc', () => ({
  diagramsApi: {
    get: vi.fn(async () => ({
      id: 'd1',
      title: 'Arquitetura',
      scene: { elements: [{ id: 'api', type: 'rectangle' }] },
    })),
  },
  designApi: {},
}))
vi.mock('@/features/diagrams/excalidraw-lazy', () => ({
  loadExcalidrawUtils: async () => ({ exportToSvg }),
}))

import { DiagramPreview } from './ArtifactPreview'

const live = {
  status: 'ready' as const,
  title: 'Arquitetura',
  thumbnail: null,
  editing: false,
  revision: 1,
  focusArtboardId: null,
}

describe('DiagramPreview', () => {
  it('exporta no modo escuro, sem fundo branco e sem subset de fontes (CSP sem unsafe-eval)', async () => {
    const { container } = render(<DiagramPreview id="d1" live={live} />)
    await waitFor(() => expect(container.querySelector('svg[role="img"]')).not.toBeNull())
    expect(exportToSvg).toHaveBeenCalledWith(
      expect.objectContaining({
        skipInliningFonts: true,
        appState: expect.objectContaining({ exportWithDarkMode: true, exportBackground: false }),
      }),
    )
  })
})
