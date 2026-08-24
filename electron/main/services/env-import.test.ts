import { describe, expect, it, vi } from "vitest";

// env-import importa custom-env/secret-store, cuja cadeia carrega 'electron' —
// mock mínimo pro vitest (node) coletar o módulo, padrão de voice-config.test.
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (plain: string) => Buffer.from(`v:${plain}`, "utf8"),
    decryptString: (buf: Buffer) => buf.toString("utf8").slice(2),
  },
}));

import {
  applyImport,
  scanEnvSources,
  secretFingerprint,
  type EnvImportDeps,
} from "./env-import";

const HOME = "/home/u";
const ROOT = `${HOME}/projetos`;

// "Disco" fake: dirs (path → entradas), files (path → conteúdo) e symlinks.
interface FakeFs {
  dirs?: Record<string, string[]>;
  files?: Record<string, string>;
  symlinks?: string[];
}

function deps(
  fs: FakeFs,
  over: Partial<EnvImportDeps> = {},
): Partial<EnvImportDeps> {
  const dirs = fs.dirs ?? {};
  const files = fs.files ?? {};
  const symlinks = new Set(fs.symlinks ?? []);
  const stat = (dir: boolean, file: boolean, link: boolean) => ({
    isDirectory: () => dir,
    isFile: () => file,
    isSymbolicLink: () => link,
  });
  return {
    home: HOME,
    listDir: (p) => {
      if (!(p in dirs)) throw new Error(`ENOENT: ${p}`);
      return dirs[p];
    },
    lstat: (p) => {
      if (symlinks.has(p)) return stat(false, false, true);
      if (p in dirs) return stat(true, false, false);
      if (p in files) return stat(false, true, false);
      return null;
    },
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    readCustomEnv: () => ({}),
    setEnvVar: vi.fn(() => ({ plaintext: [] })),
    ...over,
  };
}

describe("secretFingerprint", () => {
  it("máscara + últimos 4 + tamanho, nunca o valor inteiro", () => {
    const fp = secretFingerprint("sk-abcdef123456");
    expect(fp).toBe("••••••••3456 (15)");
    expect(fp).not.toContain("sk-abcdef123456");
  });
});

