import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { useDesignStore } from '@/store/designStore'

export const DELETE_ARTBOARD_TESTIDS = {
  confirm: 'design-artboard-delete-confirm',
} as const

// Mounted once by DesignArea: the sidebar menu and the Delete key open the
// same confirmation instead of each carrying a dialog.
export function DeleteArtboardDialog() {
  const artboardId = useDesignStore((s) => s.artboardToDelete)
  const name = useDesignStore((s) =>
    s.artboardToDelete ? (s.artboards[s.artboardToDelete]?.meta.name ?? '') : '',
  )
  const requestDeleteArtboard = useDesignStore((s) => s.requestDeleteArtboard)
  const deleteArtboard = useDesignStore((s) => s.deleteArtboard)

  if (!artboardId) return null

  const close = (): void => requestDeleteArtboard(null)

  return (
    <Dialog
      open
      onClose={close}
      title="Excluir artboard"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            data-testid={DELETE_ARTBOARD_TESTIDS.confirm}
            onClick={() => {
              close()
              void deleteArtboard(artboardId)
            }}
          >
            Excluir
          </Button>
        </>
      }
    >
      <p className="text-sm text-[var(--color-text)]">
        Excluir <strong>{name}</strong>? O conteúdo e o histórico de versões dele vão junto, e o
        Cmd+Z não traz de volta.
      </p>
    </Dialog>
  )
}
