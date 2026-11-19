// Perguntas do Luiz sobre um condomínio: responde com base nas conversas, na base de conhecimento e nos documentos.
import { pool } from './db.js';
import { gerarJSON, gerarTexto } from './gemini.js';
import { fatosDo, docsDo } from './knowledge.js';

const q = (sql, params) => pool.query(sql, params);

const INSTR = `Você é o assistente interno de Luiz Felipe, da Alpha Condomínios. Ele vai te fazer perguntas sobre um condomínio
para saber o que está acontecendo. Responda com base SOMENTE no material fornecido (conversas dos grupos, base de conhecimento e documentos).
- Seja direto e organizado, em português do Brasil, formatado para WhatsApp (use *negrito* e listas com •, sem tabelas).
- Cite datas e quem disse quando for relevante ("em 28/10 o síndico pediu...").
- Aponte pendências, cobranças sem resposta, reclamações repetidas e o clima do grupo quando fizer sentido.
- Se a informação não estiver no material, diga claramente que ainda não sabe e o que seria preciso para saber.
- Pode incluir dados internos (é só para o Luiz).
Responda SOMENTE com JSON: {"resposta": "..."}`;

const ORIGEM = { moradores: 'moradores', sindico: 'síndico', conselho: 'conselho', privado: 'privado' };

