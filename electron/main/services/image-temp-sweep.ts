import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

// Remove de `dir` os temporários de imagem que casam com `shouldRemove`, poupando
// os que `isKept` protege. Best-effort: diretório inexistente ou arquivo sumindo
// numa corrida não derruba boot/exit.
export function sweepImageTempDir(
  dir: string,
  shouldRemove: (filename: string) => boolean,
  isKept: (filename: string) => boolean,
): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!shouldRemove(name) || isKept(name)) continue
    try {
      unlinkSync(join(dir, name))
    } catch {
      // já removido / em uso — segue
    }
  }
}

// Quem mais segura referências a temps de imagem: a fila durável guarda o path
// colado no texto do item, que pode ser entregue depois de um kill, do exit da PTY
// ou do reboot. Sem o keeper, o sweep apagaria a imagem antes da entrega.
const keepers: Array<(filename: string) => boolean> = []

export function registerImageKeeper(keep: (filename: string) => boolean): void {
  keepers.push(keep)
}

export function imageKeptByKeepers(filename: string): boolean {
  return keepers.some((keep) => keep(filename))
}
