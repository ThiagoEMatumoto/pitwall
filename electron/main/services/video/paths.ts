import { app } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Onde ficam o workspace do motor e os arquivos gerados.
//
// O workspace Remotion (`video/`) tem package.json e node_modules PRÓPRIOS,
// isolados do ABI Electron do app — por isso é um diretório, não um módulo
// importado. A resolução se apoia em `moduleDir`, que é estável em dev,
// build e e2e (o main compilado vive em `<repoRoot>/out/main`), ao contrário de
// app.getAppPath(), que em e2e devolve `out/main` e não a raiz do repo.

export interface VideoPathEnv {
  isPackaged: boolean;
  resourcesPath: string;
  moduleDir: string;
  env: NodeJS.ProcessEnv;
}

// Pura, pra ser testável sem mockar `electron`.
export function resolveVideoWorkspace(env: VideoPathEnv): string {
  const override = env.env.PITWALL_VIDEO_DIR?.trim();
  if (override) return override;
  if (env.isPackaged) return join(env.resourcesPath, "video");
  return join(env.moduleDir, "..", "..", "video");
}

function currentEnv(): VideoPathEnv {
  return {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    moduleDir: __dirname,
    env: process.env,
  };
}

export function videoWorkspaceDir(): string {
  return resolveVideoWorkspace(currentEnv());
}

// `public/` do Remotion: é a raiz do que o motor consegue carregar por
// staticFile(). Todo áudio/imagem gerado tem que cair aqui dentro, senão o
// render não enxerga o arquivo.
export function videoPublicDir(): string {
  return join(videoWorkspaceDir(), "public");
}

export function videoContentDir(): string {
  return join(videoWorkspaceDir(), "content");
}

export function videoOutDir(): string {
  return join(videoWorkspaceDir(), "out");
}

// Caminho RELATIVO ao public/ — é a forma que o manifesto e o motor usam
// (`staticFile('audio/pt-BR/cold-open.mp3')`). Absolutos no manifesto
// quebrariam o render em outra máquina.
export function audioRelPath(locale: string, sceneId: string): string {
  return `audio/${locale}/${sceneId}.mp3`;
}

export function imageRelPath(projectSlug: string, name: string): string {
  return `img/${projectSlug}/${name}.png`;
}

export function sfxRelPath(name: string): string {
  return `audio/sfx/${name}.wav`;
}

export function publicPathOf(rel: string): string {
  return join(videoPublicDir(), rel);
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
