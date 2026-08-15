import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GATE_REGISTRY,
  runGate,
  type GateExecutor,
  type GateInput,
} from "./content-gates";
import type { ContentContract } from "../../../shared/types/ipc";

// Cada gate precisa do caso que DEVE reprovar — um registry que só sabe aprovar
// é decoração. Os casos que passam existem para provar que a reprovação vem do
// material, e não de o gate reprovar tudo.

const CONTRATO_BASE: ContentContract = {
  id: "c1",
  slug: "inss-orientacao",
  title: "Orientação a requerentes",
  status: "active",
  version: 3,
  outputLabel: "roteiro",
  audience: {
    who: "requerente do INSS",
    notWho: ["advogado", "servidor do INSS"],
    situation: null,
    assumptions: [],
  },
  ethicalLine: [],
  allowedFacts: [],
  forbiddenFacts: [
    {
      id: "bpc-vitalicio",
      claim: "o BPC é vitalício",
      forms: ["BPC é vitalício", "benefício vitalício"],
      neutralForm: "o BPC é revisto periodicamente",
      reason: "a revisão bienal existe",
      status: "proibido",
      statusChangedAt: null,
      appliesTo: null,
    },
    {
      id: "carencia-12-meses",
      claim: "sempre há carência de 12 meses",
      forms: ["carência de 12 meses"],
      neutralForm: "a carência depende do benefício",
      reason: null,
      status: "proibido",
      statusChangedAt: null,
      // vale só na trilha de incapacidade: no BPC não há carência nenhuma
      appliesTo: ["incapacidade"],
    },
    {
      id: "ja-conferido",
      claim: "a perícia pode ser remarcada",
      forms: ["pode ser remarcada"],
      neutralForm: "a remarcação segue as regras do INSS",
      reason: "conferido contra fonte primária: se sustenta",
      status: "liberado",
      statusChangedAt: 1,
      appliesTo: null,
    },
  ],
  outOfScope: [
    {
      id: "peticao-inicial",
      item: "redigir a petição inicial",
      owner: "a equipe jurídica",
      forms: ["petição inicial"],
      question: "o roteiro orienta o requerente a redigir a petição?",
    },
    {
      id: "calculo-rmi",
      item: "calcular a RMI",
      owner: "o cálculo",
      forms: ["calcular a RMI"],
      question: "o roteiro promete um valor calculado?",
    },
  ],
  tone: {
    // snake_case porque é a grafia única do spec (a mesma do YAML do atelier e
    // da coluna JSON) — não existe mais adaptador de grafia no meio.
    hard_rules: [
      {
        id: "sem-travessao",
        regra: "Nenhum travessão ou en dash no roteiro.",
        check: "regex: [—–]",
        severidade: "bloqueante",
      },
      {
        id: "sem-exclamacao",
        regra: "Zero pontos de exclamação.",
        check: "regex: !",
        severidade: "aviso",
      },
    ],
    anti_tone_words: ["mergulhar"],
    paragrafo_canonico: "",
  },
  deliveryLimits: [
    {
      channel: "reels",
      maxBytes: 1024,
      maxDurationSec: 90,
      notes: null,
    },
    {
      channel: "youtube",
      maxBytes: null,
      maxDurationSec: null,
      notes: "sem teto declarado",
    },
  ],
  sourcePrecedence: [],
  productionInvariants: [],
  createdAt: 1,
  updatedAt: 2,
};

const entrada = (extra: Partial<GateInput>): GateInput => ({
  contract: CONTRATO_BASE,
  material: "",
  ...extra,
});

// ---------------------------------------------------------------- forbidden-facts

describe("forbidden-facts", () => {
  it("reprova material com forma proibida e mostra o trecho e a forma neutra", () => {
    const r = runGate(
      "forbidden-facts",
      entrada({
        material:
          "Muita gente acha que o BPC é vitalício.\nNa prática existe revisão.\n",
      }),
    );

    expect(r.passed).toBe(false);
    expect(r.blocking).toBe(true);
    expect(r.status).toBe("failed");
    expect(r.evidence).toContain("BPC é vitalício");
    expect(r.evidence).toContain("o BPC é revisto periodicamente");
    expect(r.evidence).toContain("L1:");
  });

  it("aprova material limpo e ignora fato já liberado", () => {
    const r = runGate(
      "forbidden-facts",
      entrada({
        material: "A perícia pode ser remarcada pelo canal oficial.\n",
      }),
    );

    expect(r.passed).toBe(true);
    expect(r.blocking).toBe(false);
    expect(r.details.naoAplicaveis).toContainEqual({
      id: "ja-conferido",
      status: "liberado",
    });
  });

  it("respeita appliesTo: o fato de outra trilha não se aplica", () => {
    const material = "Existe carência de 12 meses nesse caso.\n";

    const emBpc = runGate(
      "forbidden-facts",
      entrada({ material, track: "bpc" }),
    );
    expect(emBpc.passed).toBe(true);
    expect(emBpc.details.verificados).not.toContain("carencia-12-meses");

    const emIncapacidade = runGate(
      "forbidden-facts",
      entrada({ material, track: "incapacidade" }),
    );
    expect(emIncapacidade.passed).toBe(false);
    expect(emIncapacidade.blocking).toBe(true);
  });

  it("sem trilha declarada todo fato se aplica", () => {
    const r = runGate(
      "forbidden-facts",
      entrada({ material: "Existe carência de 12 meses nesse caso.\n" }),
    );
    expect(r.passed).toBe(false);
  });
});

