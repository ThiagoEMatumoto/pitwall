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

// Sweep das imagens de uma sessão que saiu: uma imagem colada pode estar só no
// debounce do rascunho do renderer, ainda fora do app.db. Primeiro o flush; sem
// confirmação dele, não apaga nada (o sweep do boot pega os órfãos depois).
export async function sweepAfterDraftFlush(
  flushDrafts: () => Promise<boolean>,
  sweep: () => void,
): Promise<boolean> {
  let flushed = false
  try {
    flushed = await flushDrafts()
  } catch (err) {
    console.error('[sessions] flush dos rascunhos antes do sweep falhou:', err)
  }
  if (!flushed) {
    console.warn('[sessions] sweep de imagens adiado: rascunhos sem flush confirmado')
    return false
  }
  sweep()
  return true
}