describe("scanEnvSources", () => {
  it("acha .env em ~/projetos e devolve candidato new com fingerprint", () => {
    const out = scanEnvSources(
      deps({
        dirs: { [ROOT]: ["app"], [`${ROOT}/app`]: [".env"] },
        files: {
          [`${ROOT}/app/.env`]: "TAVILY_API_KEY=tvly-secret-12345678\n",
        },
      }),
    );
    expect(out).toEqual([
      {
        key: "TAVILY_API_KEY",
        canonical: "TAVILY_API_KEY",
        serviceId: "tavily",
        sources: [
          { path: `${ROOT}/app/.env`, fingerprint: "••••••••5678 (20)" },
        ],
        status: "new",
      },
    ]);
    expect(JSON.stringify(out)).not.toContain("tvly-secret-12345678");
  });

  it("nunca segue symlink (dir nem arquivo)", () => {
    const out = scanEnvSources(
      deps({
        dirs: {
          [ROOT]: ["link-dir", "app"],
          [`${ROOT}/link-dir`]: [".env"],
          [`${ROOT}/app`]: [".env.link"],
        },
        files: {
          [`${ROOT}/link-dir/.env`]: "A=1\n",
          [`${ROOT}/app/.env.link`]: "B=2\n",
        },
        symlinks: [`${ROOT}/link-dir`, `${ROOT}/app/.env.link`],
      }),
    );
    expect(out).toEqual([]);
  });

  it("pula node_modules/.git/.worktrees/.claude e .env.example/.template", () => {
    const skipped = ["node_modules", ".git", ".worktrees", ".claude"];
    const out = scanEnvSources(
      deps({
        dirs: {
          [ROOT]: [...skipped, "app"],
          ...Object.fromEntries(skipped.map((s) => [`${ROOT}/${s}`, [".env"]])),
          [`${ROOT}/app`]: [
            ".env.example",
            ".env.template",
            ".env.staging",
            "notes.txt",
          ],
        },
        files: {
          ...Object.fromEntries(
            skipped.map((s) => [`${ROOT}/${s}/.env`, "SKIPPED=1\n"]),
          ),
          [`${ROOT}/app/.env.example`]: "EXAMPLE=1\n",
          [`${ROOT}/app/.env.template`]: "TEMPLATE=1\n",
          [`${ROOT}/app/.env.staging`]: "STAGING_KEY=abcd1234efgh\n",
          [`${ROOT}/app/notes.txt`]: "NOT_ENV=1\n",
        },
      }),
    );
    expect(out.map((c) => c.key)).toEqual(["STAGING_KEY"]);
  });

  it("respeita profundidade máxima 5", () => {
    const d5 = `${ROOT}/a/b/c/d/e`;
    const d6 = `${d5}/f`;
    const out = scanEnvSources(
      deps({
        dirs: {
          [ROOT]: ["a"],
          [`${ROOT}/a`]: ["b"],
          [`${ROOT}/a/b`]: ["c"],
          [`${ROOT}/a/b/c`]: ["d"],
          [`${ROOT}/a/b/c/d`]: ["e"],
          [d5]: [".env", "f"],
          [d6]: [".env"],
        },
        files: {
          [`${d5}/.env`]: "DEPTH5=ok-value-123\n",
          [`${d6}/.env`]: "DEPTH6=lost\n",
        },
      }),
    );
    expect(out.map((c) => c.key)).toEqual(["DEPTH5"]);
  });

  it("dedupe: mesma chave em dois arquivos vira um candidato com duas fontes", () => {
    const out = scanEnvSources(
      deps({
        dirs: {
          [ROOT]: ["a", "b"],
          [`${ROOT}/a`]: [".env"],
          [`${ROOT}/b`]: [".env"],
        },
        files: {
          [`${ROOT}/a/.env`]: "GEMINI_API_KEY=same-value-123\n",
          [`${ROOT}/b/.env`]: "GEMINI_API_KEY=same-value-123\n",
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].sources.map((s) => s.path)).toEqual([
      `${ROOT}/a/.env`,
      `${ROOT}/b/.env`,
    ]);
    expect(out[0].status).toBe("new");
  });

  it("fontes divergentes sem cofre = conflict", () => {
    const out = scanEnvSources(
      deps({
        dirs: {
          [ROOT]: ["a", "b"],
          [`${ROOT}/a`]: [".env"],
          [`${ROOT}/b`]: [".env"],
        },
        files: {
          [`${ROOT}/a/.env`]: "K=valor-um-1234\n",
          [`${ROOT}/b/.env`]: "K=valor-dois-5678\n",
        },
      }),
    );
    expect(out[0].status).toBe("conflict");
  });

  it("contra o cofre: valor igual = same, diferente = conflict", () => {
    const fs: FakeFs = {
      dirs: { [ROOT]: ["a"], [`${ROOT}/a`]: [".env"] },
      files: { [`${ROOT}/a/.env`]: "K=vault-value-99\nJ=other-value-11\n" },
    };
    const out = scanEnvSources(
      deps(fs, {
        readCustomEnv: () => ({ K: "vault-value-99", J: "vault-value-99" }),
      }),
    );
    expect(out.find((c) => c.key === "K")?.status).toBe("same");
    expect(out.find((c) => c.key === "J")?.status).toBe("conflict");
  });

  it("match por alias do registry: VOZ_TTS_KEY → elevenlabs/ELEVENLABS_API_KEY", () => {
    const voz = `${HOME}/.config/voz/voz.env`;
    const out = scanEnvSources(
      deps({
        dirs: { [ROOT]: [] },
        files: { [voz]: "VOZ_TTS_KEY=eleven-key-4321\n" },
      }),
    );
    expect(out).toEqual([
      {
        key: "VOZ_TTS_KEY",
        canonical: "ELEVENLABS_API_KEY",
        serviceId: "elevenlabs",
        sources: [{ path: voz, fingerprint: expect.stringContaining("4321") }],
        status: "new",
      },
    ]);
  });

  it("chave fora do registry sai sem serviceId/canonical", () => {
    const out = scanEnvSources(
      deps({
        dirs: { [ROOT]: ["a"], [`${ROOT}/a`]: [".env"] },
        files: { [`${ROOT}/a/.env`]: "MY_RANDOM_VAR=whatever-123\n" },
      }),
    );
    expect(out[0].serviceId).toBeUndefined();
    expect(out[0].canonical).toBeUndefined();
  });
});

describe("applyImport", () => {
  it("relê o arquivo na hora e grava via setEnvVar; valor não aparece no retorno", () => {
    const setEnvVar = vi.fn(() => ({ plaintext: [] }));
    const result = applyImport(
      [{ key: "K", sourcePath: `${ROOT}/a/.env` }],
      deps(
        { files: { [`${ROOT}/a/.env`]: "K=secret-value-777\n" } },
        { setEnvVar },
      ),
    );
    expect(setEnvVar).toHaveBeenCalledWith("K", "secret-value-777");
    expect(result).toEqual({ applied: ["K"], missing: [], plaintext: [] });
    expect(JSON.stringify(result)).not.toContain("secret-value-777");
  });

  it("chave ausente do arquivo (ou arquivo sumido) vira missing", () => {
    const setEnvVar = vi.fn(() => ({ plaintext: [] }));
    const result = applyImport(
      [
        { key: "GONE", sourcePath: `${ROOT}/a/.env` },
        { key: "NOFILE", sourcePath: `${ROOT}/sumiu/.env` },
      ],
      deps({ files: { [`${ROOT}/a/.env`]: "K=abc\n" } }, { setEnvVar }),
    );
    expect(setEnvVar).not.toHaveBeenCalled();
    expect(result.missing).toEqual(["GONE", "NOFILE"]);
  });

  it("propaga aviso de plaintext do cofre", () => {
    const result = applyImport(
      [{ key: "K", sourcePath: `${ROOT}/a/.env` }],
      deps(
        { files: { [`${ROOT}/a/.env`]: "K=abc-plain-123\n" } },
        { setEnvVar: () => ({ plaintext: ["K"] }) },
      ),
    );
    expect(result.plaintext).toEqual(["K"]);
  });
});
