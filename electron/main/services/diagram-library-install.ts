import { parseExcalidrawLibrary } from '../../../shared/diagram-library'
import type { InstallDiagramLibraryResult } from '../../../shared/types/ipc'
import * as libraryStore from './diagram-library-store'

// Instalação de bibliotecas .excalidrawlib — caminho ÚNICO de IPC e MCP.
// O fetch mora no MAIN de propósito: o CSP do renderer não deixa buscar
// domínio arbitrário, e é aqui que dá pra impor timeout e cap de tamanho.

const FETCH_TIMEOUT_MS = 15_000
const MAX_LIBRARY_BYTES = 5 * 1024 * 1024

// Parse + merge por id no store. `added` conta os itens do ARQUIVO (novos ou
// sobrescritos) — é o número do toast, não o tamanho da biblioteca.
export function installLibraryJson(json: unknown): InstallDiagramLibraryResult {
  const parsed = parseExcalidrawLibrary(json)
  const items = libraryStore.addItems(parsed)
  return { items, added: parsed.length }
}

export async function installLibraryFromUrl(url: string): Promise<InstallDiagramLibraryResult> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`falha ao baixar a biblioteca de ${url}: ${detail}`)
  }
  if (!res.ok) {
    throw new Error(`falha ao baixar a biblioteca: HTTP ${res.status} em ${url}`)
  }

  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_LIBRARY_BYTES) {
    throw new Error(`biblioteca excede o limite de 5 MB (content-length: ${declared} bytes)`)
  }
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_LIBRARY_BYTES) {
    throw new Error(`biblioteca excede o limite de 5 MB (recebido ${buf.byteLength} bytes)`)
  }

  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(buf))
  } catch {
    throw new Error(`resposta de ${url} não é JSON válido`)
  }
  return installLibraryJson(json)
}
