import { describe, it, expect } from "vitest";

import {
  lintTexto,
  margens,
  temBloqueio,
  type ToneLintResult,
  type ToneSpec,
} from "./tone-lint";

// ---------------------------------------------------------------- fixtures
//
// Port de `atelier/cli/lint-script.test.mjs`. Lá as fixtures moravam em disco
// porque o lint resolvia a cascata de tons a partir de um ateliê montado num
// tmpdir. Aqui o tom chega como objeto (coluna JSON do contrato), então a
// fixture é constante: sem mkdtemp, sem I/O.
//
// TONE_FIXTURE REPETE os regexes do tom real de propósito. Os testes de mecânica
// (linha, coluna, severidade) não podem depender do tom de verdade: mexer numa
// regra do contrato não pode quebrar uma asserção de coluna.

const TONE_FIXTURE: ToneSpec = {
  id: "fixture-tone",

  tone_words: ["você", "na prática"],
  densidade_tone_words_min_por_100_palavras: 3,

  anti_tone_words: ["mergulhar", "elevar", "vale ressaltar"],

  hard_rules: [
    {
      id: "sem-travessao",
      regra: "Nenhum travessão ou em dash no roteiro.",
      check: "regex: [—–]",
      severidade: "bloqueante",
    },
    {
      id: "sem-triade",
      regra: "Nenhuma tríade do tipo 'X, Y e Z'.",
      check: String.raw`regex: \b[\wÀ-ÿ]+,\s+[\wÀ-ÿ]+\s+e\s+[\wÀ-ÿ]+\b`,
      severidade: "bloqueante",
    },
    {
      id: "sem-exclamacao",
      regra: "Zero pontos de exclamação.",
      check: "regex: !",
      severidade: "bloqueante",
    },
    {
      id: "sem-emoji",
      regra: "Zero emoji no roteiro.",
      check: String.raw`regex: [\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]`,
      severidade: "bloqueante",
    },
    {
      id: "sem-caixa-alta",
      regra: "Nenhuma palavra inteira em caixa alta com mais de 3 letras.",
      check: String.raw`regex: \b[A-ZÀ-Ý]{4,}\b`,
      severidade: "bloqueante",
    },
    {
      id: "sem-anti-tone-words",
      regra: "Nenhum item de anti_tone_words aparece no roteiro.",
      check: "busca literal, case-insensitive, de cada item da lista",
      severidade: "bloqueante",
    },
    {
      id: "frase-curta",
      regra: "Nenhuma frase com mais de 24 palavras.",
      check: "split por [.!?] e contagem de tokens por frase",
      threshold: 24,
      severidade: "bloqueante",
    },
    {
      id: "media-de-frase",
      regra: "Média de palavras por frase entre 8 e 16.",
      check: "total de palavras / número de frases",
      threshold_min: 8,
      threshold_max: 16,
      severidade: "aviso",
    },
    {
      id: "variacao-de-frase",
      regra: "Desvio-padrão do comprimento das frases de no mínimo 4 palavras.",
      check: "stdev do vetor de comprimentos de frase",
      threshold: 4.0,
      n_minimo_frases: 20,
      severidade: "aviso",
    },
    {
      id: "abertura-nao-pergunta",
      regra: "A primeira frase do roteiro não pode ser uma pergunta.",
      check: "primeira frase termina com ?",
      severidade: "bloqueante",
    },
    {
      id: "segunda-pessoa",
      regra: "O roteiro usa 'você' pelo menos uma vez a cada 60 palavras.",
      check: "contagem de 'você'/'te'/'sua'/'seu' sobre total de palavras",
      threshold_palavras_por_ocorrencia: 60,
      severidade: "aviso",
    },
  ],
};

