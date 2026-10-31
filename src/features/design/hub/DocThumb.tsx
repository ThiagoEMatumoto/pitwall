import { useState } from 'react'
import { LayoutTemplate } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { thumbUrl } from '@shared/design/thumb-url'

// Dot grid like an empty canvas: a document with no thumbnail yet (or a 404)
// reads as "blank design", not as a broken image.
function ThumbPlaceholder() {
  return (
    <div
      aria-hidden
      data-testid="thumb-placeholder"
      className="flex h-full w-full items-center justify-center text-[var(--color-text-dim)] opacity-60"
      style={{
        backgroundImage:
          'radial-gradient(color-mix(in srgb, var(--color-text-dim) 22%, transparent) 1px, transparent 1px)',
        backgroundSize: '14px 14px',
      }}
    >
      <Icon as={LayoutTemplate} size={22} />
    </div>
  )
}

// Callers key it by version so a failed image retries when a new one lands.
export function DocThumb({ docId, version }: { docId: string; version: string | null }) {
  const [failed, setFailed] = useState(false)
  if (!version || failed) return <ThumbPlaceholder />
  return (
    <img
      src={thumbUrl(docId, version)}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className="h-full w-full object-cover object-top"
    />
  )
}
