<div align="center">

# Pitwall

**Um cockpit desktop para rodar e supervisionar várias sessões do [Claude Code](https://claude.com/claude-code) nos seus projetos e repositórios.**

[English](./README.md) · Português (BR)

[![Release](https://img.shields.io/github/v/release/ThiagoEMatumoto/pitwall?sort=semver)](https://github.com/ThiagoEMatumoto/pitwall/releases/latest)
[![Plataformas](https://img.shields.io/badge/plataformas-macOS%20%7C%20Windows%20%7C%20Linux-blue)](https://github.com/ThiagoEMatumoto/pitwall/releases/latest)
[![Licença: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Feito com Electron](https://img.shields.io/badge/feito%20com-Electron%20%2B%20React-47848F)](https://www.electronjs.org/)

<br/>

<video src="docs/assets/promo-pt-BR.mp4" controls muted width="900"></video>

<sub><a href="docs/assets/promo-pt-BR.mp4">Assistir ao vídeo de apresentação</a></sub>

</div>

---

O Claude Code é um agente de terminal. O **Pitwall** o embrulha num app desktop para você dirigir vários agentes ao mesmo tempo — cada um no seu projeto e repositório — sem malabarismo de abas de terminal. Ele mantém um banco SQLite local dos seus projetos, sessões, planos e repositórios, renderiza cada sessão como terminal ao vivo ou como chat estruturado, e conecta repositórios relacionados para que uma sessão num repo delegue trabalho a uma sessão em outro.

O nome vem do pit wall da Fórmula 1: você não está dirigindo o carro, está no rádio com vários pilotos ao mesmo tempo.

> **Status:** em desenvolvimento ativo, com releases versionadas para macOS, Windows e Linux. Algumas features estão marcadas como _experimental_ abaixo.

## Voz: ditar o prompt, ouvir a resposta

O ponto do modo voz é o que ele **não** faz: o ditado nunca envia nada. A transcrição cai no composer para você ler, editar e enviar.

- **Ditado.** O botão de microfone grava no renderer (`getUserMedia` + `MediaRecorder`, webm/opus) e manda o áudio para um endpoint compatível com a API da OpenAI (`/v1/audio/transcriptions`). Endereço, chave, modelo, idioma e o mínimo de duração vêm de `~/.config/voz/voz.env` — nada está preso a um fornecedor no código. Gravação mais curta que o mínimo é descartada em vez de transcrita.
- **Ditado longo é condensado, não reescrito.** Transcrição de fala carrega hesitação, falso começo e termo técnico errado ("abrir com request" era "abrir pull request"). Ditados longos passam por `claude -p` com `haiku` (tools desligadas — o que foi falado NUNCA pode disparar ação) antes de chegar ao composer. Duas travas: a passagem é fail-open, então uma falha devolve o ditado cru em vez de perdê-lo, e uma volta maior que 1,2× o original é sinal de que o modelo explicou em vez de condensar, e é descartada.
- **Resumo falado do turno.** Quando a sessão cruza a borda `working → waiting/idle`, o Pitwall lê o último turno do assistente no transcript e o transforma em 2-3 frases faladas (também `haiku`), sintetizadas pela ElevenLabs. Só dispara nas sessões em que você ligou, uma a uma — opt-in por sessão, porque o custo é por turno. Prompt de permissão não é fim de turno e não resume. Há também um botão de resumir sob demanda, que ignora o gate porque a ação é explícita.

## Diagramas: um canvas Excalidraw que o agente edita

Os diagramas são um canvas [Excalidraw](https://excalidraw.com) de verdade, editável à mão. O agente escreve nele por MCP tools, em vez de produzir uma imagem.

- **`diagram_create`** recebe um _esqueleto_: nós e setas semânticos, ids no lugar de coordenadas. Omita `x`/`y` e o conversor faz o auto-layout; as setas referenciam ids de nós por `start`/`end` e aceitam rótulo. Cena Excalidraw crua também é aceita, mas o esqueleto é a entrada preferida.
- **`diagram_patch` é o motivo de isso funcionar.** Ele aplica ops incrementais (`add | update | delete`, endereçando elementos pelo id do esqueleto) **sobre a cena ATUAL**, então a caixa que você arrastou e a cor que você trocou sobrevivem à próxima edição do agente. `diagram_update` existe para o redesenho integral deliberado — e diz na cara que descarta o seu refinamento. Ambos gravam um snapshot de versão com uma linha de changelog.
- **`diagram_link`** prende o diagrama a um pai — projeto, repo, feature, task, objetivo, key result, sessão ou handoff — para ele aparecer naquele contexto. Apagar tem guarda de dois passos: só diagrama arquivado pode ser apagado, e só com `confirm`.
- Uma biblioteca global de formas é compartilhada por todos os canvas (`diagram_library_install` / `_list` / `_remove`).

## Sessões delegadas: o apelido é o endereço

Uma sessão pode subir outra sessão num repo conectado e conversar com ela enquanto o trabalho acontece.

- **`session_handoff`** sobe a filha na hora — sem diálogo de aprovação no meio. Você passa o repo em que está, o repo alvo e um modo: `plan` (a filha é read-only, para investigar), `auto-edits` (a filha edita arquivos sozinha, comandos destrutivos bloqueados) ou `interactive` (pergunta tudo). Esses modos mapeiam para o `--permission-mode` da CLI: `plan`, `acceptEdits` e nenhuma flag, respectivamente. Todo modo autônomo ainda recebe um denylist canônico de operações irreversíveis, como defesa em profundidade. Se o repo alvo já tem um handoff ativo, a chamada é recusada — a menos que você passe `force`.
- **A filha nasce com um apelido, e o apelido é o endereço dela.** Ele é o `-n <nome>` do spawn _e_ o `to` do cross-session messaging: `SendMessage({ to: "mauricio-auth-refactor" })`. O formato é `<nome>-<escopo>` — um nome humano tirado de um pool por papel (investigator / implementer / operator, derivado 1:1 do modo) mais um escopo vindo da task — porque, quando dois peers colidem no nome, a CLI desambigua com um hex ilegível.
- **A filha reporta por tools, não por prosa.** `handoff_progress` para um passo não-terminal, `handoff_ask` quando bate num bloqueio que ela não pode decidir sozinha (isso move o handoff para `needs_input`; perguntar de novo empilha na pergunta pendente em vez de derrubá-la), `handoff_report` só quando o trabalho está pronto _e_ verificado. A mãe lê `handoff_result`, que devolve o estado durável mais telemetria viva do PTY (`working | waiting | idle | ended`, tokens, última atividade) — é assim que se distingue progresso real de travamento.
- **O Crew Dock** é onde as filhas vivem: uma trilha de 40px cuja cor é o estado, com um dot por filha. Quando uma passa a esperar por você, o dot dela pulsa e o contador acende em âmbar dentro dos 40px, sem abrir painel por cima do seu terminal. `Ctrl+J` entra, as setas andam, Espaço/Enter espia no lugar, Esc devolve o foco para onde ele estava.

## Vendo rodar

Estes clipes mostram telas reais com dataset fictício.

<img src="docs/assets/demo.gif" alt="Pitwall — grafo de arquitetura, orquestração multi-repo e quadros de planejamento" width="900" />

<sub>Grafos de dependência entre repositórios, orquestração multi-repo e quadros de planejamento. <a href="docs/assets/demo.mp4">Versão em MP4</a>.</sub>

<img src="docs/assets/architecture.png" alt="Grafo global de arquitetura multi-repo" width="900" />

<img src="docs/assets/features.png" alt="Quadro de planejamento de features" width="900" />

## O resto

**Sessões.** Várias sessões do Claude Code simultâneas sobre um PTY real (`node-pty`), cada uma atada a um projeto/repo. Duas visões por sessão, alternáveis: o terminal completo (xterm.js com WebGL, fit, busca, web-links e clipboard) ou um chat nativo que renderiza o transcript como balões, cards de plano, chamadas de tool, blocos de raciocínio, cards de subagente e cards de pergunta interativa. O composer escolhe modelo, esforço de raciocínio (incluindo `ultracode` nos modelos que suportam) e modo de permissão sem digitar slash command, cola imagem e mostra o indicador de contexto ao vivo.

**Projetos, repos e sync entre máquinas.** Repositórios são agrupados em projetos sob uma raiz "vault", com detecção das pastas que você ainda não registrou. O estado do app é serializado num bundle Git e empurrado/puxado automaticamente, reusando o credential helper do `gh` — sem token em disco. Repo registrado numa máquina é clonado nas outras. O pull-all roda `git pull --ff-only` em todos os repos, pulando os sujos ou divergidos, com auto-pull periódico opcional.

**Quadros de planejamento por MCP.** Objetivos → key results, tasks e features em SQLite local, todos expostos como MCP tools para o agente manter tudo atualizado enquanto trabalha, mais um grafo de arquitetura das dependências entre repos (`@xyflow/react`) injetado no system prompt de cada sessão.

**Env Hub e o registry de serviços.** Serviços de terceiros são declarados num registry (LiteLLM, Gemini, LegalCore, LaaS, ElevenLabs, Tavily); a sessão chama `service_list` / `service_call` com `{service, operation, params}` e o main injeta a credencial e faz o fetch. A URL vem só do registry — nunca de `params` — e os params são validados contra um schema estrito antes de qualquer uso, então a chave nunca entra no contexto do agente. Os segredos ficam cifrados em repouso pelo `safeStorage` do Electron; quando o keyring do SO não está disponível, a UI diz isso em vez de fingir segurança. Um importador lê `.env` existentes, e toda chamada é auditada.

**Jobs agendados.** Execuções headless do `claude` em horário, com catch-up dos vencidos e claim atômico para um poll duplo não disparar duas vezes. Restritos aos modos observe-only (`default`, `plan`) por allowlist explícito — execução sem supervisão não ganha modo autônomo. Expostos como `scheduled_job_*`, `job_report` e `job_run_list`.

**Contratos de conteúdo e gates.** Um contrato versionado (público, tom, fatos permitidos e proibidos, escopo, limites de entrega, regras éticas) com seis portões executáveis: `tone-lint`, `forbidden-facts`, `scope`, `scope-checklist`, `delivery-limit` e `positive-evidence`. Gate que não consegue rodar reporta `error`, nunca `passed`.

**Bastão.** Quando o contexto de uma sessão enche, ela destila o próprio transcript num briefing para a sucessora — o estado agora, o porquê das decisões (senão a sucessora as refaz) e o próximo passo concreto.

**Ingest e dossiês _(experimental)_.** Um pipeline de pesquisa em etapas, com gates de aprovação humana e checkpoints, alimentado por um provedor de fontes Tavily com classificação de fonte.

**Reuniões.** Gravação e transcrição ao vivo de chamadas sem sair da mesa: inicie pela área Reuniões, pela bandeja ou por `Ctrl+Shift+R`, e uma janela flutuante sempre no topo mostra o timer, os níveis de áudio e as últimas falas enquanto você faz anotações rápidas. Áudio do sistema e microfone são capturados pelo PipeWire (`pw-record`) e transcritos em chunks pelo mesmo endpoint STT compatível com OpenAI do modo voz (`~/.config/voz/voz.env`). Ao parar, o `claude -p` escreve o resumo (decisões, próximos passos, perguntas em aberto, suas anotações incorporadas) e extrai itens de ação — cada um ancorado numa citação literal do transcript antes de virar task. Exposto aos agentes como tools MCP `meeting_*`.

**Configuração do Claude Code.** Ler e editar `CLAUDE.md`, rules, settings da CLI, hooks, keybindings, servidores MCP, plugins/marketplace e o script de statusline pelo app.

**Métricas de uso.** Um dashboard local construído a partir dos seus transcripts JSONL do Claude Code: consumo de tokens e custo, tools mais usadas e um KPI de orquestração de agentes.

**Video Lab _(em desenvolvimento)_.** Um projeto Remotion para produzir os vídeos do produto. Vive numa branch e ainda não faz parte de uma release.

## Instalação

Baixe o app pronto na [última release](https://github.com/ThiagoEMatumoto/pitwall/releases/latest):

| Plataforma | Artefato                         |
| ---------- | -------------------------------- |
| macOS      | `.dmg` (Apple Silicon) ou `.zip` |
| Windows    | `Pitwall-Setup-*.exe` (NSIS)     |
| Linux      | `.AppImage` ou `.deb`            |

O app se atualiza sozinho via `electron-updater`.

> O Pitwall dirige a CLI do Claude Code, então você quer o [Claude Code](https://claude.com/claude-code) instalado e autenticado na máquina.

## Desenvolvimento

Requisitos: **Node 20+**.

```bash
npm install
npm run dev      # electron-vite dev com HMR
```

`npm run dev` é o único comando necessário para iterar. Mudanças no renderer (React) recarregam em segundos. Mudanças no processo main (`electron/main/**`) ou no preload (`electron/preload/**`) exigem reiniciar o `npm run dev`.

Outros scripts:

```bash
npm run typecheck     # tsc nos projetos node, web e test
npm run test:unit     # vitest
npm run e2e           # Playwright end-to-end
npm run build         # build de produção do electron-vite
npm run dist:linux    # empacota instaladores (também :mac / :win)
```

## Arquitetura

```
electron/
  main/
    ipc/          # handlers de IPC (projects, git, sync, sessions, mcp,
                  # diagrams, scheduled-jobs, content-contracts, secrets, …)
    services/     # pty-manager, voice-*, diagram-*, job-*, repo-pull,
                  # service-proxy, secret-store, content-gates, metrics,
                  # migrations, git-auth
      handoff/    # alias, prepare, spawn-child, compose-prompt, adopt
      baton/      # distill, compose-baton-prompt
      mcp/        # servidor MCP, tools, service-tools, session-identity
      meetings/, video/, sync/, architecture/
  preload/        # ponte de contextIsolation (window.api.*)
shared/
  types/          # tipos compartilhados main ↔ renderer
  service-registry.ts
src/
  app/            # raiz do App, navegação IconRail, tema
  features/       # sessions (chat, voice), diagrams, handoffs, jobs,
                  # content, cc-configs, projects, architecture, meetings,
                  # dossiers, objectives, tasks, features, metrics, files,
                  # settings, brand
  lib/            # helpers de IPC no renderer
```

**Stack:** Electron 32 · React 18 · TypeScript 5 · electron-vite · Tailwind CSS 4 · Zustand · SQLite (`better-sqlite3`) · `node-pty` · xterm.js · Excalidraw · `@xyflow/react` · `simple-git` · Recharts · SDK `@modelcontextprotocol`. Testado com Vitest e Playwright.

## Servidor MCP

O Pitwall traz um servidor MCP (stdio). Apontar uma sessão do Claude Code para ele dá ao agente tools de:

- **Planejamento** — `objective_*`, `key_result_*`, `task_*`, `feature_*`, `overview_get`
- **Repos** — `repo_connections_get`, `repo_pull_run_list`
- **Delegação** — `session_handoff`, `handoff_list`, `handoff_result`, `handoff_message`, `handoff_ask`, `handoff_progress`, `handoff_report`
- **Diagramas** — `diagram_create`, `diagram_patch`, `diagram_update`, `diagram_get`, `diagram_list`, `diagram_link`, `diagram_unlink`, `diagram_archive`, `diagram_unarchive`, `diagram_delete`, `diagram_library_*`
- **Jobs** — `scheduled_job_create`, `scheduled_job_update`, `scheduled_job_list`, `scheduled_job_run_now`, `job_report`, `job_run_list`
- **Conteúdo** — `content_contract_get`, `content_contract_upsert`, `content_gate_run`, `content_gate_run_list`
- **Serviços** — `service_list`, `service_call`

## Contribuindo

Issues e pull requests são bem-vindos. Para mudanças grandes, abra uma issue antes para discutir a direção.

## Licença

[MIT](./LICENSE) © Thiago Matumoto