// O tom REAL e calibrado do ateliê (`studio/tone/didatico-acolhedor.yaml`),
// transcrito como objeto — é o equivalente JSON do que o contrato guarda em
// `tone`. Os testes de calibração afirmam exatamente sobre ele: que o parágrafo
// canônico escrito à mão passa nas regras escritas à mão.
const TONE_CANONICO: ToneSpec = {
  id: "didatico-acolhedor",

  tone_words: [
    "você",
    "a gente",
    "faz sentido",
    "repara",
    "o que trava",
    "na prática",
    "o pulo do gato",
    "vale a pena",
    "por isso",
    "o ponto é",
  ],
  densidade_tone_words_min_por_100_palavras: 3,

  anti_tone_words: [
    "mergulhar",
    "desvendar",
    "desbloquear",
    "jornada",
    "elevar",
    "revolucionar",
    "transformar completamente",
    "no mundo de hoje",
    "nos dias atuais",
    "em um mundo cada vez mais",
    "é importante notar",
    "vale ressaltar",
    "em suma",
    "em resumo",
    "por fim",
    "além disso",
    "no entanto",
    "portanto",
    "game changer",
    "insight",
    "poderoso",
    "robusto",
    "impactante",
    "essencial",
    "crucial",
    "fundamental",
    "não é apenas",
    "prepare-se",
    "spoiler",
  ],

  hard_rules: [
    {
      id: "sem-travessao",
      regra: "Nenhum travessão ou em dash no roteiro.",
      check: "regex: [—–]",
      porque:
        "Travessão é o marcador tipográfico mais associado a texto de LLM, e em narração ele não existe: ninguém fala um travessão. Onde ele apareceria, cabe ponto final, dois pontos ou vírgula.",
      severidade: "bloqueante",
    },
    {
      id: "sem-triade",
      regra: "Nenhuma tríade do tipo 'X, Y e Z'.",
      check: String.raw`regex: \b[\wÀ-ÿ]+,\s+[\wÀ-ÿ]+\s+e\s+[\wÀ-ÿ]+\b`,
      porque:
        "A tríade é o ritmo default de modelo de linguagem: três itens, o terceiro redundante. Em narração ela ainda soa a lista lida em voz alta. Falso positivo possível (frase legítima com vírgula antes de 'e'); por isso a saída do lint mostra o trecho para conferência humana rápida.",
      severidade: "bloqueante",
    },
    {
      id: "sem-exclamacao",
      regra: "Zero pontos de exclamação.",
      check: "regex: !",
      porque:
        "Exclamação é entusiasmo declarado. Este tom está em 3 no eixo, e não em 5.",
      severidade: "bloqueante",
    },
    {
      id: "sem-emoji",
      regra: "Zero emoji no roteiro.",
      check: String.raw`regex: [\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]`,
      porque:
        "Emoji não é narrável e a legenda queimada herda o roteiro literalmente.",
      severidade: "bloqueante",
    },
    {
      id: "sem-caixa-alta",
      regra: "Nenhuma palavra inteira em caixa alta com mais de 3 letras.",
      check: String.raw`regex: \b[A-ZÀ-Ý]{4,}\b`,
      porque:
        "Ênfase por caixa alta quebra o cálculo de largura da legenda (o avanço médio de 0.55em assume caixa mista) e a linha estoura a safe area. Siglas de até 3 letras passam.",
      severidade: "bloqueante",
    },
    {
      id: "sem-anti-tone-words",
      regra: "Nenhum item de anti_tone_words aparece no roteiro.",
      check: "busca literal, case-insensitive, de cada item da lista",
      severidade: "bloqueante",
    },
    {
      id: "frase-curta",
      regra: "Nenhuma frase com mais de 24 palavras.",
      check: "split por [.!?] e contagem de tokens por frase",
      porque:
        "Frase longa é o que quebra a narração: a locução fica sem pausa por mais de 12 segundos (ver studio/voices/*.ritmo.max_fala_continua_s) e a legenda gera páginas que estouram max_chars_por_pagina.",
      threshold: 24,
      severidade: "bloqueante",
    },
    {
      id: "media-de-frase",
      regra: "Média de palavras por frase entre 8 e 16.",
      check: "total de palavras / número de frases",
      porque:
        "O piso importa tanto quanto o teto: só frases curtas produz o ritmo staccato de post motivacional. A variação é o que soa humano.",
      threshold_min: 8,
      threshold_max: 16,
      severidade: "aviso",
    },
    {
      id: "variacao-de-frase",
      regra: "Desvio-padrão do comprimento das frases de no mínimo 4 palavras.",
      check: "stdev do vetor de comprimentos de frase",
      porque:
        "Esta é a métrica que pega o texto de LLM que passou em todas as outras: frases todas do mesmo tamanho. Humano varia; modelo regride à média.",
      threshold: 4,
      // Calibrado por medição, e não por gosto: bootstrap de 200k amostras da
      // distribuição do parágrafo canônico (σ real 5.01) reprova 10.2% dos
      // roteiros BONS em n=12 (tamanho de um Short) contra 4.1% em n=20.
      n_minimo_frases: 20,
      severidade: "aviso",
    },
    {
      id: "abertura-nao-pergunta",
      regra: "A primeira frase do roteiro não pode ser uma pergunta.",
      check: "primeira frase termina com ?",
      porque:
        "Pergunta retórica de abertura é a estrutura mais reciclada de vídeo curto, e o espectador já aprendeu a rolar a tela nela.",
      severidade: "bloqueante",
    },
    {
      id: "segunda-pessoa",
      regra: "O roteiro usa 'você' pelo menos uma vez a cada 60 palavras.",
      check: "contagem de 'você'/'te'/'sua'/'seu' sobre total de palavras",
      threshold_palavras_por_ocorrencia: 60,
      severidade: "aviso",
    },
  ],

  // Bloco literal do YAML: as quebras de linha fazem parte do exemplar e as
  // métricas medidas à mão dependem delas.
  paragrafo_canonico:
    "Você já sabe o que precisa fazer. O que trava é a ordem.\n" +
    "Quando a tarefa aparece inteira de uma vez, seu cérebro escolhe a parte mais\n" +
    "fácil e ignora o resto. Por isso a gente vai começar pelo pedaço que dá medo.\n" +
    "Não porque sofrer ajuda, e sim porque o pedaço que dá medo é o que carrega a\n" +
    "informação. Depois que ele sai do caminho, o resto vira execução.\n",
};

