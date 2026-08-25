import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Duração real do arquivo de áudio, em segundos. O motor precisa dela pra
// montar o timeline: a duração-alvo do roteiro é intenção, a do ffprobe é o
// que o vídeo realmente vai durar.
//
// Porte de `video/scripts/tts.mjs:probeDurationSec`. Devolve null em vez de
// lançar: um mp3 ilegível não pode derrubar a geração inteira do lote — a cena
// fica sem duração e o manifesto cai na duração-alvo.
export async function probeDurationSec(
  absPath: string,
): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      absPath,
    ]);
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

export function round3(n: number): number {
  return Number(n.toFixed(3));
}
