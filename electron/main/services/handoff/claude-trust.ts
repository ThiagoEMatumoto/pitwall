// Pré-aceita o "Do you trust the files in this folder?" do claude para o
// diretório de uma filha. Sem isto, filha num repo/worktree onde o claude nunca
// foi aberto parava nesse diálogo antes do 1º turno — sem session file, o card
// dizia "filha encerrou" e nada entrava na fila.
//
// Formato real do ~/.claude.json (conferido em 2026-11-01, CLI 2.1.316):
// projects["<caminho absoluto>"].hasTrustDialogAccepted = true, chaveado pela
// raiz do repo (não há chave por worktree) — por isso o chamador passa a raiz do
// checkout principal junto com o cwd.
//
// O claude reescreve esse arquivo inteiro em toda sessão: o read-modify-write é
// curto, só acontece quando falta trust e nunca escreve se o parse falhar (o
// diálogo, aí, aparece e a fila de atenção o mostra — camada 2).
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

// true = todos os diretórios ficaram com trust (já tinham ou foram gravados).
// Nunca lança: arquivo ausente, JSON inválido ou falha de escrita devolvem false.
export function preTrustClaudeDirs(dirs: string[], home: string = homedir()): boolean {
  const file = join(home, '.claude.json')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  let config: unknown
  try {
    config = JSON.parse(raw)
  } catch {
    return false
  }
  if (!isObject(config)) return false
  const projects = config.projects === undefined ? {} : config.projects
  if (!isObject(projects)) return false

  const missing = [...new Set(dirs)].filter(
    (d) => !(isObject(projects[d]) && projects[d].hasTrustDialogAccepted === true),
  )
  if (missing.length === 0) return true

  const nextProjects: Json = { ...projects }
  for (const d of missing) {
    const prev = isObject(projects[d]) ? projects[d] : {}
    nextProjects[d] = { ...prev, hasTrustDialogAccepted: true }
  }
  const next = { ...config, projects: nextProjects }

  const tmp = `${file}.pitwall-${process.pid}-${Date.now()}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
      mode: statSync(file).mode & 0o777,
    })
    renameSync(tmp, file)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // tmp nem chegou a existir
    }
    return false
  }
}
