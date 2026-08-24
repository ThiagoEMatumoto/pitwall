import type { DiagramLibraryItem } from './types/ipc'

// Parser de arquivos .excalidrawlib — TS puro (sem DOM, sem Node API), roda no
// main (install por URL / MCP) e poderia rodar no renderer. É a validação
// PRÓPRIA do formato: o main não pode importar @excalidraw/* (o bundle da lib
// exige browser), então o contrato do arquivo é verificado aqui.
//
// Formato v2: { type: 'excalidrawlib', version: 2, libraryItems: LibraryItem[] }
// Formato v1 legado: campo `library` no lugar de `libraryItems`, e cada entrada
// é um ARRAY de elements SEM wrapper — convertida pra item v2 com id gerado.

// crypto.randomUUID existe em Node 19+ e nos browsers; o fallback cobre
// ambientes de teste antigos sem quebrar (id só precisa ser único localmente).
function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
}

function invalid(detail: string): Error {
  return new Error(`biblioteca .excalidrawlib inválida: ${detail}`)
}

function toItem(raw: unknown, index: number, now: number): DiagramLibraryItem {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid(`item ${index} não é um objeto`)
  }
  const it = raw as Record<string, unknown>
  if (!Array.isArray(it.elements)) {
    throw invalid(`item ${index} sem campo elements (array)`)
  }
  return {
    id: typeof it.id === 'string' && it.id.length > 0 ? it.id : randomId(),
    name: typeof it.name === 'string' ? it.name : null,
    status: it.status === 'published' ? 'published' : 'unpublished',
    elements: it.elements,
    created: typeof it.created === 'number' ? it.created : now,
  }
}

export function parseExcalidrawLibrary(json: unknown): DiagramLibraryItem[] {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw invalid('esperado um objeto JSON')
  }
  const lib = json as Record<string, unknown>
  if (lib.type !== 'excalidrawlib') {
    throw invalid(`type deve ser "excalidrawlib" (recebido ${JSON.stringify(lib.type ?? null)})`)
  }
  const now = Date.now()

  if (lib.libraryItems !== undefined) {
    if (!Array.isArray(lib.libraryItems)) throw invalid('libraryItems deve ser um array')
    return lib.libraryItems.map((raw, i) => toItem(raw, i, now))
  }

  if (lib.library !== undefined) {
    if (!Array.isArray(lib.library)) throw invalid('library (v1) deve ser um array')
    return lib.library.map((elements, i) => {
      if (!Array.isArray(elements)) {
        throw invalid(`entrada ${i} do formato v1 deveria ser um array de elementos`)
      }
      return {
        id: randomId(),
        name: null,
        status: 'unpublished' as const,
        elements,
        created: now,
      }
    })
  }

  throw invalid('sem libraryItems (v2) nem library (v1)')
}
