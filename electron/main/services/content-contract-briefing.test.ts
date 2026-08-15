import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrations } from "./migrations/index";
import { runGate } from "./content-gates";
import type {
  AllowedFact,
  ContentContract,
  CreateContentContractInput,
  ForbiddenFact,
} from "../../../shared/types/ipc";

// TESTE DE ACEITE DO SCHEMA — o briefing real contra o Content Contract.
//
// `~/Documentos/pre-pericia-videos/BRIEFING.md` é o contrato de produção real da
// série de vídeos pré-perícia do INSS, com todas as cicatrizes de duas rodadas de
// revisão. Este arquivo transcreve o briefing INTEIRO para o schema e falha se
// alguma coisa não couber. A regra do aceite: se o briefing não cabe, o errado é
// o schema — não o briefing.
//
// Fidelidade acima de elegância: nada foi resumido, "melhorado" ou inferido. Onde
// o briefing não dá um número (o teto de "frase curta", por exemplo), o campo
// fica ausente em vez de receber um chute — campo ausente o linter reporta como
// regra não aplicada; número inventado ele reprova texto bom.
//
// DUAS ARMADILHAS DE VOCABULÁRIO encontradas na transcrição, documentadas aqui
// porque uma transcrição ingênua inverteria o veredito do gate:
//
//  1. "CONFIRMADO 14/08" no briefing (linha da teleperícia, §4) quer dizer
//     "conferido contra a Portaria e CONFIRMADO VERDADEIRO — pode dizer". O
//     `status: 'confirmado-falso'` do schema quer dizer o oposto: a checagem confirmou
//     que a afirmação é FALSA, e por isso o fato continua bloqueando. Mapear a
//     palavra pela palavra faria o gate proibir exatamente o que o briefing
//     liberou. Mapeamento correto, por SENTIDO:
//       - linha tachada + LIBERADO/CONFIRMADO 14/08  -> status 'liberado'
//       - linha "NOVO 14/08" (afirmação que a checagem derrubou) -> 'confirmado-falso'
//       - linha sem marca de rodada -> 'proibido'
//
//  2. Duas linhas da §4 carregam DOIS vereditos na mesma célula (o assunto foi
//     liberado, mas uma forma específica continua proibida: "prorrogação" pode,
//     "até quinze dias antes" nunca). Uma linha da tabela vira dois fatos, porque
//     `status` é do fato inteiro — não dá para liberar e proibir a mesma row.

// ---- constantes de transcrição ----

// A rodada jurídica que reescreveu a §3 e a §4. O briefing só escreve "14/08"; o
// ano vem da própria §4, que cita norma de 2026 como vigente.
const RODADA_14_08 = Date.UTC(2026, 7, 14);

// O eixo de `appliesTo`. As duas primeiras são trilhas de vídeo (§6: V1-V4 são
// BPC, V5-V6 incapacidade); 'apoio-lia' não é trilha de vídeo nenhuma — é o
// rótulo do conhecimento da §3.4, verdadeiro mas fora de narração.
const TRILHA_BPC = "bpc";
const TRILHA_INCAPACIDADE = "incapacidade";
const TRILHA_APOIO = "apoio-lia";

// ---- §2: a linha ética ----

const LINHA_ETICA: CreateContentContractInput["ethicalLine"] = [
  // O objetivo declarado no topo da §2 é o eixo de tudo o que vem depois.
  {
    id: "eixo.perito-entende-a-realidade",
    rule: "O objetivo é o perito entender a realidade da limitação. Não é parecer pior do que se é.",
    rationale: "É o eixo do material: tudo o que segue deriva daqui.",
  },
  // PODE orientar
  {
    id: "pode.documentacao-organizada",
    rule: "Levar documentação organizada (mais antigo embaixo, laudo mais completo primeiro).",
    rationale: "Quem atende tem 10-15 min.",
  },
  {
    id: "pode.dia-comum",
    rule: "Contar o dia comum, não o melhor dia.",
    rationale: null,
  },
  {
    id: "pode.dizer-quando-hoje-e-dia-bom",
    rule: "Dizer quando hoje é um dia bom e descrever como são os outros.",
    rationale: "Isso dá credibilidade.",
  },
  {
    id: "pode.medida-no-lugar-de-adjetivo",
    rule: 'Trocar adjetivo por medida: "dói tudo" vira "ando uma quadra e paro".',
    rationale: null,
  },
  {
    id: "pode.nao-minimizar-por-vergonha",
    rule: "Não minimizar por vergonha.",
    rationale: null,
  },
  {
    id: "pode.acompanhante",
    rule: "Levar acompanhante; a pessoa responde primeiro, o acompanhante completa quando perguntado.",
    rationale: null,
  },
  {
    id: "pode.gastos-de-saude-e-barreiras",
    rule: "Relatar gastos de saúde e barreiras do bairro.",
    rationale: "São critério de avaliação, não desabafo.",
  },
  {
    id: "pode.comparecer-com-os-apoios",
    rule: "Comparecer com os apoios que usa (bengala, órtese, andador).",
    rationale: "O instrumento avalia o desempenho COM os apoios.",
  },
  // NUNCA orientar (nem sugerir, nem insinuar)
  {
    id: "nunca.exagerar-ou-encenar",
    rule: "Nunca orientar a exagerar ou encenar sintoma.",
    rationale: "É crime e derruba a credibilidade na hora.",
  },
  {
    id: "nunca.deixar-apoio-em-casa",
    rule: "Nunca orientar a deixar bengala, órtese ou andador em casa.",
    rationale: null,
  },
  {
    id: "nunca.esconder-melhora",
    rule: "Nunca orientar a esconder melhora ou omitir tratamento que funcionou.",
    rationale: null,
  },
  {
    id: "nunca.decorar-respostas",
    rule: "Nunca orientar a decorar respostas.",
    rationale: "Resposta ensaiada soa ensaiada.",
  },
  {
    id: "nunca.esforco-heroico",
    rule: 'Nunca orientar a fazer "esforço heroico" para não se contradizer.',
    rationale: null,
  },
  {
    id: "nunca.calar-idade-escolaridade-regiao-renda",
    rule: "Nunca orientar a calar idade, escolaridade, região ou situação financeira.",
    rationale:
      'A forma correta é "guarde para o seu advogado", nunca "não diga".',
  },
  {
    id: "nunca.trocar-laudo-migrar-remarcar",
    rule: "Nunca orientar a trocar laudo, migrar para perícia remota ou remarcar por conveniência.",
    rationale:
      "Fora de escopo por decisão do usuário: as perícias já estão agendadas e a estratégia de cada caso já foi definida.",
  },
  // §5, regra geral de fechamento da seção dos cards.
  {
    id: "regra-geral.dont-dress-up",
    rule: '`medical.dont-dress-up` para em "venha como você está num dia comum" e não sugere deixar apoio em casa.',
    rationale: "Regra geral declarada no fim da §5.",
  },
];

// ---- §3: fatos que PODEM ser afirmados ----
//
// `source` carrega a fonte oficial de cada um — o briefing exige rastreabilidade
// E proíbe citar a fonte no vídeo (por isso nenhum fato usa 'somente-com-fonte':
// esse escopo existe no schema mas é inutilizável neste contrato).

