import { config } from './config.js';

// Aviso (no máximo 1 a cada 3h) quando os créditos do Gemini acabam
let ultimoAviso = 0;
function avisarSemCredito() {
  if (Date.now() - ultimoAviso < 3 * 3600 * 1000) return;
  ultimoAviso = Date.now();
  import('./util.js').then(({ sendToSuggestionGroup }) => sendToSuggestionGroup(
    '🚨 *Os créditos do Gemini acabaram.*\nEnquanto não forem recarregados, a IA para de analisar mensagens, registrar vistorias, transcrever áudios e responder perguntas.\n\n' +
    'Recarregue em: https://aistudio.google.com → projeto da chave → *Billing*.\nAs mensagens continuam sendo guardadas; depois da recarga, rode *!vistorias verificar* para recuperar as idas do período.'
  )).catch(() => {});
}

// Saúde da IA: contagem de chamadas e erros (aparece no !status)
export const saudeIA = { ok: 0, erros: 0, limite: 0, semCredito: null, desde: new Date(), ultimoErro: null, ultimoErroEm: null };
// Modelo descontinuado (404 "no longer available"): troca sozinho pelo modelo que o Google indica e tenta de novo
const trocados = {};
async function trocarModeloSeDescontinuado(url, res) {
  if (res.status !== 404) return null;
  const corpo = await res.clone().text().catch(() => '');
  if (!/no longer available|not found|is not supported/i.test(corpo)) return null;
  const antigo = (url.match(/\/models\/([^:]+):/) || [])[1];
  if (!antigo) return null;
  if (trocados[antigo]) return url.replace(`/models/${antigo}:`, `/models/${trocados[antigo]}:`);
  let novo = (corpo.match(/use models\/([\w.\-]+)/i) || [])[1];
  if (!novo) novo = /lite/.test(antigo) ? 'gemini-3.5-flash-lite' : 'gemini-3.5-flash';
  novo = novo.replace(/[.\-]+$/, '');
  if (!novo || novo === antigo) return null;
  trocados[antigo] = novo;
  if (config.geminiModel === antigo) config.geminiModel = novo;
  if (config.geminiModelLeve === antigo) config.geminiModelLeve = novo;
  console.warn(`[gemini] modelo ${antigo} descontinuado → usando ${novo}`);
  import('./util.js').then(({ sendToSuggestionGroup }) => sendToSuggestionGroup(
    `⚙️ O Google descontinuou o modelo *${antigo}*. Passei a usar *${novo}* automaticamente.`
  )).catch(() => {});
  return url.replace(`/models/${antigo}:`, `/models/${novo}:`);
}

// ---------- consumo: tokens por tarefa e por dia (comando !custos) ----------
// Preço por 1 milhão de tokens (US$), tabela pública do Gemini; "pensamento" é cobrado como saída.
const PRECOS = {
  'gemini-2.5-flash': [0.30, 2.50],
  'gemini-2.5-flash-lite': [0.10, 0.40],
  'gemini-2.5-pro': [1.25, 10.00],
};
export const usoHoje = { dia: null, tarefas: {} };
let salvarUsoTimer = null;
function diaHoje() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }
async function registrarUso(tarefa, modelo, u) {
  if (!u) return;
  const dia = diaHoje();
  if (usoHoje.dia !== dia) {
    usoHoje.dia = dia;
    usoHoje.tarefas = {};
    try {
      const { getSetting } = await import('./db.js');
      Object.assign(usoHoje.tarefas, JSON.parse((await getSetting(`uso_${dia}`)) || '{}'));
    } catch {}
  }
  const k = `${tarefa}|${modelo}`;
  const t = usoHoje.tarefas[k] || (usoHoje.tarefas[k] = { chamadas: 0, entrada: 0, saida: 0, pensamento: 0 });
  t.chamadas++;
  t.entrada += u.promptTokenCount || 0;
  t.saida += u.candidatesTokenCount || 0;
  t.pensamento += u.thoughtsTokenCount || 0;
  clearTimeout(salvarUsoTimer);
  salvarUsoTimer = setTimeout(async () => {
    try { const { setSetting } = await import('./db.js'); await setSetting(`uso_${usoHoje.dia}`, JSON.stringify(usoHoje.tarefas)); } catch {}
  }, 5000);
}
export function custoEstimado(modelo, t) {
  const p = PRECOS[modelo];
  if (!p) return null;
  return (t.entrada * p[0] + (t.saida + t.pensamento) * p[1]) / 1e6;
}

