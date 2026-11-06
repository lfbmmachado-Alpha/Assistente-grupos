// Fecha pendências pelo conteúdo: a IA vê o que veio depois de cada pedido (respostas da equipe,
// o morador dizendo que resolveu) e decide o que já foi tratado. Não depende de citar a mensagem.
import { pool, getSetting, setSetting } from './db.js';
import { gerarJSON } from './gemini.js';
import { digitos } from './util.js';

const q = (sql, params) => pool.query(sql, params);
export const ASSINATURA = /alpha\s+(administradora|condom[ií]nios)/i;

// Quem assina "Alpha Administradora" é da equipe: guarda o número/LID para reconhecer nas próximas
export async function aprenderEquipePelaAssinatura(msg) {
  if (msg.fromMe || !ASSINATURA.test(msg.text || '')) return false;
  const ids = [digitos(msg.authorJid), digitos(msg.authorAlt)].filter(Boolean);
  if (!ids.length) return false;
  let lista = [];
  try { lista = JSON.parse(await getSetting('equipe_auto', '[]')); } catch {}
  const novos = ids.filter((i) => !lista.includes(i));
  if (!novos.length) return false;
  await setSetting('equipe_auto', JSON.stringify([...lista, ...novos]));
  console.log(`[equipe] ${msg.authorName || ids[0]} reconhecido(a) pela assinatura`);
  return true;
}

const INSTR = `Você controla as PENDÊNCIAS de uma administradora de condomínios (Alpha) num grupo de WhatsApp.
Recebe a lista de pendências abertas (pedidos, cobranças, reclamações de moradores ou do síndico) e as mensagens que vieram DEPOIS delas.
Marque como resolvida a pendência que:
- recebeu resposta da EQUIPE ALPHA sobre aquele assunto (mesmo sem citar a mensagem; mesmo que a resposta seja "vou verificar e retorno",
  pois o pedido foi atendido/encaminhado), ou
- o próprio autor ou outro participante indicou que se resolveu ("já arrumaram", "resolvido", "obrigado, deu certo"), ou
- perdeu o sentido (o morador desistiu, foi só um comentário).
NÃO marque se a equipe falou de outro assunto, ou se o morador voltou a cobrar sem resposta.
Responda SOMENTE JSON: {"resolvidas": [ids], "motivo": {"id": "poucas palavras"}}`;

const fmt = (d) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// Avalia as pendências abertas de um chat com o que veio depois
export async function revisarChat(chatJid) {
  const pend = (await q(
    `SELECT id, ts, author_name, text, summary FROM messages WHERE chat_jid = $1 AND status = 'pendente' ORDER BY ts LIMIT 60`, [chatJid]
  )).rows;
  if (!pend.length) return 0;
  const depois = (await q(
    `SELECT id, ts, author_name, text, from_me FROM messages WHERE chat_jid = $1 AND ts > $2 AND status IS DISTINCT FROM 'pendente'
     ORDER BY ts LIMIT 300`, [chatJid, pend[0].ts]
  )).rows;
  if (!depois.length) return 0;

  // agrupa por assunto: o id do grupo é o da primeira mensagem
  const grupos = new Map();
  for (const p of pend) {
    const chave = p.summary || p.id;
    if (!grupos.has(chave)) grupos.set(chave, { id: p.id, ts: p.ts, autor: p.author_name, resumo: p.summary, textos: [], ids: [] });
    const g = grupos.get(chave);
    g.textos.push(p.text);
    g.ids.push(p.id);
  }
  const lista = [...grupos.values()];
  const entrada =
    `PENDÊNCIAS ABERTAS:\n${lista.map((g) => `id=${g.id} [${fmt(g.ts)}] ${g.autor || 'Participante'}: ${g.resumo ? `(${g.resumo}) ` : ''}${g.textos.join(' / ').replace(/\s+/g, ' ').slice(0, 500)}`).join('\n')}` +
    `\n\nMENSAGENS DEPOIS:\n${depois.map((m) => {
      const equipe = m.from_me || ASSINATURA.test(m.text || '');
      return `[${fmt(m.ts)}] ${equipe ? `EQUIPE ALPHA (${m.author_name || ''})` : m.author_name || 'Participante'}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 400)}`;
    }).join('\n')}`;

  const r = await gerarJSON(INSTR, entrada);
  const resolvidos = new Set((r?.resolvidas || []).map(String));
  let n = 0;
  for (const g of lista) {
    if (!resolvidos.has(String(g.id))) continue;
    // só fecha se houve mensagem depois deste pedido
    if (!depois.some((m) => new Date(m.ts) > new Date(g.ts))) continue;
    await q(`UPDATE messages SET status = 'respondida' WHERE id = ANY($1)`, [g.ids]);
    n++;
  }
  if (n) console.log(`[pendências] ${chatJid}: ${n} assunto(s) fechado(s) pela IA`);
  return n;
}

// Revisão geral: chats com pendências e mensagens novas desde a última revisão
let rodando = false;
export async function revisarTudo({ forcar = false } = {}) {
  if (rodando) return null;
  rodando = true;
  let chats = 0, fechadas = 0;
  try {
    const rows = (await q(`
      SELECT p.chat_jid, MAX(m.ts) AS ultima
      FROM (SELECT DISTINCT chat_jid FROM messages WHERE status = 'pendente') p
      JOIN messages m ON m.chat_jid = p.chat_jid
      GROUP BY p.chat_jid`)).rows;
    for (const r of rows) {
      const chave = `pend_rev_${r.chat_jid}`;
      const ult = await getSetting(chave);
      if (!forcar && ult && new Date(ult) >= new Date(r.ultima)) continue;
      try {
        fechadas += await revisarChat(r.chat_jid);
        chats++;
        await setSetting(chave, new Date(r.ultima).toISOString());
      } catch (e) {
        console.error('[pendências]', r.chat_jid, e.message);
      }
    }
  } finally {
    rodando = false;
  }
  return { chats, fechadas };
}

// Depois de uma resposta da equipe, revisa aquele chat (com uma pequena espera para juntar mensagens seguidas)
const agendados = new Map();
export function revisarEmBreve(chatJid, segundos = 60) {
  clearTimeout(agendados.get(chatJid));
  agendados.set(chatJid, setTimeout(() => {
    agendados.delete(chatJid);
    revisarChat(chatJid).catch((e) => console.error('[pendências]', e.message));
  }, segundos * 1000));
}

// Contagem por assunto (várias mensagens do mesmo pedido contam uma vez)
export async function contarAssuntos() {
  const r = await q(`SELECT COUNT(DISTINCT (chat_jid, COALESCE(summary, id)))::int AS n FROM messages WHERE status = 'pendente'`);
  return r.rows[0].n;
}