const FATOS_PERMITIDOS: AllowedFact[] = [
  // §3.1 BPC/LOAS — as duas etapas
  {
    id: "af.bpc.avaliacao-dupla",
    statement:
      "BPC/LOAS PcD tem avaliação DUPLA e obrigatória: perícia médica federal e avaliação do Serviço Social, com profissionais diferentes e agendamentos separados.",
    scope: "afirmavel",
    source: "LOAS art. 20 §6º; Dec. 6.214 art. 16 §§1º-2º; PC 34/2025 art. 13",
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "af.bpc.duas-datas-e-pratica-nao-norma",
    statement:
      'Nenhuma norma exige duas datas: existe ordem preferencial (a médica costuma vir primeiro) e agendamento por etapa. Forma correta para leigo: "São duas avaliações, com pessoas diferentes. Quase sempre em dias diferentes. Pegue a sua carta e veja quantas datas estão marcadas para você."',
    scope: "condicional",
    source:
      "CORREÇÃO 14/08 (PARECER-BPC.md): prática de agendamento, não regra",
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "af.bpc.remarcacao-sete-dias",
    statement:
      'Quem falta pode remarcar, uma única vez, em até sete dias. Faltar sozinho não derruba; faltar e não remarcar em sete dias é que derruba. Forma correta: "Se faltar em uma, você ainda pode remarcar, uma vez só, em até sete dias. Passou disso, o pedido cai."',
    scope: "afirmavel",
    source: "PC 34/2025 art. 13 §§3º e 9º; PC 33/2025 art. 7º",
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "af.bpc.etapa-social-pode-nao-acontecer",
    statement:
      'A etapa social pode não acontecer: (a) se a perícia médica não constatar impedimento de longo prazo, as demais etapas são dispensadas; (b) pode ser aplicado um padrão no lugar da entrevista social. Forma correta: "olhe na sua carta se ainda falta a conversa com a assistente social".',
    scope: "condicional",
    source: "PC 34/2025 art. 15 §1º II",
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "af.bpc.padrao-so-concede-ou-mantem",
    statement:
      "O padrão aplicado no lugar da entrevista social só serve para conceder ou manter, nunca para indeferir ou cessar.",
    scope: "afirmavel",
    source: "L14.176 art. 3º §1º; PC 34/2025 art. 13 §§4º III e 7º",
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "af.bpc.modelo-biopsicossocial",
    statement:
      "O modelo é biopsicossocial: considera impedimentos em funções e estruturas do corpo, fatores socioambientais e pessoais, limitação de atividades e restrição de participação. Não é só o CID.",
    scope: "afirmavel",
    source: "Lei 13.146/2015 art. 2º §1º; Dec. 6.214 art. 16",
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "af.bpc.impedimento-de-longo-prazo",
    statement:
      'O impedimento precisa durar, ou poder durar, ao menos dois anos. Forma para leigo: "Diga há quanto tempo você está assim e o que o seu médico espera daqui para a frente." Nunca dizer o número "dois anos" como requisito legal.',
    scope: "condicional",
    source: "LOAS art. 20 §10; PC 33/2025 art. 3º I",
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "af.bpc.idoso-65",
    statement: "BPC idoso 65+: o requisito é etário mais renda.",
    scope: "afirmavel",
    // O briefing não dá fonte para este bullet; `null` é mais honesto que copiar
    // a fonte do bullet vizinho.
    source: null,
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "af.bpc.cadunico-vale-para-os-dois-publicos",
    statement:
      'CadÚnico atualizado (e CPF regular) é requisito de concessão tanto para o idoso quanto para a pessoa com deficiência. CadÚnico velho gera exigência e, sem cumprimento, indeferimento por desistência. Forma para leigo: "Se o seu CadÚnico está velho, atualize no CRAS. É por ele que olham a renda da sua casa."',
    scope: "afirmavel",
    source: "LOAS art. 20 §12; PC 34/2025 art. 6º III-IV e art. 15 §3º",
    appliesTo: [TRILHA_BPC],
  },
  // §3.2 BPC — renda, família e gasto de saúde
  {
    id: "af.bpc.grupo-familiar-lista-fechada",
    statement:
      'O grupo familiar é uma lista fechada, não é "quem mora junto". Entram: requerente, cônjuge ou companheiro, pais (ou madrasta/padrasto na ausência de um deles), irmãos solteiros, filhos e enteados solteiros e menores tutelados, morando sob o mesmo teto. Genro, nora, neto, cunhado, irmão casado, filho casado e agregado não entram. Forma para leigo: "Diga quem mora com você e o parentesco de cada um. Nem todo mundo que divide a casa entra na conta — quem faz essa conta é o INSS."',
    scope: "afirmavel",
    source: "LOAS art. 20 §1º; PC 34/2025 art. 7º §1º",
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "af.bpc.beneficio-de-outro-morador-nao-entra",
    statement:
      'BPC ou benefício de até um salário mínimo de outro idoso 65+ ou outra PcD da mesma casa não entra na conta da renda. Renda de estágio e de aprendizagem também não entra. Forma para leigo: "Se alguém da casa já recebe esse benefício, ou é idoso e recebe um salário mínimo, fale: isso pode sair da conta."',
    scope: "afirmavel",
    source: "LOAS art. 20 §§14 e 9º",
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "af.bpc.gasto-de-saude-lista-fechada",
    statement:
      "Gasto de saúde abate da renda, mas a lista é fechada: tratamentos de saúde, gastos médicos, fraldas, alimentos especiais e medicamentos não fornecidos gratuitamente pelo SUS (e serviço não prestado pelo SUAS), desde que contínuos. Condução, transporte e plano de saúde não abatem.",
    scope: "condicional",
    source: "LOAS art. 20-B III; PC 34/2025 art. 8º §4º e Anexo I",
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "af.bpc.abatimento-exige-dois-papeis",
    statement:
      "O abatimento só sai com dois papéis: laudo médico dizendo que o tratamento é contínuo e a negativa do posto/SUS dizendo que não fornece.",
    scope: "condicional",
    source: "PC 34/2025 art. 8º §5º",
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "af.bpc.abatimento-exige-recibos-de-doze-meses",
    statement:
      "Sem recibos dos doze meses anteriores, o abatimento fica preso a um valor médio fixo, pequeno.",
    scope: "condicional",
    source: "PC 34/2025 art. 8º §§6º-7º",
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "af.bpc.abatimento-acontece-na-analise-de-renda",
    statement:
      "O abatimento acontece na análise de renda do pedido, feita a partir do CadÚnico e dos documentos entregues, não na avaliação social. Contar o gasto para a assistente social é certo e útil, mas não substitui o documento.",
    scope: "afirmavel",
    source: "PARECER-BPC.md (rodada de 14/08)",
    appliesTo: [TRILHA_BPC],
  },
  // §3.3 Benefício por incapacidade
  {
    id: "af.inc.trabalho-habitual",
    statement:
      'A perícia avalia incapacidade para o trabalho habitual, não "para tudo". Dizer "a pergunta é sobre o serviço que era o seu", sem negar a hipótese de incapacidade permanente, cujo critério é mais amplo.',
    scope: "condicional",
    source: "Lei 8.213/91 art. 59 (permanente: art. 42)",
    appliesTo: [TRILHA_INCAPACIDADE],
  },
  {
    id: "af.inc.pedido-generico",
    statement:
      "O pedido entra genérico e o perito define a espécie. Nenhuma peça pode prometer ou nomear o benefício que vai sair.",
    scope: "afirmavel",
    source: "fonte oficial gov.br",
    appliesTo: [TRILHA_INCAPACIDADE],
  },
  {
    id: "af.inc.dii-e-uma-das-datas",
    statement:
      'A DII não é "a data que vale": conta-se do 16º dia do afastamento para empregado, e da data do pedido quando ele veio 30 dias ou mais depois do afastamento. Redação para leigo: "é uma das datas que entram na conta do seu benefício, por isso ela pesa".',
    scope: "condicional",
    source: "Lei 8.213/91 art. 60 e §1º (CORREÇÃO 14/08)",
    appliesTo: [TRILHA_INCAPACIDADE],
  },
  {
    id: "af.inc.cat-quem-pode-registrar",
    statement:
      'Se a empresa não abrir a CAT, o próprio acidentado pode registrar (Meu INSS), e também dependentes, sindicato, o médico que atendeu ou autoridade pública. Manter o condicional "se a empresa abriu".',
    scope: "condicional",
    source: "Lei 8.213/91 art. 22 §2º",
    appliesTo: [TRILHA_INCAPACIDADE],
  },
  {
    id: "af.inc.sem-vinculo-formal",
    statement:
      "Quem não tem vínculo formal em regra não tem CAT, mas tem direito ao benefício, com carência dispensada.",
    scope: "afirmavel",
    source: "Lei 8.213/91 art. 22 §2º",
    appliesTo: [TRILHA_INCAPACIDADE],
  },
  {
    id: "af.inc.nao-ha-avaliacao-social",
    statement:
      "A trilha de incapacidade não tem avaliação social: essa é requisito do BPC. Quem pede benefício por incapacidade tem só a conversa com o médico perito. Isso pode e deve ser dito.",
    scope: "afirmavel",
    source: "LOAS art. 20 §6º contra Lei 8.213/91 arts. 42, 59-60",
    appliesTo: [TRILHA_INCAPACIDADE],
  },
  // §5.3 — o prazo de exigência, confirmado só para BPC.
  {
    id: "af.bpc.exigencia-30-dias",
    statement:
      'São 30 dias contados da notificação da exigência, e não cumprir caracteriza desistência com indeferimento — mas o indeferimento não impede novo pedido. Bullet permitido: "Você tem 30 dias para entregar o que pediram, contados do dia em que você é avisado."',
    scope: "afirmavel",
    source: "PC 34/2025 art. 6º §4º e art. 15 §§3º-4º",
    appliesTo: [TRILHA_BPC],
  },
  // §5.4 — a regra cuja fronteira é por benefício. É o par do fato proibido
  // `ff.guarde-para-o-advogado-no-bpc`: mesma orientação, veredito oposto.
  {
    id: "af.inc.guarde-para-o-advogado",
    statement:
      'Na incapacidade, o assunto com o perito é o que o corpo aguenta fazer no trabalho. Idade, escolaridade, região e falta de emprego pesam noutro momento do caso: "guarde para o seu advogado" é orientação correta aqui. E se perguntarem, responda: nunca mentir, nunca esconder.',
    scope: "afirmavel",
    source:
      "PARECER-INCAPACIDADE.md (rodada de 14/08), card `work.money-elsewhere`",
    appliesTo: [TRILHA_INCAPACIDADE],
  },
  // §3.4 — verdadeiro, mas FORA de narração. A marcação é `appliesTo`: a única
  // trilha em que valem é o contexto da LIA, que não é trilha de vídeo nenhuma.
  // O par enforceável está em `outOfScope` (o gate `scope` procura as formas).
  {
    id: "af.apoio.isencao-de-reavaliacao-aos-65",
    statement:
      "Quem tem BPC-PcD e completa 65 anos fica isento da reavaliação biopsicossocial. Não entra em nenhuma peça: é informação de pós-concessão.",
    scope: "afirmavel",
    source: "PC 33/2025 art. 5º I",
    appliesTo: [TRILHA_APOIO],
  },
  {
    id: "af.apoio.cadastro-biometrico",
    statement:
      "Cadastro biométrico virou requisito para requerer o BPC. Fora de escopo desta rodada, registrado para não ser descoberto tarde.",
    scope: "afirmavel",
    source: "PC 34/2025 art. 6º V",
    appliesTo: [TRILHA_APOIO],
  },
  {
    id: "af.apoio.alcance-do-auxilio-acidente",
    statement:
      "Auxílio-acidente só alcança empregado, doméstico, avulso e segurado especial. Contribuinte individual, MEI e autônomo não têm. Contexto para a LIA, não para vídeo.",
    scope: "afirmavel",
    source: "Lei 8.213/91 art. 18 §1º",
    appliesTo: [TRILHA_APOIO],
  },
];

