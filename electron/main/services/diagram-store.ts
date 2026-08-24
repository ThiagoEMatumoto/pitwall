import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type {
  CreateDiagramInput,
  Diagram,
  DiagramAuthor,
  DiagramKind,
  DiagramLink,
  DiagramListFilter,
  DiagramMeta,
  DiagramParentType,
  DiagramScene,
  DiagramSourceFormat,
  DiagramStatus,
  DiagramVersion,
  DiagramVersionMeta,
  UpdateDiagramSceneInput,
} from '../../../shared/types/ipc'

// Store de diagramas. Molde de content-contract-store: funções soltas, rows
// snake_case ⇄ entidades camelCase, `db.transaction` nas mutações compostas,
// JSON.parse sempre defensivo.
//
// O ponto do módulo é a separação rascunho/snapshot em `updateScene`: TODO
// salvamento muda a cabeça (a cena vigente), mas só snapshot=true bumpa a
// versão e grava linha em diagram_versions — com summary obrigatório, porque
// snapshot sem changelog é histórico ilegível. O cap de 30 snapshots por
// diagrama é aplicado no mesmo tx do bump. `restoreVersion` é git-revert:
// copia o snapshot pra cabeça e grava versão NOVA; nunca apaga histórico.

// Quantos snapshots ficam por diagrama. Cena Excalidraw grande é centenas de
// KB; sem teto o histórico de um diagrama vivo engorda o banco sem limite.
const MAX_SNAPSHOTS = 30

// ---- rows <-> entidades ----

interface DiagramRow {
  id: string
  title: string
  kind: string
  status: string
  scene: string
  source_format: string | null
  source: string | null
  thumbnail: string | null
  version: number
  created_at: number
  updated_at: number
}

interface DiagramVersionRow {
  id: string
  diagram_id: string
  version: number
  author: string
  summary: string
  scene: string
  created_at: number
}

interface DiagramLinkRow {
  diagram_id: string
  parent_type: string
  parent_id: string
}

const EMPTY_SCENE: DiagramScene = { elements: [] }

// JSON gravado por nós, mas ainda assim defendido: uma row corrompida por
// edição manual no sqlite não pode derrubar o get() inteiro.
function parseScene(raw: string): DiagramScene {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const scene = parsed as DiagramScene
      if (Array.isArray(scene.elements)) return scene
    }
  } catch {
    // cai no fallback
  }
  return EMPTY_SCENE
}