// Sem "pensamento" nas tarefas simples (é o que mais encarece). A conversa livre pensa um pouco.
function comPensamentoControlado(opt, modelo, tarefa) {
  try {
    const body = JSON.parse(opt.body);
    body.generationConfig = body.generationConfig || {};
    if (body.generationConfig.thinkingConfig) return opt;
    const conversa = /conversa/i.test(tarefa);
    if (/^gemini-2\.5-(flash|flash-lite)/.test(modelo)) body.generationConfig.thinkingConfig = { thinkingBudget: conversa ? 1024 : 0 };
    else if (/^gemini-3/.test(modelo)) body.generationConfig.thinkingConfig = { thinkingLevel: conversa ? 'low' : 'minimal' };
    else return opt;
    return { ...opt, body: JSON.stringify(body) };
  } catch { return opt; }
}
let pensamentoRecusado = new Set(); // modelos que não aceitaram a configuração: manda sem

async function chamarGemini(url, opt, tarefa = 'Outros') {
  try {
    const modeloDe = (u) => (u.match(/\/models\/([^:]+):/) || [])[1] || '';
    let modelo = modeloDe(url);
    let optUsado = pensamentoRecusado.has(modelo) ? opt : comPensamentoControlado(opt, modelo, tarefa);
    let res = await fetch(url, optUsado);
    if (res.status === 400 && optUsado !== opt && /thinking/i.test(await res.clone().text().catch(() => ''))) {
      pensamentoRecusado.add(modelo);
      optUsado = opt;
      res = await fetch(url, opt);
    }
    const nova = !res.ok && (await trocarModeloSeDescontinuado(url, res));
    if (nova) {
      url = nova;
      modelo = modeloDe(nova);
      optUsado = comPensamentoControlado(opt, modelo, tarefa);
      res = await fetch(nova, optUsado);
      if (res.status === 400 && optUsado !== opt) { pensamentoRecusado.add(modelo); res = await fetch(nova, opt); }
    }
    if (res.ok) {
      saudeIA.ok++;
      res.clone().json().then((j) => registrarUso(tarefa, modelo, j?.usageMetadata)).catch(() => {});
    } else {
      saudeIA.erros++;
      if (res.status === 429) saudeIA.limite++;
      if (res.status === 402) { saudeIA.semCredito = new Date(); avisarSemCredito(); }
      saudeIA.ultimoErro = `HTTP ${res.status}`;
      saudeIA.ultimoErroEm = new Date();
      console.error(`[gemini] HTTP ${res.status}`);
    }
    return res;
  } catch (e) {
    saudeIA.erros++;
    saudeIA.ultimoErro = e.message;
    saudeIA.ultimoErroEm = new Date();
    throw e;
  }
}

const ORIGEM = {
  moradores: 'grupo de moradores',
  sindico: 'grupo interno da administradora com o síndico',
  conselho: 'grupo do conselho',
  privado: 'conversa privada',
  outro: 'grupo',
};