// ---- §4: fatos PROIBIDOS de afirmar ----
//
// `forms` são as formas literais que o gate procura: busca por fronteira de
// palavra, case-insensitive. Escolhidas para casar a afirmação proibida e NÃO a
// forma neutra vizinha — "faltar em uma derruba" casa a proibição, "faltar em
// uma" sozinho casaria também a orientação correta.

const FATOS_PROIBIDOS: ForbiddenFact[] = [
  {
    id: "ff.tolerancia-de-atraso",
    claim: "Tolerância de atraso do INSS (X minutos).",
    forms: [
      "tolerância de atraso",
      "minutos de tolerância",
      "tolerância de 15 minutos",
    ],
    neutralForm: "chegue com folga — atraso pode contar como falta",
    reason: "Sem fonte confirmada.",
    status: "proibido",
    statusChangedAt: null,
  },
  // A linha "~~Janela de prorrogação~~ LIBERADO 14/08" carrega dois vereditos: o
  // assunto foi liberado, a forma invertida continua proibida. Vira dois fatos.
  {
    id: "ff.janela-de-prorrogacao",
    claim: "Janela de prorrogação do benefício.",
    forms: ["prorrogação", "prorrogacao"],
    neutralForm: "nos últimos quinze dias antes de acabar",
    reason:
      "LIBERADO 14/08: fonte oficial gov.br, confirmada pela persona jurídica. Use a forma específica.",
    status: "liberado",
    statusChangedAt: RODADA_14_08,
  },
  {
    id: "ff.prorrogacao-forma-invertida",
    claim: '"Até quinze dias antes" (para pedir prorrogação).',
    forms: ["até quinze dias antes", "até 15 dias antes"],
    neutralForm: "nos últimos quinze dias antes de acabar",
    reason: "Inverte o sentido da janela.",
    status: "proibido",
    statusChangedAt: RODADA_14_08,
  },
  {
    id: "ff.resultado-no-mesmo-dia",
    claim: "O resultado sai no mesmo dia.",
    forms: ["sai no mesmo dia", "resultado no mesmo dia"],
    neutralForm: "acompanhe pelo app; o resultado costuma sair rápido",
    reason: "Sem fonte confirmada.",
    status: "proibido",
    statusChangedAt: null,
  },
  {
    id: "ff.novo-pedido-indeferimento-automatico",
    claim: "Novo pedido com a mesma prova é indeferimento automático.",
    forms: ["indeferimento automático", "indeferido automaticamente"],
    neutralForm:
      "pedir de novo com os mesmos papéis tende a repetir o resultado",
    reason: "Sem fonte confirmada.",
    status: "proibido",
    statusChangedAt: null,
  },
  {
    id: "ff.prazo-exato-de-recurso",
    claim: "Prazo exato de recurso em dias.",
    forms: [
      "dias para recorrer",
      "prazo de recurso é de",
      "prazo para recorrer é de",
    ],
    neutralForm:
      "se indeferir, o prazo para recorrer começa a correr — fale com a gente na hora",
    reason: "Sem fonte confirmada.",
    status: "proibido",
    statusChangedAt: null,
  },
  {
    id: "ff.percentual-de-funcoes-do-corpo",
    claim: "~90% sai LEVE em Funções do Corpo.",
    forms: ["90%", "noventa por cento", "sai leve", "funções do corpo"],
    neutralForm: "não mencionar de forma alguma",
    reason:
      "Sem fonte confirmada; o briefing manda não mencionar de forma alguma.",
    status: "proibido",
    statusChangedAt: null,
  },
  // "~~Teleperícia~~ CONFIRMADO 14/08" = conferido contra a Portaria e liberado
  // para ser dito. É a armadilha de vocabulário nº 1 do cabeçalho: aqui
  // "CONFIRMADO" do briefing vira `status: 'liberado'` do schema (conferido e
  // verdadeiro), nunca `'confirmado-falso'` — é exatamente aqui que a inversão
  // aconteceria se o status se chamasse só "confirmado".
  {
    id: "ff.telepericia-quem-esta-remoto",
    claim: "Como funciona a teleperícia (quem está remoto).",
    forms: ["quem está remoto é o perito", "presença obrigatória na agência"],
    neutralForm:
      "quem está remoto é o perito; o requerente tem presença obrigatória na agência",
    reason:
      "CONFIRMADO 14/08: Portaria Conjunta DPMF/INSS nº 18/2026 (DOU 08/04/2026), vigente desde 13/04/2026. Pode dizer isso.",
    status: "liberado",
    statusChangedAt: RODADA_14_08,
  },
  {
    id: "ff.telepericia-citar-a-portaria",
    claim: "Citar a portaria da teleperícia no vídeo.",
    forms: ["Portaria Conjunta", "nº 18/2026", "DOU 08/04/2026"],
    neutralForm: "não citar a portaria no vídeo",
    reason: "O vídeo é para leigo.",
    status: "proibido",
    statusChangedAt: RODADA_14_08,
  },
  {
    id: "ff.telepericia-garantia-de-nao-exame",
    claim: "Garantir que não haverá exame de tocar na teleperícia.",
    forms: [
      "não vai ter exame",
      "não tem exame de tocar",
      "ninguém vai te examinar",
    ],
    neutralForm: "pode não ter exame de tocar",
    reason: "A norma não garante ausência de exame.",
    status: "proibido",
    statusChangedAt: RODADA_14_08,
  },
  {
    id: "ff.crianca-presenca-obrigatoria",
    claim: "Presença obrigatória da criança / relatório escolar exigível.",
    forms: [
      "presença obrigatória da criança",
      "a criança precisa estar presente",
      "o relatório da escola é exigido",
    ],
    neutralForm: "leve a criança e, se tiver, o relatório da escola",
    reason: "Sem fonte confirmada.",
    status: "proibido",
    statusChangedAt: null,
  },
  // As linhas "NOVO 14/08": afirmações que a checagem derrubou. É este o sentido
  // de `status: 'confirmado-falso'` no schema — a checagem derrubou, continua bloqueando.
  {
    id: "ff.duas-avaliacoes-em-datas-diferentes",
    claim: "As duas são em datas diferentes (como regra).",
    forms: [
      "as duas são em datas diferentes",
      "são em datas diferentes",
      "em datas distintas",
    ],
    neutralForm:
      "com pessoas diferentes. Quase sempre em dias diferentes. Veja na sua carta quantas datas estão marcadas",
    reason: "Nenhuma norma exige duas datas: é prática de agendamento.",
    status: "confirmado-falso",
    statusChangedAt: RODADA_14_08,
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "ff.faltar-derruba-o-pedido-inteiro",
    claim: "Faltar em uma derruba o pedido inteiro.",
    forms: [
      "faltar em uma derruba",
      "derruba o pedido inteiro",
      "perde o pedido inteiro",
    ],
    neutralForm:
      "se faltar em uma, você ainda pode remarcar, uma vez só, em até sete dias. Passou disso, o pedido cai",
    reason: "A norma dá uma segunda chance: remarcação única em até sete dias.",
    status: "confirmado-falso",
    statusChangedAt: RODADA_14_08,
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "ff.quinze-minutos-de-avaliacao",
    claim: "Quem te avalia tem uns quinze minutos.",
    forms: ["quinze minutos", "15 minutos"],
    neutralForm:
      "o tempo com você é curto, por isso o que você diz precisa ser direto",
    reason: "O número não tem fonte.",
    status: "proibido",
    statusChangedAt: RODADA_14_08,
  },
  {
    id: "ff.promete-etapa-social",
    claim: "Depois dessa você ainda tem a da assistente social.",
    forms: [
      "você ainda tem a da assistente social",
      "depois dessa você ainda tem a da assistente social",
    ],
    neutralForm:
      "olhe na sua carta se ainda falta a conversa com a assistente social",
    reason: "A etapa social pode não acontecer.",
    status: "confirmado-falso",
    statusChangedAt: RODADA_14_08,
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "ff.conducao-transporte-plano-abatem",
    claim: "Condução, transporte ou plano de saúde abatem da renda.",
    forms: [
      "condução abate",
      "transporte abate",
      "plano de saúde abate",
      "o plano de saúde entra no abatimento",
    ],
    neutralForm:
      'condução: "não abate, mas conte assim mesmo: mostra o quanto é difícil chegar lá". Plano de saúde: não mencionar',
    reason: "Não estão na lista fechada do abatimento.",
    status: "confirmado-falso",
    statusChangedAt: RODADA_14_08,
    appliesTo: [TRILHA_BPC],
  },
  {
    id: "ff.todo-beneficio-vem-com-data-para-acabar",
    claim: "Todo benefício vem com data para acabar.",
    forms: [
      "todo benefício vem com data para acabar",
      "todo benefício tem data para acabar",
    ],
    neutralForm: "esse benefício costuma vir com data para acabar",
    reason: "Generalização sem fonte.",
    status: "confirmado-falso",
    statusChangedAt: RODADA_14_08,
  },
  {
    id: "ff.negar-hipotese-de-incapacidade-permanente",
    claim: "A pergunta não é se você pode trabalhar em alguma coisa.",
    forms: ["a pergunta não é se você pode trabalhar em alguma coisa"],
    neutralForm: "a pergunta é sobre o serviço que era o seu",
    reason:
      "Nega a hipótese de incapacidade permanente, cujo critério é mais amplo (art. 42).",
    status: "confirmado-falso",
    statusChangedAt: RODADA_14_08,
    appliesTo: [TRILHA_INCAPACIDADE],
  },
  {
    id: "ff.valor-em-real-de-abatimento",
    claim: "Qualquer valor em real de abatimento de gasto.",
    forms: ["R$", "reais"],
    neutralForm: "não citar valor — a tabela envelhece",
    reason: "Os valores da tabela envelhecem.",
    status: "proibido",
    statusChangedAt: RODADA_14_08,
  },
  {
    id: "ff.citar-norma",
    claim: "Qualquer artigo de lei, súmula, tema ou portaria.",
    forms: [
      "artigo",
      "art.",
      "súmula",
      "portaria",
      "decreto",
      "LOAS",
      "Lei 8.213",
      "Lei 13.146",
    ],
    neutralForm: "não citar — o vídeo é para leigo",
    reason: "O vídeo é para leigo.",
    status: "proibido",
    statusChangedAt: null,
  },
  // §5.4 — o par proibido de `af.inc.guarde-para-o-advogado`. Mesma frase, trilha
  // oposta: no BPC, mandar guardar isso para o advogado faz o requerente calar
  // exatamente o que decide o caso dele.
  {
    id: "ff.guarde-para-o-advogado-no-bpc",
    claim:
      "Guarde para o seu advogado (escolaridade, moradia, região, transporte) — no BPC.",
    forms: ["guarde para o seu advogado", "guarde isso para o advogado"],
    neutralForm:
      "no BPC, conte para a assistente social: escolaridade, moradia, região, acesso a serviço e transporte são o objeto da avaliação social",
    reason:
      "No BPC esses temas são o objeto da avaliação social; calar é calar o que decide o caso.",
    status: "proibido",
    statusChangedAt: RODADA_14_08,
    appliesTo: [TRILHA_BPC],
  },
  // §5.3 — os 30 dias estão confirmados para BPC; na incapacidade, "um prazo".
  {
    id: "ff.trinta-dias-em-incapacidade",
    claim: "O prazo de exigência é de 30 dias (em peça de incapacidade).",
    forms: ["30 dias", "trinta dias"],
    neutralForm: "um prazo",
    reason:
      "Na incapacidade a exigência corre por norma diferente, ainda não conferida.",
    status: "proibido",
    statusChangedAt: RODADA_14_08,
    appliesTo: [TRILHA_INCAPACIDADE],
  },
  {
    id: "ff.nao-perdeu-a-pericia",
    claim: "A avaliação acontece do mesmo jeito. Você não perdeu a perícia.",
    forms: ["você não perdeu a perícia", "a avaliação acontece do mesmo jeito"],
    neutralForm:
      "Isso não cancela o seu pedido. Leve a data da sua avaliação a sério do mesmo jeito.",
    reason: "Sustenta-se no espírito da norma, não na letra.",
    status: "proibido",
    statusChangedAt: RODADA_14_08,
  },
];