/** Só as violações de uma regra — evita que um teste focado veja aviso de ritmo. */
const so = (out: ToneLintResult, id: string) =>
  out.violacoes.filter((v) => v.id === id);

const lint = (md: string): ToneLintResult => lintTexto(md, TONE_FIXTURE);

// ---------------------------------------------------------------- calibração
//
// O teste que manda em todos os outros: o exemplar canônico, contra o tom real.

describe("calibração contra o exemplar canônico", () => {
  it("o parágrafo canônico do tom real passa em todas as hard rules", () => {
    const out = lintTexto(TONE_CANONICO.paragrafo_canonico!, TONE_CANONICO);

    expect(out.violacoes.map((v) => `${v.id}: ${v.mensagem}`)).toEqual([]);
    // toda hard_rule do tom precisa ter implementação; regra ignorada em
    // silêncio é pior que regra ausente
    expect(out.naoImplementadas).toEqual([]);
    // o próprio exemplar tem 6 frases: fica abaixo do n mínimo de
    // variacao-de-frase, e o lint diz isso em vez de calar. É o caso que
    // motivou a calibragem.
    expect(out.puladas.map((p) => p.id)).toEqual(["variacao-de-frase"]);
  });

  it("as métricas do exemplar batem com a medição à mão do autor", () => {
    const { metricas } = lintTexto(
      TONE_CANONICO.paragrafo_canonico!,
      TONE_CANONICO,
    );

    // didatico-acolhedor.yaml, comentário do rodapé:
    // "6 frases, comprimentos 7 / 6 / 19 / 11 / 18 / 10 palavras. total 71 |
    //  média 11.8 | desvio 5.0 | maior frase 19 | 'você'+'seu' 2x em 71 palavras"
    expect(metricas.comprimentos).toEqual([7, 6, 19, 11, 18, 10]);
    expect(metricas.palavras).toBe(71);
    expect(metricas.frases).toBe(6);
    expect(metricas.maiorFrase).toBe(19);
    expect(metricas.media.toFixed(1)).toBe("11.8");
    expect(metricas.desvio.toFixed(1)).toBe("5.0");
    expect(metricas.segundaPessoa?.ocorrencias).toBe(2);
  });

  it("o exemplar passa com folga positiva em cada limiar estatístico", () => {
    const { metricas } = lintTexto(
      TONE_CANONICO.paragrafo_canonico!,
      TONE_CANONICO,
    );

    const folgas = Object.fromEntries(
      margens(TONE_CANONICO, metricas).map((m) => [m.id, m.folga]),
    );
    for (const [id, folga] of Object.entries(folgas)) {
      expect(
        folga,
        `${id} passou raspando ou reprovou (folga ${folga})`,
      ).toBeGreaterThan(0);
    }
    // A menor folga relativa é a de `variacao-de-frase`: 5.01 contra piso 4.0.
    // Um limiar que o texto bom passa raspando vira falso positivo em produção.
    expect(folgas["variacao-de-frase"]).toBeLessThan(1.5);
  });
});

