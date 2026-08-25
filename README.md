<div align="center">

# Pitwall

**A desktop cockpit for running and supervising many [Claude Code](https://claude.com/claude-code) sessions across your projects and repositories.**

English · [Português (BR)](./README.pt-BR.md)

[![Release](https://img.shields.io/github/v/release/ThiagoEMatumoto/pitwall?sort=semver)](https://github.com/ThiagoEMatumoto/pitwall/releases/latest)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-blue)](https://github.com/ThiagoEMatumoto/pitwall/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Built with Electron](https://img.shields.io/badge/built%20with-Electron%20%2B%20React-47848F)](https://www.electronjs.org/)

<br/>

<video src="docs/assets/promo-en.mp4" controls muted width="900"></video>

<sub><a href="docs/assets/promo-en.mp4">Watch the intro video</a></sub>

</div>

---

Claude Code is a terminal-first agent. **Pitwall** wraps it in a desktop app so you can drive several agents at once — each in its own project and repo — without juggling terminal tabs. It keeps a local SQLite database of your projects, sessions, plans and repositories, renders each session as either a live terminal or a structured chat, and connects related repositories so a session in one repo can delegate work to a session in another.

The name comes from the Formula 1 pit wall: you are not driving the car, you are on the radio with several drivers at once.

> **Status:** actively developed, versioned releases for macOS, Windows and Linux. Some features are marked _experimental_ below.

## Voice: dictate a prompt, hear the answer

The point of the voice mode is what it does **not** do: dictation never sends anything. The transcript lands in the composer for you to read, edit and send yourself.

- **Dictation.** The mic button records in the renderer (`getUserMedia` + `MediaRecorder`, webm/opus) and posts the audio to an OpenAI-compatible `/v1/audio/transcriptions` endpoint. The endpoint, key, model, language and a minimum-duration threshold come from `~/.config/voz/voz.env` — nothing is hardcoded to a vendor. Recordings shorter than the threshold are discarded instead of transcribed.
- **Long dictation is condensed, not rewritten.** A speech transcript carries hesitations, restarts and mangled English terms ("abrir com request" → "abrir pull request"). Long dictations go through `claude -p` with `haiku` (tools disabled — the spoken text must never trigger an action) before reaching the composer. Two guards: the pass is fail-open, so a failure returns the raw dictation instead of losing it, and a result more than 1.2× the original is treated as the model explaining rather than condensing and gets discarded.
- **Spoken turn summaries.** When a session crosses the `working → waiting/idle` edge, Pitwall reads the last assistant turn from the transcript and turns it into 2-3 spoken sentences (also `haiku`), streamed through ElevenLabs. It only fires for sessions where you turned it on, one by one — a per-session opt-in, because the cost is per turn. A permission prompt is not the end of a turn and does not summarize. There is also a button to summarize on demand, which ignores the opt-in gate because you asked for it explicitly.

## Diagrams: an Excalidraw canvas the agent can edit

Diagrams are a real [Excalidraw](https://excalidraw.com) canvas, editable by hand. The agent writes to it through MCP tools instead of producing an image.

- **`diagram_create`** takes a _skeleton_: semantic nodes and arrows, ids instead of coordinates. Omit `x`/`y` and the converter lays it out; arrows reference node ids via `start`/`end` and carry a label. Raw Excalidraw scenes are accepted too, but the skeleton is the preferred input.
- **`diagram_patch` is the reason this works.** It applies incremental `add | update | delete` ops addressing elements by skeleton id **on top of the current scene**, so the box you dragged and the color you changed survive the agent's next edit. `diagram_update` exists for a deliberate full redraw and says out loud that it discards your refinements. Both record a version snapshot with a changelog line.
- **`diagram_link`** attaches a diagram to a parent — project, repo, feature, task, objective, key result, dossier, meeting, content contract, session or handoff — so it shows up in that context. Deletion is a two-step guard: only an archived diagram can be deleted, and only with `confirm`.
- A global shape library is shared by every canvas (`diagram_library_install` / `_list` / `_remove`).

## Delegated sessions: the nickname is the address

A session can spawn another session in a connected repo and talk to it while it works.

- **`session_handoff`** spawns the child immediately — no approval dialog in the middle. You pass the repo you are working in, the target repo and a mode: `plan` (child is read-only, for investigation), `auto-edits` (child edits files on its own, destructive commands denied) or `interactive` (asks for everything). Those map to the CLI's `--permission-mode`: `plan`, `acceptEdits`, and no flag respectively. Any autonomous mode also gets a canonical denylist of irreversible operations, as defense in depth. If the target repo already has an active handoff the call is refused unless you pass `force`.
- **The child is born with a nickname, and the nickname is its address.** It is the `-n <name>` of the spawn _and_ the `to` of cross-session messaging: `SendMessage({ to: "mauricio-auth-refactor" })`. The format is `<name>-<scope>` — a human name drawn from a per-role pool (investigator / implementer / operator, derived 1:1 from the mode) plus a scope taken from the task — because two peers colliding on a name get disambiguated by the CLI into an unreadable hex suffix.
- **The child reports through tools, not prose.** `handoff_progress` for a non-terminal step, `handoff_ask` when it hits a blocker it must not decide alone (this moves the handoff to `needs_input`; asking again stacks onto the pending question instead of dropping it), `handoff_report` only when the work is done _and_ verified. The mother reads `handoff_result`, which returns durable state plus live PTY telemetry (`working | waiting | idle | ended`, tokens, last activity) — that is how you tell real progress from a stall.
- **The Crew Dock** is where the delegated sessions live: a 40px rail whose color is the state, with a dot per child. When one starts waiting on you, its dot pulses and the counter turns amber inside those 40px, without a panel opening over your terminal. `Ctrl+J` enters, arrows move, Space/Enter peeks in place, Esc returns focus to wherever it was.

## See it running

These clips show real screens with a fictional dataset.

<img src="docs/assets/demo.gif" alt="Pitwall — architecture graph, multi-repo orchestration and planning boards" width="900" />

<sub>Repository dependency graphs, multi-repo orchestration and planning boards. <a href="docs/assets/demo.mp4">MP4 version</a>.</sub>

<img src="docs/assets/architecture.png" alt="Global multi-repo architecture graph" width="900" />

<img src="docs/assets/features.png" alt="Features planning board" width="900" />

## Everything else

**Sessions.** Multiple concurrent Claude Code sessions over a real PTY (`node-pty`), each bound to a project/repo. Two toggleable views per session: a full terminal (xterm.js with WebGL, fit, search, web-links and clipboard addons) or a native chat that renders the transcript as message bubbles, plan cards, tool calls, thinking blocks, sub-agent cards and interactive question cards. The composer picks model, reasoning effort (including `ultracode` on models that support it) and permission mode without typing slash commands, pastes images, and shows a live context indicator.

**Projects, repos and cross-machine sync.** Repositories are grouped into projects under a vault root, with detection of folders you have not registered yet. App state is serialized into a Git bundle and pushed/pulled automatically, reusing your `gh` credential helper — no tokens on disk. Repos registered on one machine are cloned on the others. Pull-all runs `git pull --ff-only` across every repo, skipping dirty or diverged ones, with an opt-in periodic auto-pull.

**Planning boards over MCP.** Objectives → key results, tasks and features in local SQLite, all exposed as MCP tools so the agent keeps them current while it works, plus an architecture graph of inter-repo dependencies (`@xyflow/react`) that is injected into each session's system prompt.

**Env Hub and the service registry.** Third-party services are declared in a registry (LiteLLM, Gemini, LegalCore, LaaS, ElevenLabs, Tavily); a session calls `service_list` / `service_call` with `{service, operation, params}` and the main process injects the credential and performs the fetch. The URL comes only from the registry — never from params — and params are validated against a strict schema first, so the key stays out of the agent's context. Secrets are encrypted at rest with Electron's `safeStorage`; when the OS keyring is unavailable the UI says so instead of pretending. An importer reads existing `.env` files, and every call is audited.

**Scheduled jobs.** Headless `claude` runs on a schedule, with catch-up for missed runs and an atomic claim so a double poll cannot double-fire. Restricted to observe-only permission modes (`default`, `plan`) as an explicit allowlist — an unsupervised run does not get autonomous modes. Exposed as `scheduled_job_*`, `job_report` and `job_run_list`.

**Content contracts and gates.** A versioned contract (audience, tone, allowed and forbidden facts, scope, delivery limits, ethical rules) with six executable gates: `tone-lint`, `forbidden-facts`, `scope`, `scope-checklist`, `delivery-limit` and `positive-evidence`. A gate that fails to run reports `error`, never `passed`.

**Baton.** When a session's context fills up, it distills its own transcript into a briefing for the successor session — state now, why the decisions were made (so the successor does not redo them) and the concrete next step.

**Ingest and dossiers _(experimental)_.** A staged research pipeline with human approval gates and checkpoints, fed by a Tavily source provider with source classification.

**Meetings.** Local recording and transcription through a Python sidecar (`faster-whisper` large-v3 plus speaker diarization with `sherpa-onnx` — no gated models, no PyTorch), a live transcript view and a guided installer. Extraction of action items, decisions and feedback runs through `claude -p` or a local Ollama model, with every item grounded on a literal quote that must match the transcript. Includes an ICS calendar watcher.

**Claude Code configuration.** Read and edit `CLAUDE.md`, rules, CLI settings, hooks, keybindings, MCP servers, plugins/marketplace and the statusline script from the app.

**Usage metrics.** A local dashboard built from your Claude Code JSONL transcripts: token usage and cost, top tools and an agent-orchestration KPI.

**Video Lab _(in development)_.** A Remotion project for producing the product videos. It lives on a branch and is not part of a release yet.

## Install

Download a prebuilt app from the [latest release](https://github.com/ThiagoEMatumoto/pitwall/releases/latest):

| Platform | Artifact                         |
| -------- | -------------------------------- |
| macOS    | `.dmg` (Apple Silicon) or `.zip` |
| Windows  | `Pitwall-Setup-*.exe` (NSIS)     |
| Linux    | `.AppImage` or `.deb`            |

The app auto-updates via `electron-updater`.

> Pitwall drives the Claude Code CLI, so you want [Claude Code](https://claude.com/claude-code) installed and authenticated on the machine.

## Development

Requirements: **Node 20+**.

```bash
npm install
npm run dev      # electron-vite dev with HMR
```

`npm run dev` is the only command needed to iterate. Renderer (React) changes hot-reload in seconds. Changes to the main process (`electron/main/**`) or preload (`electron/preload/**`) require restarting `npm run dev`.

Other scripts:

```bash
npm run typecheck     # tsc across node, web and test projects
npm run test:unit     # vitest
npm run e2e           # Playwright end-to-end
npm run build         # electron-vite production build
npm run dist:linux    # package installers (also :mac / :win)
```

## Architecture

```
electron/
  main/
    ipc/          # IPC handlers (projects, git, sync, sessions, mcp,
                  # diagrams, scheduled-jobs, content-contracts, secrets, …)
    services/     # pty-manager, voice-*, diagram-*, job-*, repo-pull,
                  # service-proxy, secret-store, content-gates, metrics,
                  # migrations, git-auth
      handoff/    # alias, prepare, spawn-child, compose-prompt, adopt
      baton/      # distill, compose-baton-prompt
      mcp/        # MCP server, tools, service-tools, session-identity
      content-gates/, ingest/, meeting/, dossier/, sync/, architecture/
  preload/        # contextIsolation bridge (window.api.*)
shared/
  types/          # types shared across main ↔ renderer
  service-registry.ts
src/
  app/            # App root, IconRail navigation, theme
  features/       # sessions (chat, voice), diagrams, handoffs, jobs,
                  # content, cc-configs, projects, architecture, meetings,
                  # dossiers, objectives, tasks, features, metrics, files,
                  # settings, brand
  lib/            # renderer-side IPC helpers
sidecar/          # Python meeting-transcription sidecar
```

**Stack:** Electron 32 · React 18 · TypeScript 5 · electron-vite · Tailwind CSS 4 · Zustand · SQLite (`better-sqlite3`) · `node-pty` · xterm.js · Excalidraw · `@xyflow/react` · `simple-git` · Recharts · `@modelcontextprotocol` SDK. Tested with Vitest and Playwright.

## MCP server

Pitwall ships an MCP server (stdio). Pointing a Claude Code session at it gives the agent tools for:

- **Planning** — `objective_*`, `key_result_*`, `task_*`, `feature_*`, `overview_get`
- **Repos** — `repo_connections_get`, `repo_pull_run_list`
- **Delegation** — `session_handoff`, `handoff_list`, `handoff_result`, `handoff_message`, `handoff_ask`, `handoff_progress`, `handoff_report`
- **Diagrams** — `diagram_create`, `diagram_patch`, `diagram_update`, `diagram_get`, `diagram_list`, `diagram_link`, `diagram_unlink`, `diagram_archive`, `diagram_unarchive`, `diagram_delete`, `diagram_library_*`
- **Jobs** — `scheduled_job_create`, `scheduled_job_update`, `scheduled_job_list`, `scheduled_job_run_now`, `job_report`, `job_run_list`
- **Content** — `content_contract_get`, `content_contract_upsert`, `content_gate_run`, `content_gate_run_list`
- **Services** — `service_list`, `service_call`

## Contributing

Issues and pull requests are welcome. For substantial changes, open an issue first to discuss the direction.

## License

[MIT](./LICENSE) © Thiago Matumoto
