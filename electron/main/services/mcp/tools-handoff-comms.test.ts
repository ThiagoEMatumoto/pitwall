/** @vitest-environment node */
// Unit dos handlers MCP do canal bidirecional de handoff (handoff_message /
// handoff_ask / enriquecimento do handoff_result). DB better-sqlite3 real (tmp),
// electron mockado, e os seams externos (inject.ts, pty-manager, session-activity)
// mockados — o foco é o contrato dos guards e da transição de status.
import { rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mcp-handoff-comms-test-"));
  return {
    app: { getPath: () => dir, getVersion: () => "0.0.0-test" },
    BrowserWindow: { getAllWindows: () => [] },
  };
});

// Seam de injeção: espiamos a entrega sem tocar num PTY real.
const injectIntoChild = vi.fn();
vi.mock("../handoff/inject", () => ({
  injectIntoChild: (id: string, text: string) => injectIntoChild(id, text),
  formatPtyInjection: (s: string) => s,
}));

// PTY vivo? controlável por teste.
const isRunning = vi.fn((_id: string) => true);
vi.mock("../pty-manager", () => ({
  ptyManager: { isRunning: (id: string) => isRunning(id) },
}));

// Atividade ao vivo da filha: snapshot fixo pro enriquecimento do handoff_result.
vi.mock("../session-activity", () => ({
  getActivityFor: () => ({
    status: "working",
    lastActivityAt: 123,
    lastText: "editando arquivo",
    tokens: { output: 10, context: 200 },
  }),
}));

import { app } from "electron";
import { closeDb, getDb } from "../db";
import * as handoffStore from "../handoff-store";
import {
  buildTools,
  type McpNotify,
  type McpRequestContext,
  type ToolDef,
  type ToolResult,
} from "./tools";

function makeNotify(): McpNotify {
  return {
    broadcast: () => {},
    affectedObjectives: () => {},
    affectedObjectivesForFeatureLinks: () => {},
  };
}

let tools: ToolDef[];

