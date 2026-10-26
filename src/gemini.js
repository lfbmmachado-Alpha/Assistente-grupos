import { config } from './config.js';

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
- Use o HISTÓRICO: se ali já houver a informação pedida (dita pela equipe ou pelo síndico),
  responda com ela. Se não houver, diga que vai verificar e retornar.
- NUNCA invente informação (valores, datas, nomes de fornecedores, horários, artigos de regimento).
  Se faltar dado, a sugestão deve dizer que vai verificar e retornar, ou fazer uma pergunta.
- Em grupo de moradores, nunca exponha inadimplência, valores devidos por unidade, dados pessoais ou
  conflitos internos. Para esses assuntos, sugira chamar a pessoa no privado.
- Use o CONTEXTO INTERNO (grupos de síndico/conselho) apenas para orientar o Luiz na nota_interna;
  não revele esse conteúdo na sugestão.

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

export async function analisar({ chat, historico, novas, interno }) {
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
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * tentativa)); continue; }
    if (!res.ok) throw new Error(`Gemini transcrição ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '').trim();
  }
  throw new Error('Gemini indisponível para transcrição');
}
