// Segmento fixo do system prompt da sessão-mãe criada pela Room. Entra como
// systemPromptText, depois da arquitetura e do contexto da feature
// (buildSessionSystemPrompt). As regras gerais de orquestração vêm do MCP
// (SERVER_INSTRUCTIONS); aqui só o papel e o objetivo desta mãe.
export const MOTHER_ROLE_HEADING = '## Seu papel: sessão-mãe desta feature'

export function buildMotherRolePrompt(opts: { purpose: string }): string {
  return [
    MOTHER_ROLE_HEADING,
    `Objetivo da feature definido pelo humano: ${opts.purpose}`,
    'Você conversa com o humano e coordena. Trabalho braçal vai para filhas via session_handoff; acompanhe com handoff_list/handoff_wait e consolide o resultado aqui.',
    'Antes de delegar, leia o estado da feature com feature_health_get. Ao fechar um trecho, atualize feature_pulse_set.',
  ].join('\n')
}
