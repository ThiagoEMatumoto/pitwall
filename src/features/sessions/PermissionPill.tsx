import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { PermissionMode } from '../../../shared/types/ipc'
import { Icon } from '@/components/ui/Icon'
import { Menu, type MenuSection } from '@/components/ui/Menu'
import { PERMISSION_OPTIONS, PERMISSION_SHORT_LABELS } from './permission-modes'
import { pillDensity } from './pill-density'
import { permissionStyle } from './pill-state'
import type { PanelTier } from './use-panel-tier'

interface SectionArgs {
  /** Modo ATIVO (refletido do rodapé da TUI). null = ainda não detectado → padrão seguro. */
  currentMode: PermissionMode | null
  /** Seleção direta de um modo (quando a fiação suportar set-exato). */
  onSelect?: (mode: PermissionMode) => void
  /** Fallback: envia um passo de ciclo (Shift+Tab) ao PTY. */
  onCycle?: () => void
}

interface Props extends SectionArgs {
  /** Densidade do rodapé (pillDensity): wide = rótulo completo + caret; mid =
   *  rótulo curto sem caret; narrow = só o ícone (valor vai pro title/aria-label). */
  tier: PanelTier
}

const PILL_TITLE =
  'Modo de permissão (ativo refletido do rodapé do Claude). O modo exato é garantido na criação da sessão; em runtime, selecionar avança o ciclo nativo (Shift+Tab).'

// Itens do menu de permissão. Exportado porque no painel estreito o controle
// migra pro menu "⋯" do ComposerToolbar: a lista de modos não pode existir em
// dois lugares, senão uma delas envelhece sozinha.
export function permissionSection({ currentMode, onSelect, onCycle }: SectionArgs): MenuSection {
  return {
    title: 'Permissão · modo ativo destacado',
    // TODOS os modos são clicáveis. 'dontAsk' fica fora do ciclo nativo (Shift+Tab),
    // então não é alcançável em runtime: clicar nele "pula" sem achar e volta ao
    // modo atual (no-op gracioso) — o sufixo "spawn-only" sinaliza isso.
    items: PERMISSION_OPTIONS.map((opt) => ({
      label: opt.value === 'dontAsk' ? `${opt.label} · spawn-only` : opt.label,
      active: opt.value === currentMode,
      onClick: () => {
        if (onSelect) onSelect(opt.value)
        else onCycle?.()
      },
    })),
  }
}

// Seletor VISÍVEL de modo de permissão, colorido pelo modo ATIVO (permissionStyle):
// default/plan = seguro (cor normal, ShieldCheck); acceptEdits = aviso (âmbar);
// auto/bypass/dontAsk = perigo (vermelho, ShieldAlert). O ícone segue o estado.
//
// Aplicação: na CRIAÇÃO da sessão o modo é EXATO (SpawnSessionDialog → --permission-mode).
// Em runtime a CLI não tem set-exato (sem /permission) — só o ciclo nativo via Shift+Tab.
// Por isso clicar num modo prefere onSelect (quando a fiação souber aplicar) e cai em
// onCycle (UM passo do ciclo) como fallback. O modo ativo vem do rodapé do próprio Claude.
export function PermissionPill({ currentMode, onSelect, onCycle, tier }: Props) {
  const [open, setOpen] = useState(false)
  const style = permissionStyle(currentMode)
  const { pad, showCaret, showLabel } = pillDensity(tier)

  const shortLabel = currentMode
    ? PERMISSION_SHORT_LABELS[currentMode]
    : PERMISSION_SHORT_LABELS.default
  const fullLabel = PERMISSION_OPTIONS.find((opt) => opt.value === currentMode)?.label ?? 'Padrão'
  const activeLabel = tier === 'wide' ? fullLabel : shortLabel

  const sections: MenuSection[] = [permissionSection({ currentMode, onSelect, onCycle })]

  // No narrow o rótulo some da tela — o modo tem de migrar pro nome acessível,
  // senão o controle fica mudo pra quem usa leitor de tela. Com o rótulo
  // visível, NÃO setar aria-label (o nome acessível tem de conter o texto visto).
  const hiddenValue = showLabel ? null : `Permissão: ${fullLabel}`

  return (
    <Menu open={open} onClose={() => setOpen(false)} sections={sections} portal align="left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={[hiddenValue, PILL_TITLE].filter(Boolean).join(' — ')}
        aria-label={hiddenValue ?? undefined}
        className={`flex items-center gap-1 rounded-full border border-[var(--color-border)] py-0.5 text-[10px] transition hover:border-current/50 ${pad} ${style.text}`}
      >
        <Icon as={style.icon} size={11} style={{ color: style.color }} />
        {showLabel && <span className="whitespace-nowrap">{activeLabel}</span>}
        {showCaret && <Icon as={ChevronDown} size={10} className="text-[var(--color-text-dim)]" />}
      </button>
    </Menu>
  )
}
