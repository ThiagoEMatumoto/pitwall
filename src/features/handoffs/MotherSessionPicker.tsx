// Picker da sessão-mãe de um handoff. Extraído do diálogo de nova sessão porque
// a adoção de uma sessão JÁ aberta (outra etapa) precisa exatamente da mesma
// pergunta: "quem é a mãe?" — e a resposta tem que ser uma escolha explícita, não
// um palpite a partir do foco.

import { useMemo } from 'react'
import { useAppStore } from '@/store/appStore'
import type { LiveSessionInfo } from '../../../shared/types/ipc'

// Rótulo de uma candidata: o apelido/título vem primeiro porque é o ENDEREÇO do
// peer (o `to` do SendMessage); o repo entra só como desempate visual. Pura →
// testável.
export function motherOptionLabel(s: LiveSessionInfo): string {
  const name = s.title?.trim() || s.name?.trim() || 'sessão sem nome'
  return s.repo?.label ? `${name} · ${s.repo.label}` : name
}

interface Props {
  value: string | null
  onChange: (sessionId: string | null) => void
  // Sessão que não pode figurar como mãe (ex.: a própria candidata a filha, no
  // fluxo de adoção). Null = ninguém excluído.
  excludeSessionId?: string | null
  label?: string
}

export function MotherSessionPicker({
  value,
  onChange,
  excludeSessionId = null,
  label = 'Sessão mãe',
}: Props) {
  const liveSessions = useAppStore((s) => s.liveSessions)
  // Só sessões vivas: uma mãe 'ended' não tem para onde receber o report de volta.
  const candidates = useMemo(
    () => liveSessions.filter((s) => s.status !== 'ended' && s.id !== excludeSessionId),
    [liveSessions, excludeSessionId],
  )

  return (
    <div className="w-full">
      <label className="mb-1 block text-xs text-[var(--color-text-dim)]">{label}</label>
      {candidates.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-dim)]">
          Nenhuma sessão viva para ser mãe — abra uma sessão normal primeiro.
        </div>
      ) : (
        <select
          data-testid="mother-session-picker"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        >
          <option value="">— escolher a mãe —</option>
          {candidates.map((s) => (
            <option key={s.id} value={s.id}>
              {motherOptionLabel(s)}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
