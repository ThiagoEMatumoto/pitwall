// Régua da caixa de input do claude. No 2.1.286 é uma linha cheia de ─; no 2.1.295,
// em sessão nomeada (-n), a régua de cima embute o nome: "──────── nome ─"
// (captura real em __fixtures__/claude-2.1.295-named-idle-45x50.ansi).
// O rótulo não pode ter caractere de caixa: "───┼───" e "── a │ b ──" são tabela.
const RULE_RE = /^─{3,}(?:\s+[^\s─│┼┬┴├┤╭╮╰╯](?:[^─│┼┬┴├┤╭╮╰╯]*[^\s─│┼┬┴├┤╭╮╰╯])?\s+─+)?$/
const MIN_DASHES = 10

export function isInputRule(line: string): boolean {
  if (!RULE_RE.test(line)) return false
  let dashes = 0
  for (const ch of line) if (ch === '─') dashes++
  return dashes >= MIN_DASHES
}