// ---- o contrato inteiro ----

const BRIEFING_PRE_PERICIA: CreateContentContractInput = {
  slug: "pre-pericia-inss",
  title: "Série de vídeos de orientação pré-perícia (INSS)",
  status: "active",
  // §11: o rótulo não é formalidade, é o que impede material não revisado de
  // chegar a um requerente real.
  outputLabel: "RASCUNHO — para revisão jurídica",
  summary: "Transcrição do BRIEFING.md de produção (rodada jurídica de 14/08)",
  reason:
    "O briefing é o contrato comum de toda a produção da série pré-perícia",

  audience: {
    who: "Requerentes do INSS que já têm perícia agendada.",
    notWho: [
      "advogado",
      "servidor do INSS",
      "quem ainda não tem perícia agendada",
      "público de auxílio-acidente (é trilha diferente)",
    ],
    situation:
      "Perícia já agendada. Os vídeos entram no fluxo da LIA, agente da Lexter que conversa com requerentes por WhatsApp.",
    assumptions: [
      "pessoas com dor, cansaço e medo de perder o benefício",
      "muitas com baixa escolaridade e idade avançada",
      "muitas vão assistir no celular, no ônibus, uma vez só",
      "a estratégia de cada caso já foi definida fora do vídeo",
    ],
  },

  ethicalLine: LINHA_ETICA,
  allowedFacts: FATOS_PERMITIDOS,
  forbiddenFacts: FATOS_PROIBIDOS,

  outOfScope: [
    {
      id: "oos.trocar-laudo-remota-remarcar",
      item: "Trocar laudo, migrar para perícia remota, remarcar por conveniência.",
      owner: "usuário (decisão de estratégia do caso)",
      // Formas específicas de propósito: "remarcar" cru casaria a orientação
      // legítima da remarcação de sete dias (§3.1).
      forms: [
        "trocar o laudo",
        "migrar para perícia remota",
        "remarcar por conveniência",
      ],
      question:
        "A peça sugere trocar laudo, migrar para remota ou remarcar por conveniência?",
    },
    {
      id: "oos.auxilio-acidente",
      item: "Auxílio-acidente (trilha indenizatória, para sequela que reduz capacidade).",
      owner: "LIA (contexto), não o vídeo",
      forms: ["auxílio-acidente", "auxilio-acidente"],
      question: "A peça introduz auxílio-acidente?",
    },
    {
      id: "oos.isencao-de-reavaliacao-aos-65",
      item: "Isenção da reavaliação biopsicossocial aos 65 anos (pós-concessão).",
      owner: "LIA (contexto), não o vídeo",
      forms: ["isento da reavaliação", "isenta da reavaliação"],
      question: "A peça fala de reavaliação pós-concessão?",
    },
    {
      id: "oos.cadastro-biometrico",
      item: "Cadastro biométrico como requisito para requerer o BPC.",
      owner: "próxima rodada de conteúdo",
      forms: ["cadastro biométrico", "biometria"],
      question: "A peça fala de cadastro biométrico?",
    },
  ],

  tone: {
    id: "pre-pericia-inss",
    // O briefing dá UM anti-exemplo literal (§7). Listar mais seria inventar
    // vocabulário que ninguém escreveu.
    anti_tone_words: ["limitação de marcha"],
    hard_rules: [
      {
        id: "uma-ideia-por-vez",
        regra: "Frase curta, palavra comum, uma ideia por vez.",
        porque: "Muitas assistem no celular, no ônibus, uma vez só.",
        severidade: "bloqueante",
      },
      {
        id: "sem-jargao-juridico",
        regra:
          "Sem jargão jurídico, sem número de artigo de lei, sem sigla não explicada.",
        porque: "O público é leigo.",
        severidade: "bloqueante",
      },
      {
        id: "nunca-condescendente",
        regra: "Nunca condescendente.",
        porque: "O público tem dor e medo, não é criança.",
        severidade: "bloqueante",
      },
      {
        id: "segunda-pessoa",
        regra: '2ª pessoa ("você"), presente, ativa.',
        porque: "É a voz aprovada da série.",
        severidade: "bloqueante",
      },
      {
        id: "frase-curta",
        regra: "Frase curta.",
        // Sem `threshold`: o briefing não dá número. Regra sem limiar o linter
        // reporta como não aplicada — melhor do que reprovar por um teto chutado.
        severidade: "aviso",
      },
      {
        id: "variacao-de-frase",
        regra:
          "Alterne comprimento: parágrafo com todas as frases do mesmo tamanho soa a máquina.",
        severidade: "aviso",
      },
      {
        id: "sem-travessao",
        regra: "Proibido travessão e em dash.",
        severidade: "bloqueante",
      },
      {
        id: "sem-triade",
        regra: 'Proibida a tríade "X, Y e Z".',
        severidade: "bloqueante",
      },
      {
        id: "palavra-comum",
        regra: "Proibida palavra difícil quando existe simples.",
        severidade: "bloqueante",
      },
      {
        id: "concreto-vence-abstrato",
        regra:
          'Concreto vence abstrato: "ando uma quadra e paro" vence "tenho limitação de marcha".',
        severidade: "aviso",
      },
      {
        id: "nunca-prometer-resultado",
        regra:
          'Nunca prometa resultado. Nunca diga "com isso você vai conseguir o benefício".',
        severidade: "bloqueante",
      },
      {
        id: "validar-o-cansaco-uma-vez",
        regra:
          "Valide o cansaço da pessoa antes de instruir, mas uma vez, sem melodrama.",
        severidade: "aviso",
      },
    ],
  },

  // O briefing declara o canal (WhatsApp, pela LIA) e manda a duração vir do
  // áudio medido, mas não fixa NENHUM número. `null` nos dois limites é a
  // transcrição honesta: o gate trata isso como `skipped` e diz que não mediu,
  // em vez de aprovar em silêncio.
  deliveryLimits: [
    {
      channel: "whatsapp",
      maxBytes: null,
      maxDurationSec: null,
      notes:
        "O briefing não declara número. A duração da composição vem do áudio medido (ffprobe), nunca de número chutado (§8).",
    },
  ],

  sourcePrecedence: [
    {
      rank: 1,
      source: "_conteudo/PARECER-BPC.md e _conteudo/PARECER-INCAPACIDADE.md",
      note: "Rodada de 14/08: os dois pareceres vencem este briefing. Onde houver conflito, o parecer manda.",
    },
    {
      rank: 2,
      source: "BRIEFING.md",
      note: "Contrato comum de toda a produção. Se algo aqui conflitar com o que você acha que sabe, este arquivo vence.",
    },
    {
      rank: 3,
      source:
        "material de origem (cards.ts, script.ts) e conhecimento prévio de quem produz",
      note: "Nunca vence. Os arquivos de origem estão marcados como rascunho não revisado juridicamente.",
    },
  ],

  productionInvariants: [
    {
      id: "conflito-com-codigo-pare-e-reporte",
      invariant: "Se o briefing conflitar com o código, pare e reporte.",
      rationale:
        "Não decida sozinho: a divergência é o achado, não o obstáculo.",
    },
    {
      id: "fonte-nao-citada-no-video",
      invariant:
        "As fontes ficam no briefing para rastreabilidade; nenhuma delas pode ser citada no vídeo.",
      rationale: "O vídeo é para leigo.",
    },
    {
      id: "sem-texto-na-imagem-gerada",
      invariant:
        "Nenhum texto dentro da imagem gerada: letra, número, placa, legenda, balão, nada. A tipografia é composta no Remotion.",
      rationale: "Invariante do estúdio.",
    },
    {
      id: "paleta-estrita-de-cinco-cores",
      invariant: "Paleta estrita de 5 cores.",
      rationale: "Definida pelo preset visual aprovado.",
    },
    {
      id: "pessoas-brasileiras-com-dignidade",
      invariant:
        "Pessoas brasileiras reais, com diversidade de tom de pele, idade e corpo. Adultos e idosos com dignidade: nunca infantilizados, nunca caricatos, nunca sofrendo de forma dramática.",
      rationale: null,
    },
    {
      id: "duracao-vem-do-audio-medido",
      invariant:
        "A duração da composição vem do áudio medido, nunca de número chutado.",
      rationale: null,
    },
    {
      id: "tela-se-sustenta-no-mudo",
      invariant:
        "O texto de tela (`onScreen`) é separado do falado (`narration`): a tela precisa se sustentar no mudo.",
      rationale: "Separação deliberada da referência de tom aprovada.",
    },
    {
      id: "toda-peca-sai-rotulada-como-rascunho",
      invariant:
        "Toda peça produzida sai rotulada como rascunho para revisão jurídica.",
      rationale:
        "É o que impede material não revisado de chegar a um requerente real.",
    },
  ],
};