function rowToMeta(row: DiagramRow): DiagramMeta {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind as DiagramKind,
    status: row.status as DiagramStatus,
    version: row.version,
    sourceFormat: row.source_format as DiagramSourceFormat | null,
    thumbnail: row.thumbnail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToDiagram(row: DiagramRow): Diagram {
  return {
    ...rowToMeta(row),
    scene: parseScene(row.scene),
    links: listLinks(row.id),
  }
}

function rowToLink(row: DiagramLinkRow): DiagramLink {
  return {
    diagramId: row.diagram_id,
    parentType: row.parent_type as DiagramParentType,
    parentId: row.parent_id,
  }
}

function rowToVersionMeta(row: DiagramVersionRow): DiagramVersionMeta {
  return {
    id: row.id,
    diagramId: row.diagram_id,
    version: row.version,
    author: row.author as DiagramAuthor,
    summary: row.summary,
    createdAt: row.created_at,
  }
}

function getRow(id: string): DiagramRow | undefined {
  return getDb().prepare('SELECT * FROM diagrams WHERE id = ?').get(id) as DiagramRow | undefined
}

const INSERT_VERSION_SQL = `INSERT INTO diagram_versions
    (id, diagram_id, version, author, summary, scene, created_at)
   VALUES
    (@id, @diagram_id, @version, @author, @summary, @scene, @created_at)`

// ---- API pública: diagrams (a cabeça) ----

export function list(filter?: DiagramListFilter): DiagramMeta[] {
  const where: string[] = []
  const params: unknown[] = []

  const status = filter?.status ?? 'active'
  if (status !== 'all') {
    where.push('status = ?')
    params.push(status)
  }
  if (filter?.kind) {
    where.push('kind = ?')
    params.push(filter.kind)
  }
  if (filter?.parentType || filter?.parentId) {
    const linkWhere: string[] = ['diagram_id = diagrams.id']
    if (filter.parentType) {
      linkWhere.push('parent_type = ?')
      params.push(filter.parentType)
    }
    if (filter.parentId) {
      linkWhere.push('parent_id = ?')
      params.push(filter.parentId)
    }
    where.push(`EXISTS (SELECT 1 FROM diagram_links WHERE ${linkWhere.join(' AND ')})`)
  }
  if (filter?.search?.trim()) {
    where.push('title LIKE ?')
    params.push(`%${filter.search.trim()}%`)
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  // Sem `scene` no SELECT: a lista não carrega cenas de megabytes.
  const rows = getDb()
    .prepare(
      `SELECT id, title, kind, status, source_format, source, thumbnail, version,
              created_at, updated_at, '' AS scene
       FROM diagrams ${clause} ORDER BY updated_at DESC, title ASC`,
    )
    .all(...params) as DiagramRow[]
  return rows.map(rowToMeta)
}

export function get(id: string): Diagram | null {
  const row = getRow(id)
  return row ? rowToDiagram(row) : null
}

export function create(input: CreateDiagramInput): Diagram {
  const now = Date.now()
  const id = randomUUID()
  const sceneJson = JSON.stringify(input.scene)

  const db = getDb()
  // Cabeça, versão 1 e links na MESMA transação: diagrama sem snapshot 1 não
  // teria pra onde ser restaurado.
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO diagrams
        (id, title, kind, status, scene, source_format, source, thumbnail, version,
         created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, NULL, 1, ?, ?)`,
    ).run(
      id,
      input.title.trim(),
      input.kind ?? 'other',
      sceneJson,
      input.sourceFormat ?? null,
      input.source ?? null,
      now,
      now,
    )
    db.prepare(INSERT_VERSION_SQL).run({
      id: randomUUID(),
      diagram_id: id,
      version: 1,
      author: input.author,
      summary: input.summary?.trim() || 'versão inicial',
      scene: sceneJson,
      created_at: now,
    })
    for (const link of input.links ?? []) {
      db.prepare(
        `INSERT OR IGNORE INTO diagram_links (diagram_id, parent_type, parent_id)
         VALUES (?, ?, ?)`,
      ).run(id, link.parentType, link.parentId)
    }
  })
  tx()
  return get(id)!
}

export function updateScene(input: UpdateDiagramSceneInput & { author: DiagramAuthor }): Diagram {
  const row = getRow(input.id)
  if (!row) throw new Error(`diagram not found: ${input.id}`)

  const now = Date.now()
  const sceneJson = JSON.stringify(input.scene)
  const db = getDb()

  if (!input.snapshot) {
    // Rascunho: só a cabeça. Sem bump, sem linha de histórico.
    db.prepare('UPDATE diagrams SET scene = ?, updated_at = ? WHERE id = ?').run(
      sceneJson,
      now,
      input.id,
    )
    return get(input.id)!
  }

  // Snapshot sem changelog é histórico ilegível — summary obrigatório aqui,
  // não no rascunho.
  const summary = input.summary?.trim()
  if (!summary) throw new Error('snapshot de diagrama exige summary não-vazio')

  const nextVersion = row.version + 1
  const tx = db.transaction(() => {
    db.prepare('UPDATE diagrams SET scene = ?, version = ?, updated_at = ? WHERE id = ?').run(
      sceneJson,
      nextVersion,
      now,
      input.id,
    )
    db.prepare(INSERT_VERSION_SQL).run({
      id: randomUUID(),
      diagram_id: input.id,
      version: nextVersion,
      author: input.author,
      summary,
      scene: sceneJson,
      created_at: now,
    })
    // Retenção: mantém os MAX_SNAPSHOTS mais recentes.
    db.prepare('DELETE FROM diagram_versions WHERE diagram_id = ? AND version <= ?').run(
      input.id,
      nextVersion - MAX_SNAPSHOTS,
    )
  })
  tx()
  return get(input.id)!
}

export function rename(id: string, title: string): Diagram {
  const row = getRow(id)
  if (!row) throw new Error(`diagram not found: ${id}`)
  getDb()
    .prepare('UPDATE diagrams SET title = ?, updated_at = ? WHERE id = ?')
    .run(title.trim(), Date.now(), id)
  return get(id)!
}

// Só o preview: não versiona e não bumpa updated_at — thumbnail novo não é
// edição do diagrama, é derivado dela.
export function setThumbnail(id: string, dataUrl: string): void {
  getDb().prepare('UPDATE diagrams SET thumbnail = ? WHERE id = ?').run(dataUrl, id)
}

export function archive(id: string): Diagram {
  return setStatus(id, 'archived')
}

export function unarchive(id: string): Diagram {
  return setStatus(id, 'active')
}

function setStatus(id: string, status: DiagramStatus): Diagram {
  const row = getRow(id)
  if (!row) throw new Error(`diagram not found: ${id}`)
  getDb()
    .prepare('UPDATE diagrams SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id)
  return get(id)!
}

// `force` pula a exigência de arquivar antes: a UI confirma com o usuário e
// deleta direto (IPC usa force:true); o MCP mantém o two-step archive→delete
// (force:false) porque agente não recebe diálogo de confirmação.
export function remove(id: string, opts?: { force?: boolean }): void {
  const row = getRow(id)
  if (!row) throw new Error(`diagram not found: ${id}`)
  if (!opts?.force && row.status !== 'archived') {
    throw new Error(`diagram ${id} is not archived — archive it before deleting`)
  }
  // Versões e links saem por ON DELETE CASCADE (foreign_keys = ON em db.ts).
  getDb().prepare('DELETE FROM diagrams WHERE id = ?').run(id)
}

// ---- API pública: diagram_links ----

export function listLinks(diagramId: string): DiagramLink[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM diagram_links WHERE diagram_id = ? ORDER BY parent_type ASC, parent_id ASC',
    )
    .all(diagramId) as DiagramLinkRow[]
  return rows.map(rowToLink)
}

export function link(input: DiagramLink): DiagramLink[] {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO diagram_links (diagram_id, parent_type, parent_id)
       VALUES (?, ?, ?)`,
    )
    .run(input.diagramId, input.parentType, input.parentId)
  return listLinks(input.diagramId)
}

export function unlink(input: DiagramLink): DiagramLink[] {
  getDb()
    .prepare(
      'DELETE FROM diagram_links WHERE diagram_id = ? AND parent_type = ? AND parent_id = ?',
    )
    .run(input.diagramId, input.parentType, input.parentId)
  return listLinks(input.diagramId)
}

// ---- API pública: diagram_versions (o histórico) ----

export function listVersions(diagramId: string): DiagramVersionMeta[] {
  // Sem `scene` no SELECT: histórico é lista leve, snapshot vem por getVersion.
  const rows = getDb()
    .prepare(
      `SELECT id, diagram_id, version, author, summary, created_at, '' AS scene
       FROM diagram_versions WHERE diagram_id = ? ORDER BY version DESC`,
    )
    .all(diagramId) as DiagramVersionRow[]
  return rows.map(rowToVersionMeta)
}

export function getVersion(diagramId: string, version: number): DiagramVersion | null {
  const row = getDb()
    .prepare('SELECT * FROM diagram_versions WHERE diagram_id = ? AND version = ?')
    .get(diagramId, version) as DiagramVersionRow | undefined
  if (!row) return null
  return { ...rowToVersionMeta(row), scene: parseScene(row.scene) }
}

// Git-revert: copia o snapshot pra cabeça e grava versão NOVA apontando pra
// ela. Nunca apaga histórico — restaurar é um evento, não um rewind.
export function restoreVersion(diagramId: string, version: number, author: DiagramAuthor): Diagram {
  const row = getRow(diagramId)
  if (!row) throw new Error(`diagram not found: ${diagramId}`)
  const snapshot = getDb()
    .prepare('SELECT * FROM diagram_versions WHERE diagram_id = ? AND version = ?')
    .get(diagramId, version) as DiagramVersionRow | undefined
  if (!snapshot) throw new Error(`diagram version not found: ${diagramId} v${version}`)

  const now = Date.now()
  const nextVersion = row.version + 1
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare('UPDATE diagrams SET scene = ?, version = ?, updated_at = ? WHERE id = ?').run(
      snapshot.scene,
      nextVersion,
      now,
      diagramId,
    )
    db.prepare(INSERT_VERSION_SQL).run({
      id: randomUUID(),
      diagram_id: diagramId,
      version: nextVersion,
      author,
      summary: `restaura versão ${version}`,
      scene: snapshot.scene,
      created_at: now,
    })
  })
  tx()
  return get(diagramId)!
}