const INSTRUCOES = `Você é assistente de Luiz Felipe, da Alpha Condomínios (administradora de condomínios em Belo Horizonte).
Um número da administradora participa dos grupos dos condomínios. Você lê as mensagens e decide se alguma precisa de atenção ou resposta do Luiz ou da administradora.

PRECISA de atenção: pergunta ou pedido dirigido à administradora, ao síndico ou a qualquer pessoa da equipe
(mesmo chamada pelo nome, ex.: "Ygor, tudo bem? Gostaria de retorno sobre..."); pedido de retorno, orçamento,
prazo ou previsão; reclamação; problema de manutenção,
segurança, vazamento, elevador, portaria; dúvida sobre boleto, taxa, assembleia, regras; cobrança de retorno
("ninguém respondeu", "aguardando"); qualquer urgência.
NÃO precisa: conversa entre moradores que já se resolveu, cumprimentos, agradecimentos, "ok", figurinhas,
avisos que não pedem ação, mensagens que outra pessoa já respondeu corretamente.

Regras da sugestão de resposta:
- Português do Brasil, cordial e objetivo, pronta para colar no WhatsApp. Sem emojis.
- PADRÃO DA ALPHA (obrigatório): cada parágrafo separado por uma linha em branco. Estrutura:
    <Bom dia|Boa tarde|Boa noite, conforme o HORÁRIO ATUAL> <primeiro nome da pessoa>,
    (linha em branco)
    Tudo bem?
    (linha em branco)
    <corpo, em um ou mais parágrafos curtos, separados por linha em branco>
  NÃO escreva despedida nem assinatura ("Att", nome, "Alpha"): o sistema acrescenta sozinho.
- Use, nesta ordem, BASE DE CONHECIMENTO, DOCUMENTOS e HISTÓRICO: se ali já houver a informação pedida,
  responda com ela. Ao usar um documento (regimento, convenção), cite o artigo. Se o fato for um andamento com
  data antiga, diga que vai confirmar a situação atual. Se não houver a informação, diga que vai verificar e retornar.
- Siga o tom, o tamanho e o jeito de escrever dos EXEMPLOS DE RESPOSTAS DA EQUIPE (quando houver).
  Copie o estilo, nunca o conteúdo de outro caso.
- NUNCA invente informação (valores, datas, nomes de fornecedores, horários, artigos de regimento).
  Se faltar dado, a sugestão deve dizer que vai verificar e retornar, ou fazer uma pergunta.
- TRIAGEM ANTES DE AGIR (obrigatório em relato de problema): antes de prometer técnico, orçamento ou providência,
  a sugestão faz as perguntas que mostram se o problema é DO CONDOMÍNIO (área comum) ou SÓ DA UNIDADE/DA PESSOA.
  Siga o ROTEIRO DE ATENDIMENTO abaixo. Pergunte de forma gentil, no máximo 2 ou 3 perguntas, e diga que,
  com a resposta, a administradora já encaminha. Se a resposta já estiver no histórico, não pergunte de novo:
  use-a. Urgência real (alguém preso no elevador, vazamento grande, cheiro de gás, risco à segurança) vem antes:
  oriente a ação imediata e só depois pergunte.
- Em grupo de moradores, nunca exponha inadimplência, valores devidos por unidade, dados pessoais ou
  conflitos internos. Para esses assuntos, sugira chamar a pessoa no privado.
- Use o CONTEXTO INTERNO (grupos de síndico/conselho) apenas para orientar o Luiz na nota_interna;
  não revele esse conteúdo na sugestão.

ROTEIRO DE ATENDIMENTO (perguntas de triagem por tipo de problema):
- Falta de água, energia, gás, interfone, internet/TV ou sinal: "O problema é só na sua unidade ou os vizinhos também estão sem?";
  energia: "Já conferiu o disjuntor do seu quadro?"; água: "Os registros da unidade estão abertos?".
- Portão, garagem ou controle remoto: "Já testou com outro controle?"; "Outro morador consegue abrir normalmente?";
  "O controle está com bateria/pilha nova e com a luz acendendo?"; "Acontece em qual portão (garagem, pedestre, social)?".
- Portão aberto, parado no meio ou "travado": antes de falar em manutenção, peça que alguém (morador ou portaria) acione
  o controle para fechar, e explique: "se o portão for acionado de novo antes de terminar de abrir ou fechar, ele para e
  fica travado até um novo acionamento — basta acionar mais uma vez". Pergunte se fechou; só se não fechar, a
  administradora aciona a manutenção. Portão aberto é questão de segurança: trate como prioridade.
- Tag, biometria ou acesso: "Acontece só com a sua tag/digital ou com outras também?"; "Em qual leitor?".
- Elevador: "Está parado em qual andar?"; "Tem alguém preso?" (se sim, é urgente: oriente acionar o botão de alarme e a
  empresa de manutenção); "Os dois elevadores estão com o problema ou só um?".
- Vazamento, infiltração ou umidade: "Em qual cômodo e em que ponto (teto, parede, piso)?"; "Consegue mandar uma foto?";
  "Começou quando? Piora com chuva?" — para saber se vem da área comum, da unidade de cima ou da própria unidade.
- Barulho ou vizinho: "Em que horário acontece?"; "Consegue identificar de qual unidade vem?".
- Lâmpada, iluminação ou equipamento da área comum: "Em qual local exatamente (andar, bloco, garagem)?".
REGRAS ENSINADAS PELO LUIZ (têm prioridade sobre o roteiro acima, quando houver) vêm na mensagem, se existirem.

Responda SOMENTE com JSON:
{
  "precisa_atencao": true|false,
  "categoria": "duvida|reclamacao|manutencao|financeiro|assembleia|seguranca|outro",
  "urgencia": "baixa|media|alta",
  "resumo": "uma frase dizendo o que a pessoa quer",
  "sugestao": "texto da resposta, ou vazio se não for o caso de responder",
  "nota_interna": "algo útil que só o Luiz deve saber (contexto dos grupos internos, cuidado, próximo passo) ou vazio"
}`;

