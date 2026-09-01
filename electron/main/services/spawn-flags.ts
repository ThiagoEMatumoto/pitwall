// Whitelists e resolução das flags de spawn do claude — módulo PURO (sem electron,
// sem I/O). Fonte ÚNICA do spawn interativo (ipc/sessions, via PTY) e das
// sessões-filhas de handoff. Concentrar aqui garante que o denylist destrutivo
// (guard-rail de modo autônomo) NÃO drife entre os caminhos de spawn.

import { SPAWNABLE_MODEL_ALIASES } from '../../../shared/models'

// Whitelist do --model: o valor vem do renderer/preset, mas o main re-valida —
// nada fora desta lista chega à linha de comando. Deriva do registro canônico
// (shared/models.ts), que só contém aliases literais ('opusplan' é o alias
// híbrido nativo da CLI: Opus no plan mode, Sonnet na execução).
export const SPAWN_MODEL_WHITELIST = new Set<string>(SPAWNABLE_MODEL_ALIASES)

// Modo do handoff → --permission-mode da filha. 'interactive' fica sem flag
// (legado: o claude pergunta cada ação). Espelha permissionModeFor do renderer
// (src/store/handoffsStore.ts) — o main é quem decide quando o spawn parte da MCP.
export function permissionModeForHandoffMode(mode: string | null | undefined): string | null {
  switch (mode) {
    case 'plan':
      return 'plan'
    case 'auto-edits':
      return 'acceptEdits'
    default:
      return null
  }
}

// Whitelist do --effort: espelha a defesa-em-profundidade do --model.
export const SPAWN_EFFORT_WHITELIST = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

// Whitelist do --advisor: feature experimental (só Anthropic API direta). Se o CLI
// rejeitar em runtime, a sessão falha visível — mesmo tratamento de outras flags.
export const SPAWN_ADVISOR_WHITELIST = new Set(['opus', 'sonnet', 'fable'])

// Whitelist do --permission-mode: TODOS os choices da CLI claude. O main é a
// autoridade — valor fora desta lista vira null (= sem flag = default do claude).
export const SPAWN_PERMISSION_MODES = [
  'default',
  'plan',
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'dontAsk',
] as const
const SPAWN_PERMISSION_MODE_WHITELIST = new Set<string>(SPAWN_PERMISSION_MODES)

// Modos autônomos (editam/agem sem confirmar cada ação) que recebem o denylist
// destrutivo como guard-rail. plan é read-only e default pergunta tudo.
const AUTONOMOUS_PERMISSION_MODES = new Set<string>(['acceptEdits', 'auto', 'bypassPermissions'])

// Denylist destrutivo canônico (defense-in-depth) aplicado SEMPRE que a sessão
// sobe em modo autônomo. Bloqueia as ops irreversíveis das regras do usuário.
export const DESTRUCTIVE_DENYLIST = [
  'Bash(rm:*)',
  'Bash(git push:*)',
  'Bash(git reset --hard:*)',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git clean:*)',
]

// ─────────────────────────────────────────────────────────────────────────────
// Política de permissões da sessão-filha de handoff
// ─────────────────────────────────────────────────────────────────────────────
// Problema: a filha nasce em `acceptEdits`, que auto-aceita EDIÇÃO DE ARQUIVO
// mas não comando de shell — então `git`, `npm`, `rg` param a filha pedindo
// confirmação a cada chamada e o usuário vira o gargalo da própria delegação.
//
// Regra do dono do produto, literal:
//   PODE sem perguntar: pesquisa/leitura, MCPs, e leitura em GCP/AWS.
//   NÃO PODE: merge, escrita em banco de dados, delete.
//   Resto: leitura/inspeção libera; escrita, publicação e destruição perguntam.
//         Na dúvida, perguntar.
//
// Listas EXPLÍCITAS de propósito: isto é política de segurança e precisa ser
// legível/auditável por humano — nada de derivar dinamicamente.
//
// Sintaxe verificada empiricamente contra claude 2.1.227 (`claude -p` headless,
// comparando com/sem `--settings`):
//   - `permissions.{allow,ask,deny}` inline via `--settings` SÃO honrados;
//   - precedência: deny > ask > allow (`ask` bloqueia mesmo o que `allow` libera);
//   - `Bash(cmd:*)` (prefixo) e `Bash(cmd * sufixo*)` (glob no meio) funcionam;
//   - MCP só casa por servidor (`mcp__pitwall`) ou `mcp__servidor__*`.
//     `mcp__*` e `mcp__*__*` NÃO funcionam (testados: continuam pedindo). Por
//     isso o allow cobre só o servidor que ESTE app injeta via --mcp-config;
//     MCPs de terceiros continuam governados pela settings global do usuário.

