import { launchApp } from "../driver/launch";
import { captureLogs, screenshot } from "../driver/capture";
import { waitReady } from "../driver/nav";

const { app, page } = await launchApp();
const { logFile, stop } = captureLogs(app, page);

function log(...a: unknown[]) {
  console.log("[scenario]", ...a);
}

try {
  await waitReady(page);
  await screenshot(page, "cc-00-boot");

  // 1. O ícone existe no IconRail?
  const rail = page.getByTitle("Conteúdo", { exact: true });
  const railVisible = await rail.isVisible();
  log("icone Conteudo visivel:", railVisible);

  // 2. Entrar na área e ver o estado vazio.
  await rail.click();
  await page.waitForTimeout(1200);
  await screenshot(page, "cc-01-empty");
  const emptyText = await page.locator("aside").first().innerText();
  log("sidebar (vazio):", JSON.stringify(emptyText.slice(0, 300)));
  const mainText = await page.locator("main").first().innerText();
  log("main (vazio):", JSON.stringify(mainText.slice(0, 200)));

  // 3. Semear um contrato via a bridge real (window.api -> IPC -> store).
  const seeded = await page.evaluate(async () => {
    const api = (window as any).api;
    if (!api?.contentContracts)
      return { error: "window.api.contentContracts ausente" };
    try {
      const v1 = await api.contentContracts.upsert({
        slug: "drive-validation",
        title: "Validação do drive-app",
        outputLabel: "Post de LinkedIn",
        status: "active",
        summary: "versão inicial",
        reason: "semear a área para validação visual",
        audience: {
          who: "Devs que avaliam a feature",
          notWho: ["Usuário final", "Jurídico"],
          situation: "Validação visual da área Conteúdo no app buildado",
          assumptions: ["O leitor já conhece o Pitwall"],
        },
        ethicalLine: [
          {
            id: "e1",
            rule: "Não prometer resultado processual",
            rationale: "Vedação da OAB",
          },
        ],
        allowedFacts: [
          {
            id: "a1",
            statement: "O BPC-LOAS é benefício assistencial",
            scope: "afirmavel",
            source: "Lei 8.742/93",
            appliesTo: null,
          },
        ],
        forbiddenFacts: [
          {
            id: "f1",
            claim: "Garantia de aprovação do benefício",
            forms: ["garantia de aprovação", "aprovação garantida"],
            neutralForm: "aumenta a chance de deferimento",
            reason: "Promessa de resultado é vedada",
            status: "proibido",
            statusChangedAt: null,
            appliesTo: null,
          },
        ],
        outOfScope: [
          {
            id: "o1",
            item: "Cálculo de RMI",
            owner: "Time de cálculo",
            forms: ["RMI", "renda mensal inicial"],
            question: "O material fala de cálculo de RMI?",
          },
        ],
        tone: {
          id: "tom-pitwall",
          tone_words: ["direto", "concreto"],
          anti_tone_words: ["revolucionário", "incrível"],
          densidade_tone_words_min_por_100_palavras: 2,
          hard_rules: [
            {
              id: "frase-curta",
              regra: "Frases de no máximo 25 palavras",
              severidade: "bloqueante",
              threshold: 25,
            },
          ],
          paragrafo_canonico:
            "Escreva como quem explica para um colega, sem adjetivo de venda.",
        },
        deliveryLimits: [
          {
            channel: "linkedin",
            maxBytes: 3000,
            maxDurationSec: null,
            notes: "limite do post",
          },
        ],
        sourcePrecedence: [
          { rank: 1, source: "Texto de lei", note: "fonte primária" },
          { rank: 2, source: "Jurisprudência vinculante", note: null },
        ],
        productionInvariants: [
          {
            id: "p1",
            invariant: "Toda afirmação factual cita fonte",
            rationale: "rastreabilidade",
          },
        ],
      });

      // Bump para gerar linha de changelog (v2).
      const v2 = await api.contentContracts.upsert({
        slug: "drive-validation",
        title: "Validação do drive-app",
        summary: "Endureci o limite de entrega do LinkedIn",
        reason: "O post estourava o corte do feed",
        deliveryLimits: [
          {
            channel: "linkedin",
            maxBytes: 2000,
            maxDurationSec: null,
            notes: "limite revisado",
          },
        ],
      });

      // Gate que REPROVA, pra ter evidência literal na lista de runs.
      const failed = await api.contentContracts.runGate({
        contractId: v2.id,
        gate: "forbidden-facts",
        material:
          "Nosso serviço oferece aprovação garantida do seu benefício em tempo recorde, com garantia de aprovação para todos os casos analisados pela equipe.",
        materialRef: "drive/post-linkedin.md",
        channel: "linkedin",
      });

      // Gate que PASSA, pra ver os dois estados na lista.
      const passed = await api.contentContracts.runGate({
        contractId: v2.id,
        gate: "tone-lint",
        material:
          "O BPC-LOAS é assistencial. O texto é direto e concreto. A fonte é a Lei 8.742/93.",
        materialRef: "drive/post-ok.md",
        channel: "linkedin",
      });

      return {
        v1Version: v1.version,
        v2Version: v2.version,
        contractId: v2.id,
        failedStatus: failed.status,
        failedEvidence: (failed.evidence ?? "").slice(0, 400),
        failedBlocking: failed.blockingCount,
        passedGate: passed.gate,
        passedStatus: passed.status,
      };
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) };
    }
  });
  log("seed:", JSON.stringify(seeded, null, 2));

  // 4. O broadcast deve recarregar a lista sozinho; dar tempo e clicar.
  await page.waitForTimeout(1500);
  await screenshot(page, "cc-02-list");

  const item = page
    .getByRole("button", { name: /Validação do drive-app/ })
    .first();
  if (await item.isVisible()) {
    await item.click();
    await page.waitForTimeout(1200);
    await screenshot(page, "cc-03-contract");

    const bodyText = await page.locator("main").first().innerText();
    log("main (preenchido) len:", bodyText.length);
    log("main (preenchido):", JSON.stringify(bodyText.slice(0, 2500)));

    // Rolar o painel do contrato até o fim pra ver o changelog.
    await page
      .locator("main section")
      .first()
      .evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
    await page.waitForTimeout(600);
    await screenshot(page, "cc-04-changelog");

    const tail = await page.locator("main").first().innerText();
    log("main tail:", JSON.stringify(tail.slice(-1500)));
  } else {
    log("ERRO: item do contrato nao apareceu na sidebar");
    const side = await page.locator("aside").first().innerText();
    log("sidebar apos seed:", JSON.stringify(side.slice(0, 400)));
  }

  log("logFile:", logFile);
} catch (err) {
  console.error("[scenario] FALHOU:", err);
  try {
    await screenshot(page, "cc-99-error");
  } catch {}
} finally {
  stop();
  await app.close();
}