// ---- a tabela de cobertura: seção do briefing -> campo do schema ----
//
// Este bloco é o entregável: declara, seção por seção, ONDE cada pedaço do
// briefing foi parar — ou por que ele não é conteúdo de contrato. "pipeline"
// significa que a seção governa a PRODUÇÃO (grade de vídeos, presets, paths,
// integração), não o conteúdo vinculante que os gates verificam.

type CampoDeConteudo = Exclude<
  keyof CreateContentContractInput,
  "summary" | "reason" | "status"
>;

interface LinhaDeCobertura {
  secao: string;
  conteudo: string;
  /** vazio = a seção inteira é pipeline de produção */
  campos: CampoDeConteudo[];
  /** o que ficou de fora, e por quê */
  pipeline?: string;
}

const COBERTURA: LinhaDeCobertura[] = [
  {
    secao: "título",
    conteudo: "BRIEFING — série de vídeos de orientação pré-perícia (INSS)",
    campos: ["slug", "title"],
  },
  {
    secao: "preâmbulo",
    conteudo:
      "Este arquivo é o contrato comum e vence o que você acha que sabe; conflito com o código, pare e reporte.",
    campos: ["sourcePrecedence", "productionInvariants"],
  },
  {
    secao: "§1",
    conteudo:
      "O que estamos produzindo e para quem; o que isso governa no texto.",
    campos: ["audience", "tone", "deliveryLimits"],
    pipeline:
      "O canal (WhatsApp, pela LIA) fica em deliveryLimits sem número: o briefing não declara byte nem duração.",
  },
  {
    secao: "§2",
    conteudo: "A linha ética: os pares PODE / NUNCA orientar.",
    campos: ["ethicalLine", "outOfScope"],
    pipeline:
      "O último NUNCA (trocar laudo, remota, remarcar) também vira item fora de escopo, porque é decisão do usuário e tem forma verificável.",
  },
  {
    secao: "§3 (nota da rodada)",
    conteudo:
      "Os dois pareceres vencem o briefing; as fontes não podem ser citadas no vídeo.",
    campos: ["sourcePrecedence", "productionInvariants"],
  },
  {
    secao: "§3.1",
    conteudo:
      "BPC/LOAS: as duas etapas, remarcação de sete dias, biopsicossocial, CadÚnico.",
    campos: ["allowedFacts"],
  },
  {
    secao: "§3.2",
    conteudo:
      "BPC: grupo familiar, renda que não conta, gasto de saúde e seus dois papéis.",
    campos: ["allowedFacts"],
  },
  {
    secao: "§3.3",
    conteudo:
      "Incapacidade: trabalho habitual, pedido genérico, DII, CAT, sem avaliação social.",
    campos: ["allowedFacts", "outOfScope"],
    pipeline:
      "Auxílio-acidente aparece aqui só para ser excluído: vira item fora de escopo, não fato permitido de vídeo.",
  },
  {
    secao: "§3.4",
    conteudo: "Conhecimento de apoio: verdadeiro, mas fora de narração.",
    campos: ["allowedFacts", "outOfScope"],
    pipeline:
      'A marcação "fora de narração" é appliesTo: ["apoio-lia"], que não é trilha de vídeo nenhuma; o par enforceável fica em outOfScope.',
  },
  {
    secao: "§4",
    conteudo:
      "Tabela de fatos proibidos, com forma neutra e os status LIBERADO / CONFIRMADO 14/08.",
    campos: ["forbiddenFacts"],
  },
  {
    secao: "§5 (regra geral)",
    conteudo:
      '`medical.dont-dress-up` para em "venha como você está num dia comum".',
    campos: ["ethicalLine"],
  },
  {
    secao: "§5.1",
    conteudo: "`social.income-track` reescrito.",
    campos: [],
    pipeline:
      "Redação de card (mora em _conteudo/cards-corrigidos.md); a substância normativa já está transcrita em §3.2 e §4.",
  },
  {
    secao: "§5.2",
    conteudo: "`common.dont-push-through` aprovado sem ressalva.",
    campos: [],
    pipeline:
      "Veredito de revisão de card; a orientação em si já está na §2 (comparecer com os apoios).",
  },
  {
    secao: "§5.3",
    conteudo:
      "`common.exigency-30d`: os 30 dias têm fonte para BPC, não para incapacidade.",
    campos: ["allowedFacts", "forbiddenFacts"],
    pipeline:
      "O sufixo `-30d` do assetCode e a redação do bullet são do card; o escopo por trilha é contrato.",
  },
  {
    secao: "§5.4",
    conteudo:
      "`work.money-elsewhere`: permitido em incapacidade, PROIBIDO em BPC.",
    campos: ["allowedFacts", "forbiddenFacts"],
  },
  {
    secao: "§6",
    conteudo: "A grade V0-V7.",
    campos: [],
    pipeline:
      "Plano de produção (que vídeo existe e qual é o eixo), não regra de conteúdo.",
  },
  {
    secao: "§7",
    conteudo: "Voz e tom do texto.",
    campos: ["tone", "productionInvariants"],
    pipeline:
      "O caminho da referência de tom (script.ts, 17 beats) é path de repositório: fica em §9.",
  },
  {
    secao: "§8",
    conteudo:
      "Regras de produção: sem texto na imagem, paleta, dignidade, duração medida.",
    campos: ["productionInvariants"],
    pipeline:
      "O preset `flat-warm` (caminho do arquivo) e a medição por ffprobe são pipeline; os invariantes que eles servem são contrato.",
  },
  {
    secao: "§9",
    conteudo: "Onde as coisas ficam.",
    campos: [],
    pipeline:
      "Tabela de paths de repositório e de chaves: pipeline de produção.",
  },
  {
    secao: "§10",
    conteudo:
      "Integração com a LIA (contentAssets, supportDocumentCatalog, cards.ts divergente).",
    campos: [],
    pipeline:
      "Wiring de produto em outro repo; a única consequência de contrato (o assetCode da §5.4 nunca entrar em escopo de BPC) já está em forbiddenFacts.appliesTo.",
  },
  {
    secao: "§11",
    conteudo:
      "Status honesto: toda peça sai rotulada como rascunho para revisão jurídica.",
    campos: ["outputLabel", "productionInvariants"],
  },
];