// Leitura/inspeção do filesystem — o núcleo do "pesquisa/leitura" da regra.
const CHILD_ALLOW_READ_TOOLS = [
  'Bash(rg:*)',
  'Bash(grep:*)',
  'Bash(fd:*)',
  'Bash(find:*)',
  'Bash(ls:*)',
  'Bash(tree:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(sort:*)',
  'Bash(uniq:*)',
  'Bash(diff:*)',
  'Bash(jq:*)',
  'Bash(stat:*)',
  'Bash(file:*)',
  'Bash(du:*)',
  'Bash(df:*)',
  'Bash(which:*)',
  'Bash(ps:*)',
  'Bash(pwd)',
  'Bash(echo:*)',
  'Bash(realpath:*)',
  'Bash(basename:*)',
  'Bash(dirname:*)',
  'Bash(printenv:*)',
]

// git de LEITURA. Nada que reescreva histórico ou publique — merge/rebase caem
// no ask e push/reset --hard/clean no deny. `fetch` entra porque só atualiza
// refs remotas (não mexe em working tree) e é pré-requisito de qualquer
// diagnóstico honesto de "estou atrás da main?".
const CHILD_ALLOW_GIT_READ = [
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  'Bash(git blame:*)',
  'Bash(git branch:*)',
  'Bash(git rev-parse:*)',
  'Bash(git ls-files:*)',
  'Bash(git ls-remote:*)',
  'Bash(git describe:*)',
  'Bash(git shortlog:*)',
  'Bash(git grep:*)',
  'Bash(git remote -v)',
  'Bash(git remote get-url:*)',
  'Bash(git worktree list:*)',
  'Bash(git stash list:*)',
  'Bash(git fetch:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr list:*)',
  'Bash(gh pr diff:*)',
  'Bash(gh pr checks:*)',
  'Bash(gh issue view:*)',
  'Bash(gh issue list:*)',
  'Bash(gh run view:*)',
  'Bash(gh run list:*)',
  'Bash(gh repo view:*)',
  'Bash(gh search:*)',
]

// Inspeção de projeto: typecheck/lint/teste não escrevem nem publicam nada e
// são justamente o que a filha precisa rodar pra provar que o trabalho está de
// pé. `install`/`publish`/`deploy` ficam de fora (rede + escrita + publicação).
const CHILD_ALLOW_PROJECT_INSPECTION = [
  'Bash(npm run typecheck:*)',
  'Bash(npm run lint:*)',
  'Bash(npm run test:*)',
  'Bash(npm test:*)',
  'Bash(npm ls:*)',
  'Bash(npm view:*)',
  'Bash(pnpm typecheck:*)',
  'Bash(pnpm lint:*)',
  'Bash(pnpm test:*)',
  'Bash(bun run typecheck:*)',
  'Bash(bun run lint:*)',
  'Bash(bun test:*)',
  'Bash(npx tsc --noEmit:*)',
  'Bash(pytest:*)',
  'Bash(ruff check:*)',
  'Bash(cargo check:*)',
  'Bash(cargo test:*)',
  'Bash(go test:*)',
  'Bash(go vet:*)',
]

// Leitura em cloud (GCP/AWS/Terraform). Só verbos de inspeção — `describe`,
// `list`, `get-*`, `logging read`, `plan`. Escrita/IAM/delete não aparecem aqui
// e ainda levam deny explícito abaixo. `bq query` fica fora de propósito: DML
// em BigQuery é escrita em banco, e "na dúvida, perguntar".
const CHILD_ALLOW_CLOUD_READ = [
  'Bash(gcloud * list*)',
  'Bash(gcloud * describe*)',
  'Bash(gcloud * get-*)',
  'Bash(gcloud config get*)',
  'Bash(gcloud config list*)',
  'Bash(gcloud auth list*)',
  'Bash(gcloud logging read*)',
  'Bash(bq ls*)',
  'Bash(bq show*)',
  'Bash(bq head*)',
  'Bash(aws * describe-*)',
  'Bash(aws * list-*)',
  'Bash(aws * get-*)',
  'Bash(aws sts get-caller-identity*)',
  'Bash(aws s3 ls*)',
  'Bash(aws logs tail*)',
  'Bash(terraform plan*)',
  'Bash(terraform show*)',
  'Bash(terraform validate*)',
  'Bash(terraform output*)',
  'Bash(terraform state list*)',
  'Bash(terraform state show*)',
]

// MCP: "todas as tools MCP" na intenção da regra. Na prática o CLI não aceita
// curinga entre servidores (ver bloco de sintaxe acima), então liberamos o
// servidor que este app injeta — o mesmo que carrega progresso/report do
// handoff, e o que mais interrompia a filha.
const CHILD_ALLOW_MCP = ['mcp__pitwall']

export const HANDOFF_CHILD_ALLOW = [
  ...CHILD_ALLOW_READ_TOOLS,
  ...CHILD_ALLOW_GIT_READ,
  ...CHILD_ALLOW_PROJECT_INSPECTION,
  ...CHILD_ALLOW_CLOUD_READ,
  ...CHILD_ALLOW_MCP,
]

