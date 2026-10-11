import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

// Remove de `dir` os temporários de imagem que casam com `shouldRemove`, poupando
// os que `isKept` protege (referenciados por rascunho persistido). Best-effort:
// diretório inexistente ou arquivo sumindo numa corrida não derruba boot/exit.
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