// ---- infra de teste (mesmo molde do content-contract-store.test) ----

let testDb: Database.Database;
vi.mock("./db", () => ({
  getDb: () => testDb,
}));

// Import depois do vi.mock, como no content-contract-store.test: o store resolve
// `getDb` na carga do módulo.
import * as store from "./content-contract-store";

function applyAllMigrations(db: Database.Database): void {
  for (const m of migrations) {
    if (m.disableForeignKeys) {
      db.pragma("foreign_keys = OFF");
      try {
        m.up(db);
      } finally {
        db.pragma("foreign_keys = ON");
      }
    } else {
      m.up(db);
    }
  }
}

function preenchido(campo: CampoDeConteudo): boolean {
  const valor = BRIEFING_PRE_PERICIA[campo];
  if (Array.isArray(valor)) return valor.length > 0;
  if (typeof valor === "string") return valor.trim().length > 0;
  if (valor && typeof valor === "object") return Object.keys(valor).length > 0;
  return false;
}

function fatoProibido(contrato: ContentContract, id: string): ForbiddenFact {
  const f = contrato.forbiddenFacts.find((x) => x.id === id);
  if (!f) throw new Error(`fato proibido ausente no contrato lido: ${id}`);
  return f;
}

// Material derivado do briefing real: só formas neutras da própria §4 e frases
// permitidas da §3.1. É a prova de que o gate reprova pelo MATERIAL, e não por
// reprovar tudo.
const MATERIAL_LIMPO_BPC = [
  "Você tem duas avaliações marcadas.",
  "Uma com o médico e outra com a assistente social. São pessoas diferentes.",
  "Quase sempre em dias diferentes. Pegue a sua carta e veja quantas datas estão marcadas para você.",
  "Se faltar em uma, você ainda pode remarcar, uma vez só, em até sete dias. Passou disso, o pedido cai.",
  "Chegue com folga. Atraso pode contar como falta.",
  "O tempo com você é curto, por isso o que você diz precisa ser direto.",
  "Conte o seu dia comum. Se hoje é um dia bom, diga isso e conte como são os outros dias.",
  "Venha com a sua bengala, se você usa bengala.",
].join("\n");