// `ask` = continua pedindo confirmação (é o "NÃO PODE" reversível da regra: o
// humano ainda pode autorizar na hora). Merge e escrita em banco entram aqui;
// destruição irreversível vai pro deny. `ask` também é a rede de segurança
// contra um allow largo demais — ele tem precedência sobre o allow.
export const HANDOFF_CHILD_ASK = [
  // merge / reescrita de histórico
  'Bash(git merge:*)',
  'Bash(git rebase:*)',
  'Bash(git cherry-pick:*)',
  'Bash(git revert:*)',
  'Bash(gh pr merge:*)',
  // escrita em banco de dados (cliente interativo = INSERT/UPDATE/DELETE/DDL)
  'Bash(psql:*)',
  'Bash(mysql:*)',
  'Bash(sqlite3:*)',
  'Bash(mongosh:*)',
  'Bash(redis-cli:*)',
  'Bash(bq query:*)',
  // migrations
  'Bash(npx prisma migrate:*)',
  'Bash(npm run migrate:*)',
  'Bash(alembic:*)',
  'Bash(rails db:*)',
  // publicação
  'Bash(npm publish:*)',
  'Bash(gh release create:*)',
]

// `deny` = bloqueado, nem pergunta. Mescla o DESTRUCTIVE_DENYLIST canônico —
// SEGUNDA camada, não substituição: ele continua indo pro `--disallowedTools`
// em modo autônomo (ver resolveDisallowedTools). Reusar a constante garante que
// as duas camadas não drifem. Extras: o delete que a regra proíbe, o buraco do
// `find` (que é allow mas sabe deletar/executar) e escalonamento de IAM.
export const HANDOFF_CHILD_DENY = [
  ...DESTRUCTIVE_DENYLIST,
  'Bash(rmdir:*)',
  'Bash(shred:*)',
  'Bash(find * -delete*)',
  'Bash(find * -exec*)',
  'Bash(gcloud * delete*)',
  'Bash(aws * delete-*)',
  'Bash(bq rm*)',
  'Bash(terraform destroy*)',
  'Bash(gcloud * add-iam-policy-binding*)',
  'Bash(gcloud * set-iam-policy*)',
  'Bash(gcloud * --impersonate-service-account*)',
]

// Settings entregues via `--settings <json-inline>` a CADA sessão-filha de
// handoff — NUNCA global. `crossSessionInbound: accept` deixa a filha RECEBER
// SendMessage do orquestrador; sem isso a mensagem fica `held` silenciosamente e
// o canal peer parece funcionar sem funcionar. Global afetaria todas as sessões
// do usuário, inclusive as que ele não quer expostas — e o mesmo vale pra
// política de permissões acima: ela vale pra filha, não pro usuário.
export const HANDOFF_CHILD_SETTINGS_JSON = JSON.stringify({
  crossSessionInbound: 'accept',
  permissions: {
    allow: HANDOFF_CHILD_ALLOW,
    ask: HANDOFF_CHILD_ASK,
    deny: HANDOFF_CHILD_DENY,
  },
})

// Valida o modo de permissão contra a whitelist. Retorna o modo se válido, senão
// null (= sem flag = default do claude).
export function resolvePermissionMode(value: string | null | undefined): string | null {
  return value && SPAWN_PERMISSION_MODE_WHITELIST.has(value) ? value : null
}

// Monta o denylist final do spawn. Mescla o denylist destrutivo canônico quando o
// modo é autônomo (o renderer não pode enfraquecê-lo); senão devolve só o
// denylist do renderer (ou null se vazio). Filtra specs não-string/vazios.
export function resolveDisallowedTools(
  permissionMode: string | null,
  rendererDeny: readonly unknown[] | null | undefined,
): string[] | null {
  const deny = (rendererDeny ?? []).filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  )
  if (permissionMode && AUTONOMOUS_PERMISSION_MODES.has(permissionMode)) {
    return Array.from(new Set([...deny, ...DESTRUCTIVE_DENYLIST]))
  }
  return deny.length > 0 ? deny : null
}

// Valida o --model contra a whitelist. Retorna o valor ou null (= sem flag).
export function resolveModel(value: string | null | undefined): string | null {
  return value && SPAWN_MODEL_WHITELIST.has(value) ? value : null
}

// Valida o --effort contra a whitelist. Retorna o valor ou null (= sem flag).
export function resolveEffort(value: string | null | undefined): string | null {
  return value && SPAWN_EFFORT_WHITELIST.has(value) ? value : null
}

// Valida o --advisor contra a whitelist. Retorna o valor ou null (= sem flag).
export function resolveAdvisor(value: string | null | undefined): string | null {
  return value && SPAWN_ADVISOR_WHITELIST.has(value) ? value : null
}