// ---------------------------------------------------------------- regex

describe("regras de regex", () => {
  it("travessão é pego com linha e coluna exatas", () => {
    //          1234567890123456789
    // linha 2: Segunda linha com — travessão no meio.
    const md =
      "Primeira frase curta aqui.\nSegunda linha com — travessão no meio.\n";
    const [v] = so(lint(md), "sem-travessao");

    expect(v.linha).toBe(2);
    expect(v.coluna).toBe(19);
    expect(md.split("\n")[1][v.coluna - 1]).toBe("—");
    expect(v.bloqueante).toBe(true);
    expect(v.trecho).toMatch(/—/);
  });

  it("en dash também é pego (o regex do tom cobre os dois)", () => {
    const out = lint("Frase de abertura normal.\nAqui vai um – en dash.\n");
    expect(so(out, "sem-travessao")).toHaveLength(1);
  });

  it("tríade 'X, Y e Z' é pega com a coluna do primeiro termo", () => {
    //        1234567890123456789012
    //        Você precisa de clareza, ritmo e foco.
    const md = "Você precisa de clareza, ritmo e foco.\n";
    const [v] = so(lint(md), "sem-triade");

    expect(v.linha).toBe(1);
    expect(v.coluna).toBe(17);
    expect(md.slice(v.coluna - 1, v.coluna + 6)).toBe("clareza");
    expect(v.bloqueante).toBe(true);
  });

  it("exclamação, caixa alta e emoji são pegos", () => {
    const out = lint(
      "Isso muda o resultado agora!\nO ponto é OUTRO 🚀 aqui.\n",
    );

    expect(so(out, "sem-exclamacao")).toHaveLength(1);
    expect(so(out, "sem-caixa-alta")[0].trecho.includes("OUTRO")).toBe(true);
    expect(so(out, "sem-emoji")).toHaveLength(1);
    expect(so(out, "sem-emoji")[0].linha).toBe(2);
  });

  it("sigla de até 3 letras passa em sem-caixa-alta", () => {
    const out = lint("O RH da empresa pediu um novo fluxo de entrada.\n");
    expect(so(out, "sem-caixa-alta")).toEqual([]);
  });
});

// ---------------------------------------------------------------- vocabulário