function tool(name: string): ToolDef {
  const def = tools.find((t) => t.name === name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return def;
}

function call<T>(name: string, args: unknown): T {
  return (tool(name).handler(args) as ToolResult).structuredContent as T;
}

// Mesma bateria de tools, mas com o carimbo de identidade que o app põe no spawn
// (?s=<sessions.id>) — é ele que diz QUEM está chamando.
function callAs<T>(
  callerSessionId: string | null,
  name: string,
  args: unknown,
): T {
  const ctx: McpRequestContext = { motherSessionId: callerSessionId };
  const def = buildTools(makeNotify(), ctx).find((t) => t.name === name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return (def.handler(args) as ToolResult).structuredContent as T;
}

// Cria um handoff running com filha atrelada (sessions.id + cc_session_id).
function seedRunningHandoff(childSessionId = "s-child"): string {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`,
  ).run(Date.now(), Date.now());
  db.prepare(
    `INSERT OR IGNORE INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','R1','/tmp/r1',0,?)`,
  ).run(Date.now());
  db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, 'r1', ?, 'running', ?)`,
  ).run(childSessionId, `cc-${childSessionId}`, Date.now());
  const h = handoffStore.create({
    targetRepoId: "r1",
    task: "t",
    composedPrompt: "p",
  });
  handoffStore.approve(h.id, {});
  handoffStore.markRunning(h.id, childSessionId);
  return h.id;
}

beforeEach(() => {
  tools = buildTools(makeNotify());
  injectIntoChild.mockClear();
  isRunning.mockClear();
  isRunning.mockReturnValue(true);
  // Limpa handoffs/sessions entre casos (DB persiste no processo).
  const db = getDb();
  db.prepare("DELETE FROM handoffs").run();
  db.prepare("DELETE FROM sessions").run();
});

afterAll(() => {
  closeDb();
  rmSync(app.getPath("userData"), { recursive: true, force: true });
});

describe("handoff_ask (filha → mãe)", () => {
  it("grava a pergunta e move pra needs_input", () => {
    const id = seedRunningHandoff();
    const res = call<{ status: string; pendingQuestion: string }>(
      "handoff_ask",
      {
        handoffId: id,
        question: "qual lib de validação?",
      },
    );
    expect(res.status).toBe("needs_input");
    expect(res.pendingQuestion).toBe("qual lib de validação?");
  });

  it("404 quando o handoff não existe", () => {
    expect(() =>
      call("handoff_ask", { handoffId: "nope", question: "x" }),
    ).toThrow(/não encontrado/);
  });
});

describe("handoff_message (mãe → filha)", () => {
  it("entrega a mensagem, retoma a filha (needs_input → running) e espia inject", () => {
    const id = seedRunningHandoff();
    handoffStore.ask(id, "pergunta");
    const res = call<{ status: string; delivered: boolean }>(
      "handoff_message",
      {
        handoffId: id,
        text: "use zod",
      },
    );
    expect(res.delivered).toBe(true);
    expect(res.status).toBe("running");
    expect(injectIntoChild).toHaveBeenCalledWith("s-child", "use zod");
  });

  it("404 quando o handoff não existe", () => {
    expect(() =>
      call("handoff_message", { handoffId: "nope", text: "x" }),
    ).toThrow(/não encontrado/);
  });

  it("rejeita quando o status não é in-flight (ex.: done)", () => {
    const id = seedRunningHandoff();
    handoffStore.report(id, "concluído");
    expect(() => call("handoff_message", { handoffId: id, text: "x" })).toThrow(
      /não está em andamento/,
    );
    expect(injectIntoChild).not.toHaveBeenCalled();
  });

  it("rejeita quando a PTY da filha está morta", () => {
    const id = seedRunningHandoff();
    isRunning.mockReturnValue(false);
    expect(() => call("handoff_message", { handoffId: id, text: "x" })).toThrow(
      /não está mais viva/,
    );
    expect(injectIntoChild).not.toHaveBeenCalled();
  });
});

describe("handoff_progress durante needs_input (regressão: filha apagava a própria pergunta)", () => {
  it("preserva pergunta + status, grava o passo e devolve o bloqueio ainda aberto", () => {
    const id = seedRunningHandoff();
    call("handoff_ask", { handoffId: id, question: "posso trocar o schema?" });
    const res = call<{
      status: string;
      currentStep: string | null;
      pendingQuestion?: string | null;
      note?: string;
    }>("handoff_progress", { handoffId: id, step: "seguindo pelo caminho A" });

    expect(res.status).toBe("needs_input");
    expect(res.currentStep).toBe("seguindo pelo caminho A");
    expect(res.pendingQuestion).toBe("posso trocar o schema?");
    expect(res.note).toMatch(/ABERTA/);

    // E a mãe, ao polar, continua vendo a pergunta.
    const polled = call<{ status: string; pendingQuestion: string | null }>(
      "handoff_result",
      {
        handoffId: id,
      },
    );
    expect(polled.status).toBe("needs_input");
    expect(polled.pendingQuestion).toBe("posso trocar o schema?");
  });

  it("handoff_message (resposta da mãe) é o que encerra: needs_input → running", () => {
    const id = seedRunningHandoff();
    call("handoff_ask", { handoffId: id, question: "posso trocar o schema?" });
    call("handoff_progress", { handoffId: id, step: "ainda esperando" });
    call("handoff_message", { handoffId: id, text: "pode sim" });

    const polled = call<{
      status: string;
      pendingQuestion: string | null;
      currentStep: string;
    }>("handoff_result", { handoffId: id });
    expect(polled.status).toBe("running");
    expect(polled.pendingQuestion).toBeNull();
    expect(polled.currentStep).toBe("ainda esperando");
  });
});

describe("handoff_report duplicado", () => {
  it("avisa e preserva o resultado original em vez de sumir em silêncio", () => {
    const id = seedRunningHandoff();
    const first = call<{ status: string; duplicate?: boolean }>(
      "handoff_report",
      {
        handoffId: id,
        summary: "resultado original",
      },
    );
    expect(first.duplicate).toBeUndefined();

    const second = call<{
      status: string;
      duplicate?: boolean;
      warning?: string;
    }>("handoff_report", { handoffId: id, summary: "resultado repetido" });
    expect(second.status).toBe("done");
    expect(second.duplicate).toBe(true);
    expect(second.warning).toMatch(/já havia sido reportado/);
    expect(handoffStore.get(id)?.summary).toBe("resultado original");
  });
});

describe("handoff_result (enriquecido com atividade ao vivo)", () => {
  it("inclui liveStatus/lastText/tokens e pendingQuestion", () => {
    const id = seedRunningHandoff();
    handoffStore.ask(id, "minha pergunta");
    const res = call<{
      status: string;
      pendingQuestion: string | null;
      liveStatus: string | null;
      lastText: string | null;
      tokens: { output: number; context: number } | null;
    }>("handoff_result", { handoffId: id });
    expect(res.status).toBe("needs_input");
    expect(res.pendingQuestion).toBe("minha pergunta");
    expect(res.liveStatus).toBe("working");
    expect(res.lastText).toBe("editando arquivo");
    expect(res.tokens).toEqual({ output: 10, context: 200 });
  });
});

// Regressão: depois da passagem de bastão a ANTECESSORA continua viva com o
// handoffId antigo no contexto dela. Quando ela fecha o próprio turno chamando
// handoff_report, fecharia o card de um trabalho que agora é da SUCESSORA.
describe("posse do handoff (antecessora do bastão não fala pelo handoff)", () => {
  it("handoff_report da antecessora é RECUSADO e o handoff continua vivo", () => {
    const id = seedRunningHandoff("s-sucessora");
    expect(() =>
      callAs("s-antecessora", "handoff_report", {
        handoffId: id,
        summary: "terminei",
      }),
    ).toThrow(/já não é seu/);
    expect(handoffStore.get(id)!.status).toBe("running");
    expect(handoffStore.get(id)!.summary).toBeNull();
  });

  it("a recusa explica o que houve (passou o bastão) e para onde falar", () => {
    const id = seedRunningHandoff("s-sucessora");
    expect(() =>
      callAs("s-antecessora", "handoff_report", {
        handoffId: id,
        summary: "terminei",
      }),
    ).toThrow(/bastão[\s\S]*SendMessage/);
  });

  it("handoff_progress e handoff_ask da antecessora também são recusados", () => {
    const id = seedRunningHandoff("s-sucessora");
    expect(() =>
      callAs("s-antecessora", "handoff_progress", { handoffId: id, step: "x" }),
    ).toThrow(/já não é seu/);
    expect(() =>
      callAs("s-antecessora", "handoff_ask", { handoffId: id, question: "q" }),
    ).toThrow(/já não é seu/);
    const h = handoffStore.get(id)!;
    expect(h.status).toBe("running");
    expect(h.currentStep).toBeNull();
    expect(h.pendingQuestion).toBeNull();
  });

  it("a filha ATUAL reporta normalmente", () => {
    const id = seedRunningHandoff("s-sucessora");
    const res = callAs<{ status: string }>("s-sucessora", "handoff_report", {
      handoffId: id,
      summary: "feito",
    });
    expect(res.status).toBe("done");
  });

  // Retrocompat: sem uma das duas identidades não há como distinguir "sessão
  // legada" de "passou o bastão" — e recusar aí quebraria handoffs em curso.
  it("chamador SEM carimbo (config MCP global/legada) segue funcionando", () => {
    const id = seedRunningHandoff("s-sucessora");
    const res = callAs<{ status: string }>(null, "handoff_report", {
      handoffId: id,
      summary: "feito por sessão legada",
    });
    expect(res.status).toBe("done");
  });

  it("handoff SEM filha atrelada aceita de qualquer sessão carimbada", () => {
    const h = handoffStore.create({
      targetRepoId: "r1",
      task: "t",
      composedPrompt: "p",
    });
    handoffStore.approve(h.id, {});
    const res = callAs<{ status: string }>("s-qualquer", "handoff_report", {
      handoffId: h.id,
      summary: "feito",
    });
    expect(res.status).toBe("done");
  });
});
