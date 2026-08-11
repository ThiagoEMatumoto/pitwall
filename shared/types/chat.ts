// Tipos do Chat View (Fase 5). O backend (F5a) lê/parseia/observa o transcript
// JSONL da sessão e expõe estas formas por IPC; a UI (F5b) as consome.

// Uma pergunta de AskUserQuestion. Espelha input.questions[] do transcript:
// header curto + a pergunta + opções (label em destaque, description abaixo).
export interface ChatQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: {
    label: string
    description: string
    // Campos abaixo só vêm preenchidos no card SINTETIZADO do menu TUI ao vivo
    // (ChatView, a partir de tui-menu-parser) — o card pós-resposta do
    // transcript (JSONL) nunca os popula (undefined), sem mudança visual lá.
    sentinel?: 'other' | 'chat'
    checked?: boolean
    preview?: string
  }[]
}

// Uma mensagem renderizável do chat. A lista é ORDENADA na ordem do transcript
// (ordem das linhas + ordem dos blocos de content dentro de cada linha). Uma
// única linha assistant/user pode gerar várias mensagens (texto + tool_use, ou
// texto + tool_result).
//
// Os momentos interativos do claude (AskUserQuestion / ExitPlanMode) ganham kinds
// próprios em vez de cair como tool_use/tool_result genéricos. A pergunta/plano
// vem do tool_use (assistant); a resposta/decisão vem do tool_result seguinte
// (user), linkada por forId == id. A UI funde os dois (mostra a opção escolhida /
// o estado de aprovação no mesmo card) e detecta pendência (tool_use sem result).
export type ChatMessage =
  | { kind: 'user'; text: string }
  // interrupted: a CLI gravou uma linha de interrupção apontando o message.id
  // deste turno (interruptedMessageId) — o texto ficou pela metade. A UI marca
  // isso; sem a marca, uma resposta cortada é indistinguível de uma completa.
  | { kind: 'assistant'; text: string; interrupted?: boolean }
  // Bloco de raciocínio (extended thinking). text vazio é descartado no parser;
  // redacted_thinking (criptografado) vira um placeholder. Render colapsável.
  | { kind: 'thinking'; text: string }
  // interrupted: o turno que emitiu este tool_use foi interrompido e ele nunca
  // recebeu tool_result — a ferramenta não chegou a rodar (ou foi abortada antes
  // de responder). Sem a marca, o card fica idêntico ao de uma tool que rodou.
  | { kind: 'tool_use'; id: string; name: string; input: unknown; interrupted?: boolean }
  // interrupted: a CLI marcou `toolUseResult.interrupted` — a ferramenta rodou
  // mas foi abortada no meio; o content é saída PARCIAL, não o resultado final.
  | { kind: 'tool_result'; forId: string; content: string; isError: boolean; interrupted?: boolean }
  // Subagente disparado via Task/Agent. Substitui o tool_use genérico quando há
  // dados do subagente (lidos de <dir>/<sessionId>/subagents/agent-*). id = o
  // toolUseId da invocação; turns = resumos de cada turno (assistant) pra expandir.
  | {
      kind: 'subagent'
      id: string
      name: string
      description: string
      turnCount: number
      turns: string[]
    }
  // Linha type:'system' do transcript, CURADA: só subtypes úteis (compactação,
  // erro de API, info) viram um chip discreto colapsado. O ruído de alto volume
  // (stop_hook_summary, turn_duration, …) é descartado no parser. trigger/
  // preTokens/postTokens só vêm preenchidos no compact_boundary (compactMetadata
  // do transcript); ausentes nos demais subtypes.
  | {
      kind: 'system'
      label: string
      detail: string
      level: 'info' | 'warning' | 'error'
      trigger?: string
      preTokens?: number
      postTokens?: number
    }
  // Resumo de compact gravado pela CLI como turno de usuário (isCompactSummary:
  // true) — NUNCA o humano digitou isso. Card colapsado, não bolha de usuário.
  | { kind: 'compact_summary'; text: string }
  // Marcador sintético: message.model mudou entre duas linhas assistant
  // consecutivas (troca de modelo mid-session). Emitido antes da mensagem
  // assistant que já usa o novo modelo.
  | { kind: 'model_change'; from: string; to: string }
  // Slash command do usuário (/goal, /model, …). A CLI grava como content string
  // com <command-name>/<command-args> (formato atual, type:'user') ou como linha
  // type:'system'/local_command (formato antigo) — ambos viram este kind. name SEM
  // a barra inicial; a UI renderiza "/{name} {args}".
  | { kind: 'command'; name: string; args: string }
  // Saída de um slash command (<local-command-stdout>), com escapes ANSI já
  // removidos no parser. Render colapsado (a saída costuma ser longa).
  | { kind: 'command_output'; text: string }
  // Conteúdo INJETADO no turno do usuário que o humano não digitou: isMeta:true
  // (SKILL.md, avisos), <system-reminder>, caveats. label = resumo curto (primeira
  // linha) pro chip colapsado; text = conteúdo integral pra expandir.
  | { kind: 'meta'; text: string; label: string }
  // Resultado de um subagente (tool_result do Task/Agent). Não renderiza sozinho:
  // a UI funde o status (sucesso/erro) no SubagentCard por forId == id.
  | { kind: 'subagent_result'; forId: string; isError: boolean }
  | { kind: 'ask_user_question'; id: string; questions: ChatQuestion[] }
  | { kind: 'ask_user_question_answered'; forId: string; answers: Record<string, string> }
  // planFilePath: caminho do arquivo de plano (~/.claude/plans/*.md) gravado pela
  // CLI no input do ExitPlanMode — fallback pra UI buscar o conteúdo quando plan
  // vier vazio. null em CLIs antigos.
  | {
      kind: 'exit_plan_mode'
      id: string
      plan: string
      planFilePath: string | null
      allowedPrompts: string[] | null
    }
  | { kind: 'plan_decision'; forId: string; approved: boolean }

// Retorno do read inicial (chat:get-transcript). path/mtimeMs são null quando a
// sessão ainda não tem transcript no disco (recém-spawnada).
export interface ChatTranscript {
  // sessionId INTERNO (sessions.id) ecoado de volta, pra o renderer casar a
  // resposta com a sessão certa.
  sessionId: string
  ccSessionId: string | null
  path: string | null
  mtimeMs: number | null
  messages: ChatMessage[]
  // Último Write/Edit do transcript apontando pra ~/.claude/plans/*.md. O plan
  // file é escrito DURANTE o plan mode, então este caminho permite mostrar o
  // conteúdo do plano no card pendente (o tool_use do ExitPlanMode ainda não
  // está no JSONL nesse momento). null quando a sessão nunca escreveu plano.
  lastPlanFilePath: string | null
}

// Payload do broadcast chat:transcript-update. Emite a LISTA completa reparseada
// a cada mudança do JSONL — simples e robusto a reescritas do arquivo (o renderer
// só substitui o estado). transcriptExists distingue "JSONL ainda não nasceu"
// (sessão recém-spawnada, pré-flush) de "existe mas sem mensagens renderizáveis".
export interface ChatTranscriptUpdate {
  sessionId: string
  transcriptExists: boolean
  messages: ChatMessage[]
  lastPlanFilePath: string | null
}
