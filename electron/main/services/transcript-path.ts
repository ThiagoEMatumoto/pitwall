import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Localização do transcript de uma sessão do Claude Code. Mora num módulo próprio
// — e não no session-activity, de onde saiu — porque session-activity importa o
// handoff-store (isActiveCrewChild) e o handoff-store passou a precisar deste
// gate: deixá-lo lá fecharia um ciclo de import, e ainda arrastaria electron +
// chokidar pra dentro de quem só quer saber se um .jsonl existe.
// session-activity re-exporta os dois símbolos, então os call sites antigos
// continuam válidos.

export const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')

// O JSONL nasce em ~/.claude/projects/<cwd-encoded>/<ccSessionId>.jsonl. Em vez de
// reproduzir o encoding do cwd, varremos os subdirs procurando o arquivo pelo id.
export function findTranscriptPath(ccSessionId: string): string | null {
  if (!existsSync(PROJECTS_ROOT)) return null
  const target = `${ccSessionId}.jsonl`
  let dirs: string[]
  try {
    dirs = readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const candidate = join(PROJECTS_ROOT, dir, target)
    if (existsSync(candidate)) return candidate
  }
  return null
}