// ---------------------------------------------------------------- scope

describe("scope", () => {
  it("reprova material que entra em item fora de escopo", () => {
    const r = runGate(
      "scope",
      entrada({
        material: "Depois disso você prepara a petição inicial sozinho.\n",
      }),
    );

    expect(r.passed).toBe(false);
    expect(r.blocking).toBe(true);
    expect(r.evidence).toContain("petição inicial");
    expect(r.evidence).toContain("a equipe jurídica");
  });

  it("aprova material que fica dentro do escopo", () => {
    const r = runGate(
      "scope",
      entrada({ material: "Leve os documentos no dia da perícia.\n" }),
    );
    expect(r.passed).toBe(true);
    expect(r.blocking).toBe(false);
  });
});

// ---------------------------------------------------------------- delivery-limit

describe("delivery-limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "pitwall-gates-"));
  const grande = join(dir, "grande.mp4");
  const pequeno = join(dir, "pequeno.mp4");
  writeFileSync(grande, Buffer.alloc(2048));
  writeFileSync(pequeno, Buffer.alloc(512));

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reprova arquivo acima do limite com os dois números na evidência", () => {
    const r = runGate(
      "delivery-limit",
      entrada({ material: grande, channel: "reels" }),
    );

    expect(r.passed).toBe(false);
    expect(r.blocking).toBe(true);
    expect(r.status).toBe("failed");
    expect(r.evidence).toContain("2048 B");
    expect(r.evidence).toContain("1024 B");
    expect(r.details.bytes).toBe(2048);
    expect(r.details.maxBytes).toBe(1024);
    // duração declarada não é medida aqui: exigiria processo externo
    expect(r.evidence).toContain("NÃO verificado");
  });

  it("aprova arquivo dentro do limite", () => {
    const r = runGate(
      "delivery-limit",
      entrada({ material: pequeno, channel: "reels" }),
    );
    expect(r.passed).toBe(true);
    expect(r.blocking).toBe(false);
    expect(r.status).toBe("passed");
    expect(r.details.folga).toBe(512);
  });

  it("recusa caminho relativo sem chamar statSync", () => {
    const r = runGate(
      "delivery-limit",
      entrada({ material: "out/grande.mp4", channel: "reels" }),
    );

    expect(r.status).toBe("error");
    expect(r.passed).toBe(false);
    expect(r.blocking).toBe(true);
    expect(r.evidence).toContain("caminho relativo recusado");
  });

  it("arquivo inexistente vira error, não exceção", () => {
    const r = runGate(
      "delivery-limit",
      entrada({ material: join(dir, "nao-existe.mp4"), channel: "reels" }),
    );

    expect(r.status).toBe("error");
    expect(r.blocking).toBe(true);
    expect(r.evidence).toContain("nao-existe.mp4");
  });

  it("canal sem limite de bytes é skipped, não aprovação silenciosa", () => {
    const r = runGate(
      "delivery-limit",
      entrada({ material: grande, channel: "youtube" }),
    );

    expect(r.status).toBe("skipped");
    expect(r.blocking).toBe(false);
    expect(r.evidence).toContain("não declara limite de bytes");
  });

  it("sem canal informado não mede nada", () => {
    const r = runGate("delivery-limit", entrada({ material: grande }));
    expect(r.status).toBe("skipped");
    expect(r.evidence).toContain("Nenhum canal informado");
  });
});

// ---------------------------------------------------------------- scope-checklist

