// Vigia do vínculo de um handoff: guarda o que ele mostrou entre dois passos de
// um cenário, e não só no fim de cada um. Um vínculo solto e reposto antes do fim
// do passo passaria por uma leitura feita só na fronteira.
export interface LinkRead {
  filha: string | null
  conversa: string | null
  mae: string | null
}

export interface Link extends LinkRead {
  passo: string
}

const same = (a: LinkRead, b: LinkRead): boolean =>
  a.filha === b.filha && a.conversa === b.conversa && a.mae === b.mae

export function createLinkWatch(read: () => LinkRead) {
  let seen: LinkRead[] = []
  let polled = { read: 0, failed: 0 }
  return {
    // Para um timer: a leitura que falha é contada, não lançada.
    sample(): void {
      try {
        seen = [...seen, read()]
        polled = { ...polled, read: polled.read + 1 }
      } catch {
        polled = { ...polled, failed: polled.failed + 1 }
      }
    },
    // Fecha o passo: cada valor distinto visto desde o anterior, na ordem, com a
    // leitura de agora por último.
    mark(passo: string): Link[] {
      const all = [...seen, read()]
      seen = []
      return all.filter((r, i) => i === 0 || !same(r, all[i - 1])).map((r) => ({ passo, ...r }))
    },
    // Quantas leituras o timer fez e quantas perdeu: sem as primeiras não houve
    // vigia, e cada uma das segundas é um trecho sem ela.
    polled: (): { read: number; failed: number } => polled,
  }
}
