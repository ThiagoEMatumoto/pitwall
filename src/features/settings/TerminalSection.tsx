import { useEffect, useState } from 'react'
import { appApi, gpuApi } from '@/lib/ipc'
import { useTerminalPrefsStore } from '@/lib/terminal-prefs-store'
import type { GpuStatus } from '../../../shared/types/ipc'

// Seção "Terminal" das Configurações (extraída do GeneralTab, que passou de 400
// linhas): scrollback, navegação visual e controles de GPU. As prefs de GPU são
// lidas pelo main ANTES do ready — só aplicam após reiniciar o app; o botão
// "Reiniciar agora" aparece quando a pref diverge do estado em vigor.
export function TerminalSection({ open }: { open: boolean }) {
  const scrollback = useTerminalPrefsStore((s) => s.scrollback)
  const setScrollback = useTerminalPrefsStore((s) => s.setScrollback)
  const visualLineNav = useTerminalPrefsStore((s) => s.visualLineNav)
  const setVisualLineNav = useTerminalPrefsStore((s) => s.setVisualLineNav)
  const [gpu, setGpu] = useState<GpuStatus | null>(null)
  const [isLinux, setIsLinux] = useState(false)

  useEffect(() => {
    if (!open) return
    void useTerminalPrefsStore.getState().load()
    void gpuApi.status().then(setGpu)
    void appApi.getInfo().then((info) => setIsLinux(info.platform === 'linux'))
  }, [open])

  function updateGpuDisabled(v: boolean) {
    if (!gpu) return
    setGpu({ ...gpu, prefDisabled: v })
    void gpuApi.setDisabled(v)
  }

  function updateOzone(v: boolean) {
    if (!gpu) return
    setGpu({ ...gpu, prefOzone: v })
    void gpuApi.setOzone(v)
  }

  const restartPending =
    gpu !== null && (gpu.prefDisabled !== gpu.hwAccelDisabled || gpu.prefOzone !== gpu.ozoneWayland)

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
        Terminal
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-[var(--color-text)]">Linhas de histórico (scrollback)</div>
          <div className="text-xs text-[var(--color-text-dim)]">
            Quantas linhas o terminal mantém roláveis (200–50000).
          </div>
        </div>
        <input
          type="number"
          min={200}
          max={50000}
          step={500}
          value={scrollback}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n)) void setScrollback(n)
          }}
          className="w-24 shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2 py-1 text-right text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
      </div>

      <label className="mt-3 flex items-start justify-between gap-3 border-t border-[var(--color-border)] pt-3">
        <div className="min-w-0">
          <div className="text-sm text-[var(--color-text)]">Navegação por linha visual (↑/↓ no prompt)</div>
          <div className="text-xs text-[var(--color-text-dim)]">
            ↑/↓ movem o cursor pelas linhas do prompt em vez de ir pro histórico. Pode
            interferir no histórico e em menus de seleção do claude. Para compor prompts
            longos sem isso, use o editor de prompt (Ctrl+Shift+E).
          </div>
        </div>
        <input
          type="checkbox"
          checked={visualLineNav}
          onChange={(e) => void setVisualLineNav(e.target.checked)}
          className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
        />
      </label>

      <label className="mt-3 flex items-start justify-between gap-3 border-t border-[var(--color-border)] pt-3">
        <div className="min-w-0">
          <div className="text-sm text-[var(--color-text)]">Desativar aceleração de GPU</div>
          <div className="text-xs text-[var(--color-text-dim)]">
            Use se a janela ficar preta ao abrir o app. Requer reiniciar.
          </div>
        </div>
        <input
          type="checkbox"
          checked={gpu?.prefDisabled ?? false}
          disabled={gpu === null}
          onChange={(e) => updateGpuDisabled(e.target.checked)}
          className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
        />
      </label>

      {isLinux && (
        <label className="mt-3 flex items-start justify-between gap-3 border-t border-[var(--color-border)] pt-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">Wayland nativo</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Ligado por padrão. Sem ele o app roda sob XWayland, onde uma tecla que
              trava no teclado vira digitação fantasma. Desligue só se a janela ficar
              preta. Requer reiniciar.
            </div>
          </div>
          <input
            type="checkbox"
            checked={gpu?.prefOzone ?? true}
            disabled={gpu === null}
            onChange={(e) => updateOzone(e.target.checked)}
            className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
          />
        </label>
      )}

      {restartPending && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-3">
          <div className="text-xs text-[var(--color-text-dim)]">
            Mudanças de GPU aplicam após reiniciar o app.
          </div>
          <button
            type="button"
            onClick={() => void gpuApi.relaunch()}
            className="shrink-0 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Reiniciar agora
          </button>
        </div>
      )}
    </div>
  )
}
