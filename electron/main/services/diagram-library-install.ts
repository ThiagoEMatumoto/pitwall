import { parseExcalidrawLibrary } from '../../../shared/diagram-library'
import {
  DIAGRAM_LIBRARY_CATALOG,
  findCatalogEntry,
  findCatalogEntryByUrl,
} from '../../../shared/diagram-library-catalog'
import type {
  DiagramLibraryItem,
  InstallDiagramLibraryResult,
} from '../../../shared/types/ipc'
import * as libraryStore from './diagram-library-store'
import { getPref, setPref } from './prefs-store'

// Instalação de bibliotecas .excalidrawlib — caminho ÚNICO de IPC e MCP.
// O fetch mora no MAIN de propósito: o CSP do renderer não deixa buscar
// domínio arbitrário, e é aqui que dá pra impor timeout e cap de tamanho.

const FETCH_TIMEOUT_MS = 15_000
const MAX_LIBRARY_BYTES = 5 * 1024 * 1024

// Parse + merge por id no store. `added` conta os itens do ARQUIVO (novos ou
// sobrescritos) — é o número do toast, não o tamanho da biblioteca.
export function installLibraryJson(json: unknown): InstallDiagramLibraryResult {
  return installParsed(json).result
}

// `replacing`: ids de uma instalação anterior a apagar antes do merge — só
// depois do parse, pra um arquivo quebrado não destruir a cópia que funciona.
function installParsed(
  json: unknown,
  replacing: string[] = [],
): { result: InstallDiagramLibraryResult; ids: string[] } {
  const parsed = parseExcalidrawLibrary(json)
  if (replacing.length > 0) libraryStore.removeItems(replacing)
  const items = libraryStore.addItems(parsed)
  return { result: { items, added: parsed.length }, ids: parsed.map((i) => i.id) }
}

export async function installLibraryFromUrl(url: string): Promise<InstallDiagramLibraryResult> {
  const json = await fetchLibraryJson(url)
  // Instalar a URL de uma entrada do catálogo à mão conta como instalar a entrada.
  // Reinstalar SUBSTITUI o lote anterior: arquivos v1 (uml-er, database) não têm
  // id por item, o parser gera ids novos a cada vez e o merge por id duplicaria.
  const entry = findCatalogEntryByUrl(url)
  const previous = entry ? (readCatalogInstalls()[entry.id] ?? []) : []
  const { result, ids } = installParsed(json, previous)
  if (entry) recordCatalogInstall(entry.id, ids)
  return result
}

async function fetchLibraryJson(url: string): Promise<unknown> {
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
  return json
}

// ---- catálogo curado ----
// Origem sem migration: app_prefs guarda catalogId → ids dos itens que o arquivo
// trouxe. "Instalada" é DERIVADO de diagram_library_items — se o usuário apagar
// todos os itens no painel do Excalidraw, a entrada volta a "Instalar". Os dois
// lados são machine-local (nenhum entra no bundle de sync).

const CATALOG_INSTALLS_PREF = 'diagram_library_catalog_installs'

type CatalogInstalls = Record<string, string[]>

function readCatalogInstalls(): CatalogInstalls {
  const raw = getPref<unknown>(CATALOG_INSTALLS_PREF, {})
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: CatalogInstalls = {}
  for (const [id, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(ids)) out[id] = ids.filter((x): x is string => typeof x === 'string')
  }
  return out
}

function recordCatalogInstall(catalogId: string, ids: string[]): void {
  setPref(CATALOG_INSTALLS_PREF, { ...readCatalogInstalls(), [catalogId]: ids })
}

function requireCatalogEntry(catalogId: string) {
  const entry = findCatalogEntry(catalogId)
  if (!entry) {
    const known = DIAGRAM_LIBRARY_CATALOG.map((e) => e.id).join(', ')
    throw new Error(`biblioteca "${catalogId}" não está no catálogo (ids: ${known})`)
  }
  return entry
}

export async function installCatalogLibrary(
  catalogId: string,
): Promise<InstallDiagramLibraryResult> {
  return installLibraryFromUrl(requireCatalogEntry(catalogId).url)
}

export function installedCatalogIds(
  items: DiagramLibraryItem[] = libraryStore.getItems(),
): string[] {
  const present = new Set(items.map((i) => i.id))
  return Object.entries(readCatalogInstalls())
    .filter(([id, ids]) => findCatalogEntry(id) && ids.some((x) => present.has(x)))
    .map(([id]) => id)
}

export function removeCatalogLibrary(catalogId: string): DiagramLibraryItem[] {
  requireCatalogEntry(catalogId)
  const installs = readCatalogInstalls()
  const ids = installs[catalogId] ?? []
  const items = libraryStore.removeItems(ids)
  const { [catalogId]: _removed, ...rest } = installs
  setPref(CATALOG_INSTALLS_PREF, rest)
  return items
}