function linha(m) {
  const hora = new Date(m.ts).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const quem = m.from_me ? `EQUIPE ALPHA${m.author_name ? ` (${m.author_name})` : ''}` : m.author_name || 'Participante';
  const citado = m.quoted_text ? ` (respondendo a: "${m.quoted_text.slice(0, 150)}")` : '';
  return `[${hora}] ${quem}${citado}: ${m.text}`;
}

export async function analisar({ chat, historico, novas, interno, conhecimento = {} }) {
  const agora = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const partes = [
    `HORÁRIO ATUAL: ${agora}`,
    `ORIGEM: ${ORIGEM[chat.kind] || 'conversa'}${chat.condo_name ? ` do condomínio ${chat.condo_name}` : ''}` +
      (chat.name ? ` ("${chat.name}")` : ''),
    `\nHISTÓRICO RECENTE:\n${historico.map(linha).join('\n') || '(vazio)'}`,
    `\nMENSAGENS NOVAS PARA AVALIAR:\n${novas.map(linha).join('\n')}`,
  ];
  const { fatos = [], docs = [], exemplos = [], regras = [] } = conhecimento;
  if (regras.length) {
    partes.push(`\nREGRAS ENSINADAS PELO LUIZ (siga sempre):\n${regras.map((r) => `- ${r}`).join('\n')}`);
  }
  if (fatos.length) {
    partes.push(`\nBASE DE CONHECIMENTO DO CONDOMÍNIO (aprendida das conversas):\n${fatos.map((f) => `- ${f.fato}`).join('\n')}`);
  }
  // Regimento/convenção só entram quando a conversa toca em regra (são o maior pedaço da entrada)
  const sobreRegra = /(regiment|conven[cç][aã]o|regra|norma|pode|proib|permit|multa|advert[eê]ncia|hor[aá]rio|sil[eê]ncio|barulho|obra|reforma|mudan[cç]a|animal|pet|cachorro|piscina|sal[aã]o|churrasq|academia|vaga|garagem|estacion|assembleia|quorum|qu[oó]rum|taxa|rateio|fundo|artigo|art\.)/i
    .test(novas.map((m) => m.text).join(' '));
  if (docs.length && sobreRegra) {
    let restante = 60000;
    const blocos = [];
    for (const d of docs) {
      if (restante <= 0) break;
      const t = d.texto.slice(0, restante);
      restante -= t.length;
      blocos.push(`=== ${d.titulo} ===\n${t}`);
    }
    partes.push(`\nDOCUMENTOS DO CONDOMÍNIO:\n${blocos.join('\n\n')}`);
  }
  if (exemplos.length) {
    partes.push(`\nEXEMPLOS DE RESPOSTAS DA EQUIPE (para imitar o estilo):\n${exemplos.map((e) =>
      `PERGUNTA: ${e.pergunta.slice(0, 400)}\nRESPOSTA DA EQUIPE: ${e.resposta.slice(0, 800)}`).join('\n---\n')}`);
  }
  if (interno?.length) {
    partes.push(`\nCONTEXTO INTERNO (não revelar na sugestão):\n${interno.map((m) => `(${ORIGEM[m.chat_kind]}) ${linha(m)}`).join('\n')}`);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: INSTRUCOES }] },
    contents: [{ role: 'user', parts: [{ text: partes.join('\n') }] }],
    generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
  };

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const res = await chamarGemini(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'Sugestões (análise das mensagens)');
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * tentativa));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const texto = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '{}';
    return JSON.parse(texto.replace(/^```json\s*|```$/g, ''));
  }
  throw new Error('Gemini indisponível após 3 tentativas');
}

