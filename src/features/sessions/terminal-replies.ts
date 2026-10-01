// Respostas que o próprio xterm emite a queries do PTY (não são teclas): DA1/DA2
// (CSI ? … c / CSI > … c), DSR/CPR (CSI … n / CSI … R), DECRQM (CSI ? … $ y),
// OSC 4/10/11/12 de cor e DCS (XTVERSION, DECRQSS). Durante o replay do backlog
// elas respondem a queries do PASSADO e cairiam como lixo no prompt vivo — mas o
// que o usuário digita ao mesmo tempo tem de chegar ao PTY.
const QUERY_REPLY =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[?>]?[\d;]*[cnR]|\x1b\[\??[\d;]*\$y|\x1b\][0-9]+;rgb:[^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g

export function stripQueryReplies(data: string): string {
  return data.replace(QUERY_REPLY, '')
}