describe("vocabulário", () => {
  it("anti_tone_word é pega sem depender de caixa", () => {
    const out = lint("A gente não vai Mergulhar nisso agora, e sim testar.\n");
    const [v] = so(out, "sem-anti-tone-words");

    expect(v.mensagem.includes("mergulhar")).toBe(true);
    expect(v.linha).toBe(1);
    expect(v.coluna).toBe(17);
  });

  it("anti_tone_word não dispara dentro de outra palavra", () => {
    // "relevar" contém "elevar"; a fronteira de palavra é o que separa os dois
    const out = lint("Não dá para relevar esse detalhe do processo agora.\n");
    expect(so(out, "sem-anti-tone-words")).toEqual([]);
  });

  it("anti_tone_word de duas palavras sobrevive à quebra de linha", () => {
    const out = lint(
      "O ponto aqui é curto. Vale\nressaltar que o resto segue.\n",
    );
    expect(so(out, "sem-anti-tone-words")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- estrutura

describe("estrutura e ritmo", () => {
  it("abertura em pergunta é pega na primeira frase", () => {
    const out = lint(
      "Você já tentou fazer isso de outro jeito?\nO resto vira execução.\n",
    );
    const [v] = so(out, "abertura-nao-pergunta");

    expect(v.linha).toBe(1);
    expect(v.coluna).toBe(1);
    expect(v.bloqueante).toBe(true);
  });

  it("pergunta fora da abertura não é violação", () => {
    const out = lint(
      "O ponto é a ordem das coisas. Você já tentou o inverso?\n",
    );
    expect(so(out, "abertura-nao-pergunta")).toEqual([]);
  });

  it("frase acima do teto é pega, apontando para o início da frase", () => {
    const curta = "Você já sabe o que fazer.";
    const longa =
      "Quando a tarefa aparece inteira de uma vez o seu cérebro escolhe a parte " +
      "mais fácil e ignora todo o resto do que precisa mesmo ser feito hoje.";
    const md = `${curta} ${longa}\n`;
    const [v] = so(lint(md), "frase-curta");

    expect(v.linha).toBe(1);
    expect(v.coluna).toBe(curta.length + 2);
    expect(v.mensagem).toMatch(/^frase com 28 palavras \(teto 24\)$/);
    expect(v.bloqueante).toBe(true);
  });

  it("severidade aviso não é bloqueio", () => {
    // duas frases curtas: média 5.5, abaixo do piso 8
    const out = lint("O ponto é a ordem. O resto vira execução.\n");

    expect(out.violacoes.map((v) => v.id)).toContain("media-de-frase");
    expect(out.violacoes.every((v) => v.bloqueante === false)).toBe(true);
    expect(temBloqueio(out.violacoes)).toBe(false);
  });

  it("segunda-pessoa só avisa acima do limiar de palavras por ocorrência", () => {
    const semPronome = `${"O ponto é a ordem das coisas do dia. ".repeat(8)}\n`;
    expect(
      lint(semPronome).violacoes.some((v) => v.id === "segunda-pessoa"),
    ).toBe(true);

    const comPronome = `${"Você já sabe qual é a ordem das coisas. ".repeat(8)}\n`;
    expect(
      lint(comPronome).violacoes.some((v) => v.id === "segunda-pessoa"),
    ).toBe(false);
  });
});

// ------------------------------------------------- amostra mínima (calibragem)
//
// `variacao-de-frase` só opina com n >= 20 frases. Em n=12 (tamanho de um Short)
// o bootstrap mede 10.2% de falso positivo contra 4.1% em n=20.

describe("amostra mínima de variacao-de-frase", () => {
  it("roteiro curto não dispara variacao-de-frase, e o skip fica registrado", () => {
    // 10 frases idênticas: desvio 0, reprovaria com folga de sobra se a regra rodasse
    const out = lint(`${"O ponto aqui é a ordem. ".repeat(10)}\n`);

    expect(out.metricas.frases).toBe(10);
    expect(out.metricas.desvio).toBe(0);
    expect(out.violacoes.filter((v) => v.id === "variacao-de-frase")).toEqual(
      [],
    );

    const [pulada] = out.puladas;
    expect(pulada.id).toBe("variacao-de-frase");
    expect(pulada.motivo).toMatch(/10 frases abaixo do mínimo de 20/);
  });

  it("roteiro com n >= 20 e variação baixa dispara normalmente", () => {
    const out = lint(`${"O ponto aqui é a ordem. ".repeat(22)}\n`);

    expect(out.metricas.frases).toBe(22);
    expect(out.puladas).toEqual([]);

    const [v] = out.violacoes.filter((x) => x.id === "variacao-de-frase");
    expect(v.mensagem).toMatch(/desvio-padrão de 0\.00 palavras \(mínimo 4\)/);
    expect(v.bloqueante).toBe(false);
  });

  it("a margem marca variacao-de-frase como não aplicada abaixo do n mínimo", () => {
    const curto = lint(`${"O ponto aqui é a ordem. ".repeat(10)}\n`);
    const longo = lint(`${"O ponto aqui é a ordem. ".repeat(22)}\n`);

    const pega = (out: ToneLintResult) =>
      margens(TONE_FIXTURE, out.metricas).find(
        (x) => x.id === "variacao-de-frase",
      )?.aplicada;
    expect(pega(curto)).toBe(false);
    expect(pega(longo)).toBe(true);
  });

  it("tom sem n_minimo_frases pula a regra em vez de rodá-la em amostra pequena", () => {
    // O contrato é editável por LLM: se o campo cair, a regra voltaria a reprovar
    // ~10% dos textos bons. Campo ausente é skip explícito, nunca "roda".
    const semAmostraMinima: ToneSpec = {
      ...TONE_FIXTURE,
      hard_rules: TONE_FIXTURE.hard_rules!.map((r) =>
        r.id === "variacao-de-frase" ? { ...r, n_minimo_frases: undefined } : r,
      ),
    };
    const out = lintTexto(
      `${"O ponto aqui é a ordem. ".repeat(22)}\n`,
      semAmostraMinima,
    );

    expect(out.violacoes.filter((v) => v.id === "variacao-de-frase")).toEqual(
      [],
    );
    expect(out.puladas.map((p) => p.id)).toEqual(["variacao-de-frase"]);
    expect(out.puladas[0].motivo).toMatch(/`n_minimo_frases` ausente/);
    expect(out.naoImplementadas).toEqual([]);
    expect(
      margens(semAmostraMinima, out.metricas).find(
        (m) => m.id === "variacao-de-frase",
      )?.aplicada,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- markdown

describe("o que não é narração não é lintado", () => {
  it("título, bloco de código e comentário HTML não são narração", () => {
    const md = [
      "# Roteiro — abertura",
      "",
      "## Shot 01 — PLANO ABERTO",
      "",
      "<!-- nota do autor: mergulhar aqui seria terrível -->",
      "",
      "Você já sabe o que precisa fazer agora. O que trava é sempre a ordem.",
      "",
      "```",
      "const traco = '—'; // MAIÚSCULAS e emoji 🚀",
      "```",
      "",
    ].join("\n");

    // o travessão, as maiúsculas, o emoji e a anti_tone_word estão TODOS em
    // região mascarada; sobram só os avisos de ritmo das duas frases de prosa
    const out = lint(md);
    expect(out.violacoes.filter((v) => v.bloqueante).map((v) => v.id)).toEqual(
      [],
    );
  });

  it("bullet É narração e continua sendo lintado", () => {
    const md =
      "- Você precisa de clareza, ritmo e foco.\n- O resto vem depois disso.\n";
    expect(so(lint(md), "sem-triade")).toHaveLength(1);
  });

  it("linha em branco fecha frase (bullet sem ponto final não vira frase gigante)", () => {
    const md = "- primeiro item da lista\n\n- segundo item da lista\n";
    expect(lint(md).metricas.comprimentos).toEqual([4, 4]);
  });
});

// ---------------------------------------------------------------- honestidade

describe("honestidade do lint", () => {
  it("regra sem implementação é reportada, não ignorada em silêncio", () => {
    const tone: ToneSpec = {
      id: "t",
      hard_rules: [
        { id: "regra-do-futuro", regra: "algo novo", severidade: "bloqueante" },
        { id: "frase-curta", regra: "sem threshold", severidade: "bloqueante" },
      ],
    };
    const out = lintTexto("Uma frase qualquer aqui.\n", tone);

    expect(out.naoImplementadas).toEqual([
      { id: "regra-do-futuro", motivo: "sem implementação" },
      { id: "frase-curta", motivo: "campo `threshold` ausente" },
    ]);
  });

  it("o caso que deve reprovar: travessão bloqueante na linha 1, coluna 26", () => {
    const out = lint("Você já sabe o que fazer — e não faz.\n");
    const bloqueantes = out.violacoes.filter((v) => v.bloqueante);

    expect(bloqueantes).toHaveLength(1);
    expect(bloqueantes[0].id).toBe("sem-travessao");
    expect(bloqueantes[0].severidade).toBe("bloqueante");
    expect(bloqueantes[0].linha).toBe(1);
    expect(bloqueantes[0].coluna).toBe(26);
    expect(bloqueantes[0].path).toBe("tone.hard_rules.0.id");
    // a proveniência do YAML sumiu junto com a cascata: aqui ela é a versão do contrato
    expect(bloqueantes[0].from).toBeNull();
    expect(temBloqueio(out.violacoes)).toBe(true);
  });
});