describe("scope-checklist", () => {
  it("reprova quando falta resposta para um item", () => {
    const r = runGate(
      "scope-checklist",
      entrada({
        material: "roteiro",
        attestation: {
          answers: { "peticao-inicial": "não, o roteiro só orienta a juntada" },
        },
      }),
    );

    expect(r.passed).toBe(false);
    expect(r.blocking).toBe(true);
    expect(r.details.pendentes).toEqual(["calculo-rmi"]);
    expect(r.evidence).toContain("calculo-rmi");
  });

  it("reprova resposta em branco igual a resposta ausente", () => {
    const r = runGate(
      "scope-checklist",
      entrada({
        material: "roteiro",
        attestation: {
          answers: { "peticao-inicial": "   ", "calculo-rmi": "não" },
        },
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.details.pendentes).toEqual(["peticao-inicial"]);
  });

  it("sem atestação nenhuma reprova todos os itens", () => {
    const r = runGate("scope-checklist", entrada({ material: "roteiro" }));
    expect(r.passed).toBe(false);
    expect(r.details.pendentes).toEqual(["peticao-inicial", "calculo-rmi"]);
  });

  it("aprova quando todo item tem resposta", () => {
    const r = runGate(
      "scope-checklist",
      entrada({
        material: "roteiro",
        attestation: {
          answers: {
            "peticao-inicial": "não, o roteiro só orienta a juntada",
            "calculo-rmi": "não, nenhum valor é prometido",
          },
        },
      }),
    );

    expect(r.passed).toBe(true);
    expect(r.blocking).toBe(false);
    expect(r.status).toBe("passed");
  });
});

// ---------------------------------------------------------------- positive-evidence

describe("positive-evidence", () => {
  it("reprova output que afirma sucesso sem medir nada", () => {
    const r = runGate(
      "positive-evidence",
      entrada({
        material: "roteiro",
        attestation: { command: "ffprobe x.mp4", output: "funcionou" },
      }),
    );

    expect(r.passed).toBe(false);
    expect(r.blocking).toBe(true);
    expect(r.evidence).toContain("sem medir nada");
  });

  it("reprova quando falta o comando", () => {
    const r = runGate(
      "positive-evidence",
      entrada({
        material: "roteiro",
        attestation: { output: "duration=78.4" },
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("`command` vazio");
  });

  it("reprova output sem nenhuma medida literal", () => {
    const r = runGate(
      "positive-evidence",
      entrada({
        material: "roteiro",
        attestation: {
          command: "ffprobe x.mp4",
          output: "o arquivo abriu normalmente e parece certo",
        },
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("nenhum número");
  });

  it("aceita comando com output medido", () => {
    const r = runGate(
      "positive-evidence",
      entrada({
        material: "roteiro",
        attestation: {
          command: "ffprobe -show_entries format=duration x.mp4",
          output: "duration=78.400000",
        },
      }),
    );

    expect(r.passed).toBe(true);
    expect(r.blocking).toBe(false);
    expect(r.status).toBe("passed");
  });
});

// ---------------------------------------------------------------- tone-lint

describe("tone-lint", () => {
  it("travessão no material é bloqueante", () => {
    const r = runGate(
      "tone-lint",
      entrada({ material: "Você já sabe o que fazer — e não faz.\n" }),
    );

    expect(r.blocking).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("sem-travessao");
    expect(r.evidence).toContain("L1:26");
  });

  it("violação de severidade aviso não bloqueia a entrega", () => {
    const r = runGate(
      "tone-lint",
      entrada({ material: "Leve os documentos no dia!\n" }),
    );

    expect(r.passed).toBe(false);
    expect(r.blocking).toBe(false);
    expect(r.evidence).toContain("sem-exclamacao");
  });

  it("material limpo passa e traz métricas", () => {
    const r = runGate(
      "tone-lint",
      entrada({ material: "Leve os documentos no dia da perícia.\n" }),
    );

    expect(r.passed).toBe(true);
    expect(r.blocking).toBe(false);
    expect(r.details).toHaveProperty("metricas");
    expect(r.details).toHaveProperty("margens");
    expect(r.details).toHaveProperty("puladas");
  });
});

// ---------------------------------------------------------------- registry

describe("runGate", () => {
  it("despacha pelo registry, então trocar uma entrada por stub muda o veredito", () => {
    const original = GATE_REGISTRY.scope;
    const stub: GateExecutor = () => ({
      passed: false,
      blocking: true,
      evidence: "stub",
      details: { stub: true },
    });

    GATE_REGISTRY.scope = stub;
    try {
      const r = runGate("scope", entrada({ material: "material inofensivo" }));
      expect(r.evidence).toBe("stub");
      expect(r.details).toEqual({ stub: true });
    } finally {
      GATE_REGISTRY.scope = original;
    }

    expect(
      runGate("scope", entrada({ material: "material inofensivo" })).passed,
    ).toBe(true);
  });

  it("gate desconhecido vira error em vez de exceção", () => {
    const r = runGate("nao-existe" as never, entrada({ material: "x" }));
    expect(r.status).toBe("error");
    expect(r.blocking).toBe(true);
    expect(r.evidence).toContain("gate desconhecido");
  });
});