// Transcreve um áudio (base64) com o próprio Gemini
export async function transcrever(base64, mimetype) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiKey}`;
  const mime = String(mimetype || 'audio/ogg').split(';')[0].trim();
  const body = {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: mime, data: base64 } },
      { text: 'Transcreva fielmente este áudio de WhatsApp, em português do Brasil. Responda somente com a transcrição, sem comentários. Se não houver fala compreensível, responda: [inaudível]' },
    ] }],
    generationConfig: { temperature: 0 },
  };
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const res = await chamarGemini(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'Transcrição de áudios');
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * tentativa)); continue; }
    if (!res.ok) throw new Error(`Gemini transcrição ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '').trim();
  }
  throw new Error('Gemini indisponível para transcrição');
}

// Chamada genérica que devolve JSON (usada pelo aprendizado)
export async function gerarJSON(sistema, texto, { leve = false, tarefa = 'Outros' } = {}) {
  const modelo = leve ? config.geminiModelLeve : config.geminiModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${config.geminiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: sistema }] },
    contents: [{ role: 'user', parts: [{ text: texto }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 16384 },
  };
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const res = await chamarGemini(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, tarefa);
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 3000 * tentativa)); continue; }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const t = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '{}';
    return lerJSON(t);
  }
  throw new Error('Gemini indisponível após 3 tentativas');
}

// JSON tolerante: tira cercas de código e, se vier texto em volta, pega o primeiro objeto
function lerJSON(t) {
  const limpo = String(t).replace(/^```(json)?\s*|```\s*$/g, '').trim();
  try { return JSON.parse(limpo); } catch {}
  const i = limpo.indexOf('{'), j = limpo.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(limpo.slice(i, j + 1)); } catch {} }
  throw new Error('a IA devolveu uma resposta incompleta');
}

// Resposta em texto livre (conversa): não depende de JSON e aproveita a resposta mesmo se cortada no fim
export async function gerarTexto(sistema, texto, { maxTokens = 8192, tarefa = 'Conversa no grupo de sugestões' } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: sistema }] },
    contents: [{ role: 'user', parts: [{ text: texto }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens },
  };
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const res = await chamarGemini(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, tarefa);
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 4000 * tentativa)); continue; }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const c = data?.candidates?.[0];
    const t = (c?.content?.parts?.map((p) => p.text).join('') || '').trim();
    if (!t) throw new Error(`a IA não respondeu (${c?.finishReason || data?.promptFeedback?.blockReason || 'sem motivo'})`);
    return c?.finishReason === 'MAX_TOKENS' ? `${t}\n\n_(resposta resumida por tamanho)_` : t;
  }
  throw new Error('a IA está no limite de uso agora; tente de novo em alguns minutos');
}

// Converte um PDF (base64) em texto, preservando artigos e numeração
export async function lerDocumento(base64, mimetype) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: String(mimetype || 'application/pdf').split(';')[0], data: base64 } },
      { text: 'Transcreva o conteúdo integral deste documento em texto simples, em português, preservando títulos, capítulos, artigos, parágrafos e incisos com sua numeração. Não resuma e não comente. Omita apenas assinaturas e carimbos.' },
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 65000 },
  };
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const res = await chamarGemini(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'Leitura de documentos');
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 3000 * tentativa)); continue; }
    if (!res.ok) throw new Error(`Gemini documento ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return (data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '').trim();
  }
  throw new Error('Gemini indisponível para ler o documento');
}