// O mesmo material com duas afirmações que a rodada de 14/08 derrubou.
const MATERIAL_VIOLADOR_BPC = [
  "Você tem duas avaliações marcadas, e as duas são em datas diferentes.",
  "Quem te avalia tem uns quinze minutos.",
  "Chegue com folga. Atraso pode contar como falta.",
].join("\n");

describe("BRIEFING.md real cabe inteiro no Content Contract", () => {
  beforeEach(() => {
    testDb = new Database(":memory:");
    testDb.pragma("foreign_keys = ON");
    applyAllMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe("round-trip: entra por create(), sai por get() idêntico", () => {
    it("o contrato inteiro sobrevive à ida e volta pelo banco", () => {
      const criado = store.create(BRIEFING_PRE_PERICIA);
      const lido = store.get(criado.id);

      expect(lido).not.toBeNull();
      expect(lido).toEqual(criado);

      // Campo a campo contra a FIXTURE (não contra o retorno do create): é o que
      // pega perda na serialização do JSON aninhado, não só no eco em memória.
      expect(lido?.slug).toBe(BRIEFING_PRE_PERICIA.slug);
      expect(lido?.title).toBe(BRIEFING_PRE_PERICIA.title);
      expect(lido?.status).toBe("active");
      expect(lido?.outputLabel).toBe(BRIEFING_PRE_PERICIA.outputLabel);
      expect(lido?.audience).toEqual(BRIEFING_PRE_PERICIA.audience);
      expect(lido?.ethicalLine).toEqual(LINHA_ETICA);
      expect(lido?.allowedFacts).toEqual(FATOS_PERMITIDOS);
      expect(lido?.forbiddenFacts).toEqual(FATOS_PROIBIDOS);
      expect(lido?.outOfScope).toEqual(BRIEFING_PRE_PERICIA.outOfScope);
      expect(lido?.tone).toEqual(BRIEFING_PRE_PERICIA.tone);
      expect(lido?.deliveryLimits).toEqual(BRIEFING_PRE_PERICIA.deliveryLimits);
      expect(lido?.sourcePrecedence).toEqual(
        BRIEFING_PRE_PERICIA.sourcePrecedence,
      );
      expect(lido?.productionInvariants).toEqual(
        BRIEFING_PRE_PERICIA.productionInvariants,
      );
    });

    it("o JSON aninhado sobrevive nos níveis mais fundos", () => {
      const criado = store.create(BRIEFING_PRE_PERICIA);
      const lido = store.get(criado.id)!;

      // arrays dentro de objetos dentro de arrays
      const grupoFamiliar = lido.allowedFacts.find(
        (f) => f.id === "af.bpc.grupo-familiar-lista-fechada",
      );
      expect(grupoFamiliar?.appliesTo).toEqual([TRILHA_BPC]);
      expect(grupoFamiliar?.source).toBe(
        "LOAS art. 20 §1º; PC 34/2025 art. 7º §1º",
      );

      const conducao = fatoProibido(
        lido,
        "ff.conducao-transporte-plano-abatem",
      );
      expect(conducao.forms).toEqual([
        "condução abate",
        "transporte abate",
        "plano de saúde abate",
        "o plano de saúde entra no abatimento",
      ]);

      // severidade das hard rules e o anti-exemplo literal do §7
      expect(
        lido.tone.hard_rules?.find((r) => r.id === "sem-travessao")?.severidade,
      ).toBe("bloqueante");
      expect(lido.tone.anti_tone_words).toEqual(["limitação de marcha"]);

      // null explícito não vira string nem some
      expect(
        lido.allowedFacts.find((f) => f.id === "af.bpc.idoso-65")?.source,
      ).toBeNull();
      expect(lido.deliveryLimits[0].maxBytes).toBeNull();
      expect(lido.deliveryLimits[0].maxDurationSec).toBeNull();
    });

    it("a versão 1 guarda o snapshot íntegro e a linha de changelog do briefing", () => {
      const criado = store.create(BRIEFING_PRE_PERICIA);
      const versoes = store.listVersions(criado.id);

      expect(versoes).toHaveLength(1);
      expect(versoes[0].snapshot).toEqual(criado);
      expect(versoes[0].summary).toBe(BRIEFING_PRE_PERICIA.summary);
      expect(versoes[0].reason).toBe(BRIEFING_PRE_PERICIA.reason);
    });
  });

  describe("a rodada de 14/08 sobrevive: status e data da mudança", () => {
    it("todo fato tocado em 14/08 preserva status E statusChangedAt", () => {
      const lido = store.get(store.create(BRIEFING_PRE_PERICIA).id)!;

      const tocadosEm1408 = lido.forbiddenFacts.filter(
        (f) => f.statusChangedAt === RODADA_14_08,
      );
      // Metade da tabela da §4 foi mexida na rodada: se a data se perder, o
      // histórico da checagem some e a discussão volta do zero.
      expect(tocadosEm1408.length).toBeGreaterThanOrEqual(12);

      expect(fatoProibido(lido, "ff.janela-de-prorrogacao")).toMatchObject({
        status: "liberado",
        statusChangedAt: RODADA_14_08,
      });
      expect(
        fatoProibido(lido, "ff.telepericia-quem-esta-remoto"),
      ).toMatchObject({
        status: "liberado",
        statusChangedAt: RODADA_14_08,
      });
      expect(
        fatoProibido(lido, "ff.duas-avaliacoes-em-datas-diferentes"),
      ).toMatchObject({
        status: "confirmado-falso",
        statusChangedAt: RODADA_14_08,
      });
      expect(
        fatoProibido(lido, "ff.faltar-derruba-o-pedido-inteiro"),
      ).toMatchObject({
        status: "confirmado-falso",
        statusChangedAt: RODADA_14_08,
      });
      // Fato nunca revisto: data nula, e nula tem que continuar nula.
      expect(
        fatoProibido(lido, "ff.tolerancia-de-atraso").statusChangedAt,
      ).toBeNull();
    });

    it("o que foi liberado em 14/08 passa; o que foi confirmado falso continua reprovando", () => {
      const contrato = store.get(store.create(BRIEFING_PRE_PERICIA).id)!;

      const liberado = runGate("forbidden-facts", {
        contract: contrato,
        material:
          "Você pode pedir a prorrogação nos últimos quinze dias antes de acabar. Quem está remoto é o perito; a sua presença na agência é obrigatória.",
        track: TRILHA_INCAPACIDADE,
      });
      expect(liberado.passed).toBe(true);
      expect(liberado.blocking).toBe(false);

      const confirmadoFalso = runGate("forbidden-facts", {
        contract: contrato,
        material: "Todo benefício vem com data para acabar.",
        track: TRILHA_BPC,
      });
      expect(confirmadoFalso.passed).toBe(false);
      expect(confirmadoFalso.blocking).toBe(true);
      expect(confirmadoFalso.evidence).toContain(
        "ff.todo-beneficio-vem-com-data-para-acabar",
      );
      expect(confirmadoFalso.evidence).toContain(
        "esse benefício costuma vir com data para acabar",
      );
    });
  });

  describe("§5.4: a mesma frase, permitida numa trilha e proibida na outra", () => {
    const MATERIAL =
      "Guarde para o seu advogado o que for da estratégia do seu caso.";

    it("em incapacidade a orientação passa", () => {
      const contrato = store.get(store.create(BRIEFING_PRE_PERICIA).id)!;
      const r = runGate("forbidden-facts", {
        contract: contrato,
        material: MATERIAL,
        track: TRILHA_INCAPACIDADE,
      });

      expect(r.passed).toBe(true);
      expect(r.blocking).toBe(false);
      // O fato existe e foi deliberadamente ignorado por trilha, não por acaso.
      expect(r.details.naoAplicaveis).toContainEqual({
        id: "ff.guarde-para-o-advogado-no-bpc",
        status: "proibido",
      });
    });

    it("em BPC a mesma frase reprova, com a forma neutra a usar no lugar", () => {
      const contrato = store.get(store.create(BRIEFING_PRE_PERICIA).id)!;
      const r = runGate("forbidden-facts", {
        contract: contrato,
        material: MATERIAL,
        track: TRILHA_BPC,
      });

      expect(r.passed).toBe(false);
      expect(r.blocking).toBe(true);
      expect(r.evidence).toContain("ff.guarde-para-o-advogado-no-bpc");
      expect(r.evidence).toContain("conte para a assistente social");
    });

    it("o par permitido da §5.4 está declarado na trilha oposta", () => {
      const contrato = store.get(store.create(BRIEFING_PRE_PERICIA).id)!;
      const permitido = contrato.allowedFacts.find(
        (f) => f.id === "af.inc.guarde-para-o-advogado",
      );

      expect(permitido?.appliesTo).toEqual([TRILHA_INCAPACIDADE]);
      expect(
        fatoProibido(contrato, "ff.guarde-para-o-advogado-no-bpc").appliesTo,
      ).toEqual([TRILHA_BPC]);
    });
  });

  describe("gate contra material derivado do briefing real", () => {
    it("texto que viola fato proibido declarado REPROVA, com trecho e substituto", () => {
      const contrato = store.get(store.create(BRIEFING_PRE_PERICIA).id)!;
      const r = runGate("forbidden-facts", {
        contract: contrato,
        material: MATERIAL_VIOLADOR_BPC,
        track: TRILHA_BPC,
      });

      expect(r.passed).toBe(false);
      expect(r.blocking).toBe(true);
      expect(r.evidence).toContain("ff.duas-avaliacoes-em-datas-diferentes");
      expect(r.evidence).toContain("ff.quinze-minutos-de-avaliacao");
      expect(r.evidence).toContain(
        "Veja na sua carta quantas datas estão marcadas",
      );
    });

    it("texto limpo, escrito só com as formas neutras do próprio briefing, PASSA", () => {
      const contrato = store.get(store.create(BRIEFING_PRE_PERICIA).id)!;
      const r = runGate("forbidden-facts", {
        contract: contrato,
        material: MATERIAL_LIMPO_BPC,
        track: TRILHA_BPC,
      });

      expect(r.passed).toBe(true);
      expect(r.blocking).toBe(false);
      expect(r.evidence).toContain("Nenhum fato proibido no material");
    });

    it("assunto fora de escopo é pego pelo gate de escopo", () => {
      const contrato = store.get(store.create(BRIEFING_PRE_PERICIA).id)!;
      const r = runGate("scope", {
        contract: contrato,
        material:
          "Se a sua sequela reduz a capacidade, existe também o auxílio-acidente.",
      });

      expect(r.passed).toBe(false);
      // A evidência do gate `scope` fala com quem escreve (o item e o dono); o id
      // do item aparece como `rule` do finding.
      expect(r.evidence).toContain("Auxílio-acidente");
      expect(r.evidence).toContain("LIA (contexto), não o vídeo");
      expect(r.details.findings).toContainEqual(
        expect.objectContaining({ rule: "oos.auxilio-acidente" }),
      );
    });
  });

  describe("cobertura: cada seção do briefing tem destino declarado", () => {
    it("toda seção do briefing está classificada, e o que é pipeline diz por quê", () => {
      const secoes = COBERTURA.map((l) => l.secao);
      expect(secoes).toEqual([
        "título",
        "preâmbulo",
        "§1",
        "§2",
        "§3 (nota da rodada)",
        "§3.1",
        "§3.2",
        "§3.3",
        "§3.4",
        "§4",
        "§5 (regra geral)",
        "§5.1",
        "§5.2",
        "§5.3",
        "§5.4",
        "§6",
        "§7",
        "§8",
        "§9",
        "§10",
        "§11",
      ]);

      for (const linha of COBERTURA) {
        expect(linha.conteudo.trim().length).toBeGreaterThan(0);
        // Seção sem campo é seção de pipeline, e pipeline sem justificativa é
        // conteúdo varrido para debaixo do tapete.
        if (linha.campos.length === 0) {
          expect(linha.pipeline?.trim().length ?? 0).toBeGreaterThan(0);
        }
      }
    });

    it("todo campo declarado como destino está de fato preenchido", () => {
      const vazios = COBERTURA.flatMap((l) => l.campos).filter(
        (c) => !preenchido(c),
      );
      expect(vazios).toEqual([]);
    });

    it("nenhum campo do schema sobra: todos aparecem na tabela de cobertura", () => {
      // A outra metade do critério de aceite. Campo do schema que nenhuma seção
      // do briefing alimenta é campo sobrando — sinal de que o schema modela algo
      // que o contrato real não tem.
      const CAMPOS_DE_CONTEUDO: CampoDeConteudo[] = [
        "slug",
        "title",
        "outputLabel",
        "audience",
        "ethicalLine",
        "allowedFacts",
        "forbiddenFacts",
        "outOfScope",
        "tone",
        "deliveryLimits",
        "sourcePrecedence",
        "productionInvariants",
      ];
      const reivindicados = new Set(COBERTURA.flatMap((l) => l.campos));
      const sobrando = CAMPOS_DE_CONTEUDO.filter((c) => !reivindicados.has(c));
      expect(sobrando).toEqual([]);
    });
  });
});
