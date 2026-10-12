import type Database from 'better-sqlite3'
import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { draftReferencesFile } from './composer-drafts'

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
// (inclusive o /exit da hibernação) ou do reboot. Sem o keeper, o sweep apagaria a
// imagem antes da entrega.
const keepers: Array<(filename: string) => boolean> = []

export function registerImageKeeper(keep: (filename: string) => boolean): void {
  keepers.push(keep)
}

export function imageKeptByKeepers(filename: string): boolean {
  return keepers.some((keep) => keep(filename))
}

// Remove temporários de imagem que casam com o predicado, menos os referenciados
// por um rascunho persistido do Composer (o rascunho sobrevive ao reboot, ao exit
// da PTY e à hibernação; a imagem dele também precisa) e os que um keeper segura.
// Sem conseguir ler os rascunhos, não apaga nada: perder a imagem de um rascunho é
// pior que um temp a mais.
export function sweepImageTempsKeepingDrafts(
  db: () => Database.Database,
  dir: string,
  shouldRemove: (filename: string) => boolean,
): void {
  let isKept: (filename: string) => boolean
  try {
    isKept = draftReferencesFile(db())
  } catch (err) {
    console.error('[sessions] sweep de imagens adiado: rascunhos ilegíveis', err)
    return
  }
  const kept = isKept
  sweepImageTempDir(dir, shouldRemove, (name) => kept(name) || imageKeptByKeepers(name))
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
