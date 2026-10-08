import { config } from './config.js';

const SYSTEM = `Você é o assistente interno da Alpha Condomínios, administradora de condomínios em Belo Horizonte.
Você lê mensagens de WhatsApp (grupos de condomínios e conversas privadas) e prepara, para a administração,
um resumo e uma sugestão de resposta. Quem decide se e como responder é sempre um humano.

Tipos de conversa:
- MORADORES: grupo aberto com os condôminos. Tudo que for sugerido será lido por todos.
- SÍNDICO: grupo interno entre a administradora e o síndico.
- CONSELHO: grupo interno com o conselho fiscal.
- PRIVADO: conversa individual.

Regras:
- Responda SOMENTE com JSON válido no formato pedido.
- "precisa_resposta" é true apenas quando há dúvida, pedido, reclamação ou problema que a administração deveria responder.
  Conversa entre participantes, agradecimentos, bom dia, figurinhas e assuntos que a administração já respondeu no histórico são false.
- "urgencia" alta: risco à segurança ou ao patrimônio (vazamento, incêndio, elevador parado com pessoa, portão aberto,
  falta geral de água/energia) ou prazo legal/financeiro iminente.
- A sugestão deve ser curta, cordial e profissional, em português do Brasil, adequada ao público da conversa, pronta para colar.
- Nunca invente regras, valores, datas, prazos ou nomes de prestadores. Se faltar informação, sugira acolher e dizer que a administração vai verificar.
- O "contexto de outros grupos do mesmo condomínio" serve para você entender a situação.
  Em MORADORES ou PRIVADO, nunca revele discussões internas (síndico/conselho), valores, inadimplência ou decisões ainda não anunciadas.
  Se algo desse contexto for útil para quem vai responder, escreva em "nota_interna".
- Em MORADORES, nunca exponha dados pessoais nem inadimplência de ninguém; nesses casos sugira tratar no privado.
- Em PRIVADO, pode tratar dos assuntos da própria pessoa, mas nunca de outros moradores.`;

const FORMATO = `{
  "categoria": "duvida" | "reclamacao" | "manutencao" | "financeiro" | "assembleia" | "seguranca" | "barulho" | "aviso" | "conversa" | "outro",
  "urgencia": "baixa" | "media" | "alta",
  "precisa_resposta": true | false,
  "resumo": "uma frase curta",
  "sugestao": "texto da resposta sugerida, ou null se não precisa de resposta",
  "nota_interna": "observação só para a administração (ex.: algo decidido no grupo do síndico que ajuda a responder), ou null"
}`;

const TIPO = { moradores: 'MORADORES', sindico: 'SÍNDICO', conselho: 'CONSELHO', privado: 'PRIVADO', outro: 'OUTRO' };

const fmt = (d) =>
  new Date(d).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });

const who = (m) => (m.from_me ? `${config.ownerName} (administração)` : m.author_name || 'Participante');

function describeChat(chat) {
  const condo = chat.condo_name ? `Condomínio: ${chat.condo_name}` : 'Condomínio: não identificado';
  if (chat.kind === 'privado') return `Conversa PRIVADA com ${chat.name || 'contato'}. ${condo}.`;
  return `Grupo "${chat.name || chat.jid}" — tipo ${TIPO[chat.kind] || 'OUTRO'}. ${condo}.`;
}

export async function analyze({ chat, history, related, message }) {
  const historico = history.map((m) => `[${fmt(m.ts)}] ${who(m)}: ${m.text}`).join('\n') || '(sem histórico)';
  const relacionado = related.length
    ? related.map((m) => `[${fmt(m.ts)}] (${TIPO[m.kind]} · ${m.chat_name}) ${who(m)}: ${m.text}`).join('\n')
    : '(nenhum)';
  const citada = message.quotedText ? `\n(respondendo a: "${message.quotedText}")` : '';

  const prompt = `${describeChat(chat)}

Histórico recente desta conversa:
${historico}

Contexto de outros grupos do mesmo condomínio (uso interno):
${relacionado}

Mensagem a analisar:
[${fmt(message.ts)}] ${message.authorName || chat.name || 'Participante'}: ${message.text}${citada}

Responda em JSON exatamente neste formato:
${FORMATO}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return normalizeResult(JSON.parse(raw.replace(/```json|```/g, '').trim()));
}

function normalizeResult(a) {
  const urgencias = ['baixa', 'media', 'alta'];
  const precisa = a?.precisa_resposta === true;
  return {
    categoria: a?.categoria || 'outro',
    urgencia: urgencias.includes(a?.urgencia) ? a.urgencia : 'baixa',
    precisa_resposta: precisa,
    resumo: a?.resumo || '',
    sugestao: precisa && a?.sugestao ? String(a.sugestao) : null,
    nota_interna: a?.nota_interna ? String(a.nota_interna) : null,
  };
}
