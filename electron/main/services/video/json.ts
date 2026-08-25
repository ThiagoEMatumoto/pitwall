// Leitura defensiva das colunas TEXT que guardam JSON. Mesmo princípio do
// parseScene de diagram-store: o JSON foi gravado por nós, mas uma row
// corrompida (edição manual no sqlite, migração futura mal feita) não pode
// derrubar o get() inteiro — cai no default e a área continua abrindo.
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || parsed === undefined) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

// Array de objetos vindo de coluna TEXT: além do parse, exige que seja array.
// Um `{}` gravado onde deveria haver `[]` viraria `.map is not a function` na
// UI, longe daqui.
export function parseJsonArray<T>(raw: string | null | undefined): T[] {
  const parsed = parseJson<unknown>(raw, []);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

// Record<string,string> vindo de coluna TEXT (paleta, vozes por locale).
export function parseJsonRecord(
  raw: string | null | undefined,
): Record<string, string> {
  const parsed = parseJson<unknown>(raw, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

// Objeto simples (não array, não null) — o guard que separa "veio um mapa" de
// "veio outra coisa" antes de indexar por chave.
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Descarta as chaves cujo valor não é string. Paleta e mapa de vozes são
// Record<string,string> no tipo; um número gravado ali viraria bug de render.
export function asStringRecord(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
