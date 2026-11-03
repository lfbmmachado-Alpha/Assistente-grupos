// Período de estudo: condomínio novo primeiro aprende (lê, monta a base, aprende com a equipe) e só depois sugere.
import { pool, getSetting, setSetting, listCondos, chatsOfCondo, saveMessage, linkContact } from './db.js';
import { fetchMessages } from './evolution.js';
import { parseMessage } from './parse.js';
import { isEquipe, sendToSuggestionGroup, getList } from './util.js';
import { aprender, salvarExemplo, fatosDo, contarExemplos } from './knowledge.js';

const q = (sql, params) => pool.query(sql, params);
const DIAS_PADRAO = () => Number(process.env.ESTUDO_DIAS || 7);

async function getEstudos() {
  try { return JSON.parse(await getSetting('estudo', '{}')); } catch { return {}; }
}
async function salvarEstudos(e) {
  await setSetting('estudo', JSON.stringify(e));
}

// Na primeira vez, os condomínios que já estavam funcionando ficam liberados (não voltam a estudar)
export async function initEstudo() {
  if (await getSetting('estudo')) return;
  const e = {};
  const agora = new Date().toISOString();
  for (const k of await getList('test_condos')) e[k] = { inicio: agora, dias: 0, liberado: agora };
  await salvarEstudos(e);
}

// Situação do condomínio: { estudando: bool, fim: Date }. Cria o estudo se o condomínio for novo.
export async function situacaoEstudo(condoKey) {
  if (!condoKey) return { estudando: false };
  const e = await getEstudos();
  if (!e[condoKey]) {
    e[condoKey] = { inicio: new Date().toISOString(), dias: DIAS_PADRAO() };
    await salvarEstudos(e);
    console.log(`[estudo] ${condoKey}: início do estudo (${DIAS_PADRAO()} dias)`);
  }
  const s = e[condoKey];
  if (s.liberado) return { estudando: false };
  const fim = new Date(new Date(s.inicio).getTime() + s.dias * 86400000);
  return { estudando: Date.now() < fim.getTime(), fim };
}

export async function iniciarEstudo(condoKey, dias = DIAS_PADRAO()) {
  const e = await getEstudos();
  e[condoKey] = { inicio: new Date().toISOString(), dias };
  await salvarEstudos(e);
}
export async function alterarDias(condoKey, dias) {
  const e = await getEstudos();
  if (!e[condoKey]) e[condoKey] = { inicio: new Date().toISOString(), dias };
  else { e[condoKey].dias = dias; delete e[condoKey].liberado; }
  await salvarEstudos(e);
}
export async function liberar(condoKey) {
  const e = await getEstudos();
  e[condoKey] = { ...(e[condoKey] || { inicio: new Date().toISOString(), dias: 0 }), liberado: new Date().toISOString() };
  await salvarEstudos(e);
}

// ---------- importar o que já foi conversado desde que o número entrou no grupo ----------
export async function importarHistorico(condoKey) {
  const grupos = (await chatsOfCondo(condoKey)).filter((c) => c.kind !== 'privado' && c.kind !== 'outro');
  let total = 0, novas = 0, exemplos = 0;
  for (const g of grupos) {
    let registros = [];
    try {
      registros = await fetchMessages(g.jid, 1500);
    } catch (e) {
      console.error(`[estudo] histórico de "${g.name}" indisponível:`, e.message);
      continue;
    }
    const msgs = registros.map(parseMessage).filter(Boolean).sort((a, b) => a.ts - b.ts);
    const porId = new Map();
    for (const m of msgs) {
      total++;
      m.equipe = await isEquipe(m);
      if (await saveMessage({ ...m, fromMe: m.equipe, kind: g.kind })) novas++;
      porId.set(m.id, m);
      if (g.kind === 'moradores' && !m.equipe) {
        await linkContact(m.authorJid, m.authorName, condoKey);
        await linkContact(m.authorAlt, m.authorName, condoKey);
      }
    }
    // Respostas da equipe que citam a pergunta viram exemplo
    for (const m of msgs) {
      if (!m.equipe || !m.quotedId || m.text.length < 15) continue;
      const alvo = porId.get(m.quotedId);
      if (alvo && !alvo.equipe) {
        await salvarExemplo(condoKey, g.kind, alvo.text, m.text, m.authorName);
        exemplos++;
      }
    }
  }
  console.log(`[estudo] ${condoKey}: histórico importado (${total} lidas, ${novas} novas, ${exemplos} exemplos)`);
  return { total, novas, exemplos, grupos: grupos.length };
}

// Roda o aprendizado só deste condomínio até consumir tudo o que estiver pendente
export async function aprenderTudo(condoKey) {
  const resumo = { novos: 0, atualizados: 0, removidos: 0 };
  for (let i = 0; i < 15; i++) {
    const r = await aprender({ forcar: true, condos: [condoKey] });
    if (r.ocupado) { await new Promise((res) => setTimeout(res, 20000)); continue; }
    resumo.novos += r.novos; resumo.atualizados += r.atualizados; resumo.removidos += r.removidos;
    if (!r.condominios) break;
  }
  return resumo;
}

export async function resumoCondo(condoKey) {
  const msgs = (await q(
    `SELECT COUNT(*)::int AS n FROM messages m JOIN chats c ON c.jid = m.chat_jid WHERE c.condo_key = $1`, [condoKey]
  )).rows[0].n;
  const fatos = (await fatosDo(condoKey)).length;
  const ex = (await contarExemplos()).find((x) => x.condo_key === condoKey)?.n || 0;
  return { msgs, fatos, exemplos: ex };
}

export async function listarEstudos() {
  const e = await getEstudos();
  const condos = await listCondos();
  const out = [];
  for (const [k, s] of Object.entries(e)) {
    if (s.liberado) continue;
    const c = condos.find((x) => x.condo_key === k);
    const fim = new Date(new Date(s.inicio).getTime() + s.dias * 86400000);
    out.push({ condo_key: k, nome: c?.condo_name || k, fim, ...(await resumoCondo(k)) });
  }
  return out.sort((a, b) => a.fim - b.fim);
}

// ---------- fim do estudo: roda de 10 em 10 minutos ----------
let verificando = false;
export async function verificarEstudos() {
  if (verificando) return;
  verificando = true;
  try {
    const e = await getEstudos();
    const condos = await listCondos();
    for (const [k, s] of Object.entries(e)) {
      if (s.liberado) continue;
      const fim = new Date(s.inicio).getTime() + s.dias * 86400000;
      if (Date.now() < fim) continue;
      await aprenderTudo(k);
      const r = await resumoCondo(k);
      const nome = condos.find((c) => c.condo_key === k)?.condo_name || k;
      await liberar(k);
      await sendToSuggestionGroup(
        `🎓 *Estudo concluído: ${nome}*\n\n📨 ${r.msgs} mensagens lidas\n🧠 ${r.fatos} fatos na base\n🎓 ${r.exemplos} respostas da equipe aprendidas\n\n` +
        `A partir de agora envio as sugestões deste condomínio.\nConfira o que aprendi com: !base ${nome}`
      );
      console.log(`[estudo] ${k}: estudo concluído`);
    }
  } finally {
    verificando = false;
  }
}
