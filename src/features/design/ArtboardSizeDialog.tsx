import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { ARTBOARD_MAX_PX, ARTBOARD_MIN_PX, clampArtboardSize } from '@shared/design/safety'
import { NumberField } from './inspector/controls/NumberField'

// Mount it only while it should be shown: the initial size seeds local state.
interface Props {
  onClose: () => void
  onSubmit: (width: number, height: number) => void
  title: string
  initial: { width: number; height: number }
  submitLabel?: string
}

export const ARTBOARD_SIZE_TESTIDS = {
  dialog: 'design-artboard-size-dialog',
  submit: 'design-artboard-size-submit',
} as const

export function ArtboardSizeDialog({
  onClose,
  onSubmit,
  title,
  initial,
  submitLabel = 'Criar',
}: Props) {
  const [width, setWidth] = useState(initial.width)
  const [height, setHeight] = useState(initial.height)

  function submit(): void {
    onClose()
    onSubmit(clampArtboardSize(width), clampArtboardSize(height))
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      widthClassName="w-[22rem]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button data-testid={ARTBOARD_SIZE_TESTIDS.submit} onClick={submit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <div data-testid={ARTBOARD_SIZE_TESTIDS.dialog} className="flex items-center gap-2">
        <NumberField
          label="W"
          value={width}
          min={ARTBOARD_MIN_PX}
          max={ARTBOARD_MAX_PX}
          onCommit={(v) => v != null && setWidth(v)}
        />
        <NumberField
          label="H"
          value={height}
          min={ARTBOARD_MIN_PX}
          max={ARTBOARD_MAX_PX}
          onCommit={(v) => v != null && setHeight(v)}
        />
      </div>
      <p className="mt-2 text-[11px] text-[var(--color-text-dim)]">
        Entre {ARTBOARD_MIN_PX} e {ARTBOARD_MAX_PX} px.
      </p>
    </Dialog>
  )
}