export async function perguntar(condo, pergunta, dias = 30) {
  const msgs = (await q(
    `SELECT m.*, c.kind AS chat_kind FROM messages m JOIN chats c ON c.jid = m.chat_jid
     WHERE c.condo_key = $1 AND m.ts > now() - ($2 || ' days')::interval ORDER BY m.ts DESC LIMIT 1500`,
    [condo.condo_key, String(dias)]
  )).rows.reverse();
  const fatos = await fatosDo(condo.condo_key);
  const docs = await docsDo(condo.condo_key);
  const linhas = msgs.map((m) => {
    const quando = new Date(m.ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const quem = m.from_me ? `EQUIPE ALPHA (${m.author_name || ''})` : m.author_name || 'Participante';
    return `[${quando}] (${ORIGEM[m.chat_kind] || m.chat_kind}) ${quem}: ${m.text}`;
  });
  const hoje = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const entrada =
    `HOJE: ${hoje}\nCONDOMÍNIO: ${condo.condo_name}\n\nPERGUNTA DO LUIZ: ${pergunta}\n\n` +
    `BASE DE CONHECIMENTO:\n${fatos.map((f) => `- ${f.fato}`).join('\n') || '(vazia)'}\n\n` +
    (docs.length ? `DOCUMENTOS:\n${docs.map((d) => `=== ${d.titulo} ===\n${d.texto.slice(0, 60000)}`).join('\n\n')}\n\n` : '') +
    `CONVERSAS DOS ÚLTIMOS ${dias} DIAS (${msgs.length} mensagens):\n${linhas.join('\n') || '(nenhuma)'}`;
  const r = await gerarJSON(INSTR, entrada, { tarefa: 'Perguntas (!perguntar)' });
  return { resposta: r?.resposta || 'Não consegui montar a resposta.', mensagens: msgs.length };
}

// ---------- conversa livre no grupo de sugestões ----------
import { listCondos, getSetting, setSetting } from './db.js';
import { normalize } from './groups.js';

const INSTR_CONVERSA = `Você é o assistente interno de Luiz Felipe, da Alpha Condomínios (administradora em Belo Horizonte).
Você acompanha os grupos de WhatsApp dos condomínios e conversa com o Luiz sobre eles, como um gerente que leu tudo.
Responda com base SOMENTE no material fornecido: conversas recentes, base de conhecimento, pendências sem resposta e vistorias.
- Português do Brasil, direto, formatado para WhatsApp (*negrito*, listas com •, sem tabelas). Seja objetivo; detalhe quando pedirem.
- Para perguntas comparativas ("qual está mais delicado?", "onde há mais reclamação?"), compare os condomínios e explique o porquê
  com fatos concretos (o que foi dito, quando, quem), em ordem de gravidade.
- Considere como sinais de atenção: cobranças sem resposta, reclamações repetidas, tom irritado, problemas de segurança,
  vazamentos, elevador, obras atrasadas, conflitos, menção a trocar de administradora, vistoria atrasada.
- Se o material não for suficiente (ex.: grupos com poucas mensagens), diga isso claramente e não invente.
- Use o HISTÓRICO DA CONVERSA para entender perguntas de continuação ("e o segundo?", "detalha esse").
Responda direto com o texto da resposta (sem JSON).`;

async function getConversa() {
  try { return JSON.parse(await getSetting('conversa', '[]')); } catch { return []; }
}

// Condomínios citados no texto (todas as palavras do nome aparecem)
function citados(texto, condos) {
  const palavras = new Set(normalize(texto).split(' '));
  return condos
    .filter((c) => { const p = c.condo_key.split(' ').filter(Boolean); return p.join('').length >= 3 && p.every((x) => palavras.has(x)); })
    .sort((a, b) => b.condo_key.length - a.condo_key.length);
}

const SINAIS = /(ningu[eé]m (responde|resolve|retorn)|absurdo|descaso|reclama|urgente|vazament|infiltra|elevador|port[aã]o|insatisf|cobran|demora|aguardando|sem resposta|trocar de administradora|advogad|procon|risco|perigo|quebrad|parad)/i;

async function panorama(condos, dias) {
  const keys = condos.map((c) => c.condo_key);
  const msgs = (await q(
    `SELECT m.text, m.ts, m.author_name, m.from_me, m.status, m.summary, c.condo_key, c.kind FROM messages m JOIN chats c ON c.jid = m.chat_jid
     WHERE c.condo_key = ANY($1) AND m.ts > now() - ($2 || ' days')::interval ORDER BY m.ts DESC LIMIT 20000`,
    [keys, String(dias)]
  )).rows;
  const fatos = (await q(`SELECT condo_key, fato FROM fatos WHERE condo_key = ANY($1) ORDER BY atualizado_em DESC`, [keys])).rows;
  const visitas = (await q(
    `SELECT condo_key, MAX(COALESCE(entrada, saida, ultima_atividade)) AS ultima FROM visitas
     WHERE condo_key = ANY($1) AND tipo = 'ordinaria' GROUP BY condo_key`, [keys]
  ).catch(() => ({ rows: [] }))).rows;

  const fmt = (d) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const um = condos.length === 1;
  // pontua cada condomínio: pendências e mensagens com sinais de problema pesam mais
  const info = condos.map((c) => {
    const ms = msgs.filter((m) => m.condo_key === c.condo_key);
    const pend = new Set(ms.filter((m) => m.status === 'pendente').map((m) => m.summary || m.text)).size;
    const sinais = ms.filter((m) => !m.from_me && SINAIS.test(m.text || '')).length;
    return { c, ms, pend, sinais, nota: pend * 3 + sinais * 2 + Math.min(ms.length, 50) / 10 };
  }).sort((a, b) => b.nota - a.nota);
  const detalhados = um ? info : info.slice(0, 15);
  const resumidos = um ? [] : info.slice(15);

  const blocos = [];
  for (const x of detalhados) {
    const ms = x.ms.slice(0, um ? 400 : 45).reverse();
    const fs = fatos.filter((f) => f.condo_key === x.c.condo_key).slice(0, um ? 80 : 12);
    const vis = visitas.find((v) => v.condo_key === x.c.condo_key);
    blocos.push(
      `##### ${x.c.condo_name}\n` +
      `Mensagens no período: ${x.ms.length} · Pendências sem resposta: ${x.pend} · Mensagens com sinal de problema: ${x.sinais} · Última vistoria: ${vis?.ultima ? fmt(vis.ultima) : 'sem registro'}\n` +
      (fs.length ? `Base:\n${fs.map((f) => `- ${f.fato}`).join('\n')}\n` : '') +
      (ms.length ? `Conversas:\n${ms.map((m) => `[${fmt(m.ts)}] (${m.kind}) ${m.from_me || /alpha\s+(administradora|condom[ií]nios)/i.test(m.text || '') ? `EQUIPE ALPHA (${m.author_name || ''})` : m.author_name || 'Participante'}: ${String(m.text).replace(/\s+/g, ' ').slice(0, um ? 350 : 180)}`).join('\n')}` : 'Conversas: (nenhuma no período)')
    );
  }
  if (resumidos.length) {
    blocos.push(`##### Demais condomínios (menos sinais de atenção; só números)\n` +
      resumidos.map((x) => `- ${x.c.condo_name}: ${x.ms.length} msgs · ${x.pend} pendências · ${x.sinais} sinais`).join('\n'));
  }
  return blocos.join('\n\n');
}

export async function conversar(texto) {
  const condos = await listCondos();
  const alvo = citados(texto, condos);
  const escopo = alvo.length === 1 ? alvo : condos;
  const dias = alvo.length === 1 ? 30 : 14;
  const historico = await getConversa();
  const hoje = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const entrada =
    `AGORA: ${hoje}\n` +
    `ESCOPO: ${escopo.length === 1 ? `condomínio ${escopo[0].condo_name}` : `${escopo.length} condomínios acompanhados`} (últimos ${dias} dias)\n\n` +
    (historico.length ? `HISTÓRICO DA CONVERSA:\n${historico.map((h) => `LUIZ: ${h.p}\nVOCÊ: ${h.r}`).join('\n\n')}\n\n` : '') +
    `PERGUNTA DO LUIZ: ${texto}\n\nMATERIAL:\n${await panorama(escopo, dias)}`;

  const resposta = await gerarTexto(INSTR_CONVERSA, entrada);
  await setSetting('conversa', JSON.stringify([...historico, { p: texto.slice(0, 500), r: resposta.slice(0, 1500) }].slice(-6)));
  return { resposta, escopo: escopo.length === 1 ? escopo[0].condo_name : null, total: escopo.length };
}

export async function limparConversa() {
  await setSetting('conversa', '[]');
}
