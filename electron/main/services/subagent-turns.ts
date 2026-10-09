import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripUnsafeDisplay } from '../../../shared/tui/permission-request'
import { parseSubagentTurns, type SubagentInfo } from './chat-transcript'

// Turns de subagente vivem em arquivos aninhados:
//   <dir>/<sessionId>/subagents/agent-*.jsonl
// Cada linha `type==='assistant'` é um turn de subagente (todas têm
// isSidechain:true). Conta linhas assistant em todos os arquivos da pasta.
// Degrada para 0 quando a pasta não existe — não quebra o scan.
export function countSubagentTurns(dir: string, sessionId: string): number {
  const subDir = join(dir, sessionId, 'subagents')
  if (!existsSync(subDir)) return 0

  let files: string[]
  try {
    files = readdirSync(subDir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return 0
  }

  let count = 0
  for (const file of files) {
    let content: string
    try {
      content = readFileSync(join(subDir, file), 'utf8')
    } catch {
      continue // arquivo ilegível — pula.
    }
    for (const raw of content.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      try {
        const obj = JSON.parse(line) as { type?: string }
        if (obj.type === 'assistant') count += 1
      } catch {
        // linha inválida ou parcial — ignora.
      }
    }
  }
  return count
}

// Meta de um subagente: agent-<hash>.meta.json = { agentType, description, toolUseId }.
// toolUseId casa com o id do tool_use Task/Agent no JSONL principal — é a chave da
// associação. agentType é o nome exibível (ex.: 'Explore', 'general-purpose').
interface SubagentMeta {
  agentType?: string
  description?: string
  toolUseId?: string
}

export interface SubagentMetaInfo {
  toolUseId: string
  name: string
  description: string
}

// Versão LEVE de readSubagentInfos: lê SÓ os agent-*.meta.json (~100B cada), sem
// parsear os .jsonl. Pro session-activity derivar o estado dos subagentes a cada
// broadcast sem custo — o estado vem do tail do transcript principal, não dos
// turnos. Degrada pra lista vazia quando a pasta não existe.
export function readSubagentMetas(dir: string, sessionId: string): SubagentMetaInfo[] {
  const out: SubagentMetaInfo[] = []
  const subDir = join(dir, sessionId, 'subagents')
  if (!existsSync(subDir)) return out

  let files: string[]
  try {
    files = readdirSync(subDir).filter((f) => f.endsWith('.meta.json'))
  } catch {
    return out
  }

  for (const metaFile of files) {
    let meta: SubagentMeta
    try {
      meta = JSON.parse(readFileSync(join(subDir, metaFile), 'utf8')) as SubagentMeta
    } catch {
      continue // meta ilegível/malformada — pula este subagente.
    }
    if (!meta.toolUseId) continue
    out.push({
      toolUseId: meta.toolUseId,
      name: meta.agentType ?? 'subagente',
      description: meta.description ?? '',
    })
  }
  return out
}

// Um subagente indexado pelo toolUseId: nome/descrição vêm do meta, os turnos do
// .jsonl irmão, que só é lido quando alguém pede (readSubagentTurns).
export interface SubagentRef {
  name: string
  description: string
  jsonlPath: string
}

// Caches do processo main. As mães acumulam centenas de subagentes (medido: 286
// arquivos / 296MB numa sessão real), e reler + parsear todos os .jsonl a cada
// emit travava o event loop por ~1s.
// Metas: o meta.json nasce com a associação e não muda; arquivo novo muda o mtime
// da pasta. Então a pasta só é relistada quando o mtime dela muda, e só os metas
// nunca vistos são lidos. Meta ilegível (ainda sendo escrito) não entra no cache e
// força uma relistagem no próximo emit.
const metaIndexCache = new Map<
  string,
  {
    dirMtimeMs: number
    byFile: Map<string, { toolUseId: string; ref: SubagentRef }>
  }
>()

// Turnos por (path, mtime, size): o .jsonl é append-only, e entre dois emits só
// muda o do subagente que está rodando. Teto pra não reter turnos de toda sessão
// já aberta.
const TURNS_CACHE_MAX = 512
const turnsCache = new Map<
  string,
  {
    mtimeMs: number
    size: number
    value: { turnCount: number; turns: string[] }
  }
>()

export function readSubagentIndex(dir: string, sessionId: string): Map<string, SubagentRef> {
  const out = new Map<string, SubagentRef>()
  const subDir = join(dir, sessionId, 'subagents')
  let dirMtimeMs: number
  try {
    dirMtimeMs = statSync(subDir).mtimeMs
  } catch {
    return out // pasta não existe: sessão sem subagentes.
  }

  let cached = metaIndexCache.get(subDir)
  if (!cached || cached.dirMtimeMs !== dirMtimeMs) {
    let files: string[]
    try {
      files = readdirSync(subDir).filter((f) => f.endsWith('.meta.json'))
    } catch {
      return out
    }
    const byFile = new Map<string, { toolUseId: string; ref: SubagentRef }>()
    let complete = true
    for (const metaFile of files) {
      const seen = cached?.byFile.get(metaFile)
      if (seen) {
        byFile.set(metaFile, seen)
        continue
      }
      let meta: SubagentMeta
      try {
        meta = JSON.parse(readFileSync(join(subDir, metaFile), 'utf8')) as SubagentMeta
      } catch {
        complete = false // meta ilegível/parcial: pula agora, relê no próximo emit.
        continue
      }
      if (!meta.toolUseId) continue
      byFile.set(metaFile, {
        toolUseId: meta.toolUseId,
        ref: {
          name: stripUnsafeDisplay(meta.agentType ?? 'subagente'),
          description: stripUnsafeDisplay(meta.description ?? ''),
          jsonlPath: join(subDir, metaFile.replace(/\.meta\.json$/, '.jsonl')),
        },
      })
    }
    cached = { dirMtimeMs: complete ? dirMtimeMs : NaN, byFile }
    metaIndexCache.set(subDir, cached)
  }

  for (const { toolUseId, ref } of cached.byFile.values()) out.set(toolUseId, ref)
  return out
}

// Turnos de um subagente, relidos só quando o .jsonl mudou. Sem o .jsonl ainda
// (subagente recém-disparado): 0 turnos.
export function readSubagentTurns(jsonlPath: string): {
  turnCount: number
  turns: string[]
} {
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(jsonlPath)
  } catch {
    return { turnCount: 0, turns: [] }
  }
  const hit = turnsCache.get(jsonlPath)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value
  let value: { turnCount: number; turns: string[] }
  try {
    value = parseSubagentTurns(readFileSync(jsonlPath, 'utf8'))
  } catch {
    return { turnCount: 0, turns: [] }
  }
  turnsCache.delete(jsonlPath)
  turnsCache.set(jsonlPath, { mtimeMs: st.mtimeMs, size: st.size, value })
  if (turnsCache.size > TURNS_CACHE_MAX) {
    const oldest = turnsCache.keys().next().value
    if (oldest !== undefined) turnsCache.delete(oldest)
  }
  return value
}

// Lê os subagentes de uma sessão e indexa por toolUseId, pro parser do chat trocar
// o tool_use genérico pelo card de subagente. Cada subagente são dois arquivos
// irmãos na pasta subagents/: agent-<hash>.meta.json (associação + nome) e
// agent-<hash>.jsonl (os turnos). Degrada pra mapa vazio quando a pasta não existe
// e pula silenciosamente arquivos ilegíveis/malformados. É o caminho do chat
// completo, que mostra todos os cards; com os caches acima, cada emit relê só os
// .jsonl que mudaram (um stat por subagente, nenhuma leitura dos parados).
export function readSubagentInfos(dir: string, sessionId: string): Map<string, SubagentInfo> {
  const out = new Map<string, SubagentInfo>()
  for (const [toolUseId, ref] of readSubagentIndex(dir, sessionId)) {
    out.set(toolUseId, {
      name: ref.name,
      description: ref.description,
      ...readSubagentTurns(ref.jsonlPath),
    })
  }
  return out
}

export function clearSubagentCachesForTest(): void {
  metaIndexCache.clear()
  turnsCache.clear()
}
