// Parser de arquivos .env, compartilhado entre voice-config e o importador do
// env hub. O arquivo é LIDO, nunca sourceado — um .env executado por shell é
// vetor de execução de código. Porte fiel de vozapp/config.py:_parse (só
// `CHAVE=valor` e comentários), incluindo dois defeitos medidos lá e mantidos
// por compatibilidade:
//
// 1. Comentário na mesma linha (`CHAVE=220  # explicação`) é cortado.
// 2. Valor entre aspas é preservado inteiro, inclusive `#`.
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart()
    const eq = line.indexOf('=')
    const key = line.slice(0, eq).trim()
    if (!key || !/^[A-Za-z_]/.test(key)) continue
    const value = line.slice(eq + 1).trim()
    const quote = value.slice(0, 1)
    if (quote === "'" || quote === '"') {
      const close = value.indexOf(quote, 1)
      out[key] = close > 0 ? value.slice(1, close) : value.slice(1)
    } else {
      out[key] = value.split('#')[0].trim()
    }
  }
  return out
}
