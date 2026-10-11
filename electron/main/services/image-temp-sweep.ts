import type Database from 'better-sqlite3'
import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { draftReferencesFile } from './composer-drafts'

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

// Remove temporários de imagem que casam com o predicado, menos os referenciados
// por um rascunho persistido do Composer (o rascunho sobrevive ao reboot, ao exit
// da PTY e à hibernação; a imagem dele também precisa). Sem conseguir ler os
// rascunhos, não apaga nada: perder a imagem de um rascunho é pior que um temp a mais.
// Quem mais segura referências a temps de imagem (ex.: mensagem retida na fila
// durante o /exit da hibernação, entregue só na sessão acordada).
const extraKeepers: Array<(filename: string) => boolean> = []

export function registerImageKeeper(keep: (filename: string) => boolean): void {
  extraKeepers.push(keep)
}

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
  sweepImageTempDir(dir, shouldRemove, (name) => kept(name) || extraKeepers.some((k) => k(name)))
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
