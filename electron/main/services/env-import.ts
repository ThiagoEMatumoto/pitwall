import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseDotenv } from '../../../shared/dotenv-parse'
import { SERVICE_REGISTRY, type ServiceId } from '../../../shared/service-registry'
import { readCustomEnv, setCustomEnvVar, type CustomEnvVars } from './custom-env'
import { SECRET_MASK } from './secret-store'

// Importador de .env: varre ~/projetos (e ~/.config/voz/voz.env) atrás de
// credenciais que o usuário já tem espalhadas e as compara com o cofre
// (custom-env). O VALOR nunca sai deste módulo em direção ao renderer: o scan
// devolve só um fingerprint (máscara + últimos 4 chars + tamanho) e o apply
// RELÊ o arquivo escolhido na hora de gravar via setCustomEnvVar.

const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', '.claude'])
const MAX_DEPTH = 5
const ENV_FILE = /^\.env(\..+)?$/

interface StatLike {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

// Dependências injetáveis (padrão VoiceDeps: teste sem fs/banco reais).
export interface EnvImportDeps {
  home: string
  listDir: (p: string) => string[]
  // lstat, nunca stat: symlink aparece como symlink e NÃO é seguido.
  lstat: (p: string) => StatLike | null
  readFile: (p: string) => string
  readCustomEnv: () => CustomEnvVars
  setEnvVar: (key: string, value: string) => { plaintext: string[] }
}

function withDefaults(over: Partial<EnvImportDeps>): EnvImportDeps {
  return {
    home: homedir(),
    listDir: (p) => readdirSync(p),
    lstat: (p) => lstatSync(p, { throwIfNoEntry: false }) ?? null,
    readFile: (p) => readFileSync(p, 'utf8'),
    readCustomEnv,
    setEnvVar: setCustomEnvVar,
    ...over,
  }
}

function isEnvFile(name: string): boolean {
  if (!ENV_FILE.test(name)) return false
  return !name.endsWith('.example') && !name.endsWith('.template')
}

function collectEnvFiles(root: string, d: EnvImportDeps): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    let names: string[]
    try {
      names = [...d.listDir(dir)].sort()
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      const st = d.lstat(path)
      if (!st || st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name) && depth < MAX_DEPTH) walk(path, depth + 1)
      } else if (st.isFile() && isEnvFile(name)) {
        found.push(path)
      }
    }
  }
  walk(root, 0)
  return found
}

// Máscara + últimos 4 chars + tamanho: suficiente pra distinguir fontes em
// conflito sem expor o segredo.
export function secretFingerprint(value: string): string {
  return `${SECRET_MASK}${value.slice(-4)} (${value.length})`
}

export interface EnvSourceRef {
  path: string
  fingerprint: string
}

export interface ImportCandidate {
  key: string
  canonical?: string
  serviceId?: ServiceId
  sources: EnvSourceRef[]
  // 'same' = cofre já tem exatamente este valor; 'conflict' = fontes divergem
  // entre si ou do cofre.
  status: 'new' | 'same' | 'conflict'
}

function registryMatch(key: string): { serviceId: ServiceId; canonical: string } | undefined {
  for (const service of SERVICE_REGISTRY) {
    for (const varDef of service.vars) {
      if (varDef.canonical === key || varDef.aliases.includes(key)) {
        return { serviceId: service.id, canonical: varDef.canonical }
      }
    }
  }
  return undefined
}

function candidateStatus(
  values: string[],
  vaultValue: string | undefined,
): ImportCandidate['status'] {
  const distinct = new Set(values)
  if (vaultValue) return distinct.size === 1 && distinct.has(vaultValue) ? 'same' : 'conflict'
  return distinct.size === 1 ? 'new' : 'conflict'
}

export function scanEnvSources(deps: Partial<EnvImportDeps> = {}): ImportCandidate[] {
  const d = withDefaults(deps)
  const files = collectEnvFiles(join(d.home, 'projetos'), d)

  const vozEnv = join(d.home, '.config', 'voz', 'voz.env')
  const vozStat = d.lstat(vozEnv)
  if (vozStat?.isFile() && !vozStat.isSymbolicLink()) files.push(vozEnv)

  // Ocorrências por chave; o valor fica confinado aqui e vira fingerprint.
  const byKey = new Map<string, { path: string; value: string }[]>()
  for (const path of files) {
    let vars: Record<string, string>
    try {
      vars = parseDotenv(d.readFile(path))
    } catch {
      continue
    }
    for (const [key, value] of Object.entries(vars)) {
      const list = byKey.get(key) ?? []
      byKey.set(key, [...list, { path, value }])
    }
  }

  const vault = d.readCustomEnv()
  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, occurrences]) => {
      const match = registryMatch(key)
      return {
        key,
        ...(match ?? {}),
        sources: occurrences.map(({ path, value }) => ({
          path,
          fingerprint: secretFingerprint(value),
        })),
        status: candidateStatus(
          occurrences.map((o) => o.value),
          vault[key] || undefined,
        ),
      }
    })
}

export interface ImportSelection {
  key: string
  sourcePath: string
}

export interface ApplyImportResult {
  applied: string[]
  // Chaves que não existiam (mais) no arquivo escolhido no momento do apply.
  missing: string[]
  // Chaves gravadas em claro (cofre indisponível) — a UI avisa.
  plaintext: string[]
}

export function applyImport(
  selections: ImportSelection[],
  deps: Partial<EnvImportDeps> = {},
): ApplyImportResult {
  const d = withDefaults(deps)
  const applied: string[] = []
  const missing: string[] = []
  const plaintext = new Set<string>()
  const parsedByPath = new Map<string, Record<string, string>>()

  for (const { key, sourcePath } of selections) {
    let vars = parsedByPath.get(sourcePath)
    if (!vars) {
      try {
        vars = parseDotenv(d.readFile(sourcePath))
      } catch {
        vars = {}
      }
      parsedByPath.set(sourcePath, vars)
    }
    const value = vars[key]
    if (value === undefined) {
      missing.push(key)
      continue
    }
    for (const k of d.setEnvVar(key, value).plaintext) plaintext.add(k)
    applied.push(key)
  }
  return { applied, missing, plaintext: [...plaintext].sort() }
}
