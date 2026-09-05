import { useEffect, useRef, useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { IconPicker } from '@/components/ui/IconPicker'
import { ColorSelect } from '@/components/ui/ColorSelect'
import { dialogApi, fsApi, vaultApi } from '@/lib/ipc'
import { COLORS } from './NewProjectDialog'
import type { Project, UpdateProjectInput } from '../../../shared/types/ipc'

interface Props {
  open: boolean
  onClose: () => void
  project: Project
  onSave: (input: UpdateProjectInput) => Promise<void>
}

function joinPath(root: string, name: string): string {
  return `${root.replace(/\/+$/, '')}/${name}`
}

export function EditProjectDialog({ open, onClose, project, onSave }: Props) {
  const [name, setName] = useState(project.name)
  const [color, setColor] = useState<string>(project.color ?? COLORS[0])
  const [icon, setIcon] = useState<string | null>(project.icon ?? null)
  const [submitting, setSubmitting] = useState(false)

  const [root, setRoot] = useState('')
  const [newVault, setNewVault] = useState<string | null>(null)
  const [vaultMissing, setVaultMissing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setName(project.name)
    setColor(project.color ?? COLORS[0])
    setIcon(project.icon ?? null)
    setNewVault(null)
    setVaultMissing(false)
    if (!project.vaultPath) void vaultApi.getRoot().then(setRoot)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open, project])

  const currentVault = project.vaultPath ?? null

  // Não há IPC de "existe?": listDir rejeita quando a pasta sumiu. É o caso real
  // de projeto renomeado — o vault_path continua apontando pro nome antigo.
  useEffect(() => {
    if (!open || !currentVault) return
    let alive = true
    fsApi
      .listDir(currentVault)
      .then(() => alive && setVaultMissing(false))
      .catch(() => alive && setVaultMissing(true))
    return () => {
      alive = false
    }
  }, [open, currentVault])

  const slug = name.trim().replace(/\s+/g, '-').toLowerCase()
  const defaultVault = root && slug ? joinPath(root, slug) : ''
  const pendingVault = newVault ?? currentVault ?? (defaultVault || null)

  async function pickVault() {
    const picked = await dialogApi.openDirectory()
    if (picked) setNewVault(picked)
  }

  async function handleSubmit() {
    if (!name.trim() || submitting) return
    setSubmitting(true)
    try {
      const input: UpdateProjectInput = {
        id: project.id,
        name: name.trim(),
        color,
        icon,
      }
      if (pendingVault && pendingVault !== currentVault) {
        // Só o vault novo é criado/checado; reapontar um projeto existente é
        // troca de referência — a pasta escolhida já existe.
        if (!currentVault) {
          const { created, wasEmpty } = await vaultApi.ensureDir(pendingVault)
          if (!created && !wasEmpty) {
            if (!confirm('Esta pasta já tem arquivos — continuar?')) return
          }
        }
        input.vaultPath = pendingVault
      }
      await onSave(input)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Editar projeto"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim()} loading={submitting}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="flex items-end gap-2">
        <div>
          <label className="mb-1 block text-xs text-[var(--color-text-dim)]">Ícone</label>
          <IconPicker value={icon} onChange={setIcon} />
        </div>
        <Input
          ref={inputRef}
          label="Nome"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSubmit()
          }}
        />
      </div>

      <label className="mb-1 mt-4 block text-xs text-[var(--color-text-dim)]">Cor</label>
      <ColorSelect value={color} onChange={setColor} options={COLORS} />

      <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-1 text-xs text-[var(--color-text-dim)]">Vault</div>
        <div className="truncate text-sm text-[var(--color-text)]" title={pendingVault ?? undefined}>
          {pendingVault ?? <span className="text-[var(--color-text-dim)]">defina um nome…</span>}
        </div>
        {currentVault && vaultMissing && !newVault && (
          <div className="mt-1 text-xs text-[var(--color-danger)]">
            Esta pasta não existe no disco — escolha o caminho correto.
          </div>
        )}
        <button
          type="button"
          onClick={pickVault}
          className="mt-2 text-xs text-[var(--color-accent)] hover:underline"
        >
          Escolher outra pasta
        </button>
        {currentVault && (
          <div className="mt-1 text-xs text-[var(--color-text-dim)]">
            Trocar o caminho apenas reaponta o projeto: nada é movido ou renomeado no disco.
          </div>
        )}
      </div>
    </Dialog>
  )
}
