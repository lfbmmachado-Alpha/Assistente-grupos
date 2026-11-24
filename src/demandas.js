// Controle de PENDÊNCIAS levantadas nos grupos (fichas com ciclo de vida).
// Cada pedido/reclamação/problema vira uma ficha: aberta → encaminhada (a Alpha respondeu/prometeu) → agendada → concluída.
// "Vou verificar e retorno" NÃO fecha a ficha: só registra a promessa; se o retorno não vier no prazo, ela fica atrasada.
// Responsável = vistoriador do condomínio no quadro. Piloto: só os responsáveis em pendencias_piloto (começa com Nathan).
import { pool, getSetting, setSetting } from './db.js';
import { gerarJSON } from './gemini.js';
import { sendText } from './evolution.js';
import { normalize } from './groups.js';
import { universo } from './visitas.js';
import { gruposConfigurados } from './leituras.js';

const q = (sql, p) => pool.query(sql, p);
const OFFSET = 3 * 3600 * 1000;
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const ABERTOS = ['aberta', 'encaminhada', 'agendada'];

// Liderança direta (recebe as atrasadas da equipe). Pode ser trocada por !pendencias lideranca Nome = Líder
const LIDERANCA_PADRAO = { leandro: 'Janaina', samuel: 'Janaina', carlos: 'Kesse', kesse: 'Ederson', nathan: 'Ederson', janaina: 'Ederson' };

export async function initDemandas() {
  await q(`CREATE TABLE IF NOT EXISTS demandas (
    id SERIAL PRIMARY KEY, condo_key TEXT, condo_nome TEXT, chat_jid TEXT, titulo TEXT, detalhe TEXT,
    categoria TEXT, urgencia TEXT, autor TEXT, aberta_em TIMESTAMPTZ, prazo TIMESTAMPTZ,
    status TEXT DEFAULT 'aberta', promessa TEXT, agendado_para TIMESTAMPTZ, responsavel TEXT,
    atualizado_em TIMESTAMPTZ DEFAULT now(), concluida_em TIMESTAMPTZ, conclusao TEXT,
    historico JSONB DEFAULT '[]'::jsonb, msg_ids TEXT[])`);
  await q(`CREATE INDEX IF NOT EXISTS idx_dem_condo ON demandas (condo_key, status)`);
}

// ---------- datas ----------
const br = (d) => new Date(new Date(d).getTime() - OFFSET);
const fmt = (d) => { const x = br(d); return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}`; };
const fmtH = (d) => { const x = br(d); return `${fmt(d)} ${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}`; };
const diaSem = (d) => DIAS[br(d).getUTCDay()];
// soma dias úteis e fixa às 18h (horário de Brasília)
function diasUteis(inicio, n) {
  const x = br(inicio);
  let faltam = n;
  while (faltam > 0) {
    x.setUTCDate(x.getUTCDate() + 1);
    const d = x.getUTCDay();
    if (d !== 0 && d !== 6) faltam--;
  }
  x.setUTCHours(18, 0, 0, 0);
  return new Date(x.getTime() + OFFSET);
}
// prazo pela demanda (quando ninguém prometeu data)
function prazoPadrao(urgencia, aberta) {
  const a = new Date(aberta);
  if (urgencia === 'urgente') return new Date(a.getTime() + 4 * 3600 * 1000);
  if (urgencia === 'alta') return diasUteis(a, 1);
  if (urgencia === 'baixa') return diasUteis(a, 5);
  return diasUteis(a, 2);
}
// "AAAA-MM-DD HH:MM" (horário de Brasília) → Date
function lerDataIA(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 18, m[5] ? +m[5] : 0) + OFFSET);
}

// ---------- piloto e responsáveis ----------
export async function piloto() {
  try { return JSON.parse(await getSetting('pendencias_piloto', '["Nathan"]')); } catch { return ['Nathan']; }
}
async function lideranca() {
  try { return { ...LIDERANCA_PADRAO, ...JSON.parse(await getSetting('pendencias_lideranca', '{}')) }; } catch { return LIDERANCA_PADRAO; }
}
// condomínios (com grupo) dos responsáveis do piloto: [{condo_key, nome, responsavel, chats:[jid]}]
async function condominiosNoEscopo() {
  const pil = (await piloto()).map(normalize);
  const todos = pil.includes('todos');
  const { itens } = await universo();
  const alvo = itens.filter((i) => i.condo_key && (todos || pil.includes(normalize(i.vistoriador))));
  if (!alvo.length) return [];
  const chats = (await q(`SELECT jid, condo_key FROM chats WHERE condo_key = ANY($1) AND kind IN ('moradores','sindico','conselho')
                          AND COALESCE(ativo, TRUE)`, [alvo.map((i) => i.condo_key)])).rows;
  return alvo.map((i) => ({ condo_key: i.condo_key, nome: i.nome, responsavel: i.vistoriador, chats: chats.filter((c) => c.condo_key === i.condo_key).map((c) => c.jid) }))
    .filter((c) => c.chats.length);
}

// ---------- IA: ler as mensagens novas e atualizar as fichas ----------
const INSTR = `Você controla as PENDÊNCIAS da Alpha Administradora (administradora de condomínios) a partir das mensagens dos grupos de WhatsApp de UM condomínio.
Recebe: as fichas de pendência ABERTAS deste condomínio e as MENSAGENS NOVAS (marcadas EQUIPE ALPHA ou MORADOR/SÍNDICO).

1) NOVAS PENDÊNCIAS: crie uma ficha para cada demanda que precisa de ação/retorno da Alpha: pedido, reclamação, problema na área comum,
   pedido de orçamento, documento, 2ª via, cobrança de retorno, assunto do síndico para a administradora.
   NÃO crie para: conversa entre moradores, avisos, agradecimentos, "bom dia", assunto que a própria mensagem já resolve,
   ou algo que já tem ficha aberta (nesse caso, é atualização da ficha existente).
   Mensagens da EQUIPE ALPHA também podem criar ficha quando a própria equipe assume uma tarefa ("vamos solicitar orçamento do portão").
   Para cada nova: titulo (até 70 caracteres, claro: "Portão da garagem não fecha"), detalhe (1 frase), categoria
   (manutenção | segurança | limpeza | financeiro | documento | obra | convivência | administrativo | outro),
   urgencia: urgente (risco/segurança: vazamento grande, portão aberto ou travado, elevador com pessoa presa ou parado, falta geral de água/luz/gás, cheiro de gás),
             alta (equipamento comum parado: elevador, bomba, interfone geral, portão com defeito; infiltração ativa),
             normal (manutenção, orçamento, reclamação, documento, financeiro),
             baixa (sugestão, informação, melhoria sem pressa);
   autor (nome de quem levantou), msg_ids (ids das mensagens).
2) ATUALIZAÇÕES das fichas abertas (use o id da ficha):
   - "encaminhada": a Alpha respondeu e assumiu ("vou verificar", "já acionei o técnico", "vamos pedir orçamento"). Guarde em promessa o que foi
     dito (curto) e, se houver data/hora prometida ("retorno amanhã", "até sexta"), prazo_prometido no formato AAAA-MM-DD HH:MM.
   - "agendada": a Alpha marcou data para o serviço/visita → agendado_para AAAA-MM-DD HH:MM.
   - "concluida": a Alpha informou que resolveu/fez E/OU o morador confirmou ("já arrumaram", "resolvido", "obrigado, deu certo"). conclusao: curto.
   - "descartada": perdeu o sentido (morador desistiu, foi engano, não é com a administradora).
   - "cobrada": o morador voltou a cobrar sem ter tido retorno (isso deixa a ficha mais urgente).
   "vou verificar e retorno" NÃO conclui: é "encaminhada".
Datas relativas: use a data/hora da própria mensagem como referência. Hoje é informado na entrada.
Responda SOMENTE JSON:
{"novas":[{"titulo":"","detalhe":"","categoria":"","urgencia":"","autor":"","msg_ids":[]}],
 "atualizacoes":[{"id":0,"status":"","promessa":"","prazo_prometido":"","agendado_para":"","conclusao":"","nota":""}]}`;

async function analisarCondo(c, { desde = null } = {}) {
  const chave = `dem_cursor_${c.condo_key}`;
  const cursor = desde || (await getSetting(chave)) || new Date(Date.now() - 15 * 86400000).toISOString();
  const msgs = (await q(
    `SELECT id, ts, author_name, from_me, text FROM messages WHERE chat_jid = ANY($1) AND ts > $2 ORDER BY ts LIMIT 250`,
    [c.chats, cursor])).rows.filter((m) => (m.text || '').trim());
  if (!msgs.length) return { novas: 0, atualizadas: 0 };
  const abertas = (await q(`SELECT * FROM demandas WHERE condo_key = $1 AND status = ANY($2) ORDER BY id`, [c.condo_key, ABERTOS])).rows;
  const entrada = `Hoje: ${fmtH(new Date())} (${diaSem(new Date())}). Condomínio: ${c.nome}.\n\n` +
    `FICHAS ABERTAS:\n${abertas.length ? abertas.map((d) => `id=${d.id} [${d.status}] aberta ${fmtH(d.aberta_em)} por ${d.autor || '?'}: ${d.titulo}${d.promessa ? ` · Alpha disse: ${d.promessa}` : ''}`).join('\n') : '(nenhuma)'}\n\n` +
    `MENSAGENS NOVAS:\n${msgs.map((m) => `[${m.id}] ${fmtH(m.ts)} ${m.from_me ? 'EQUIPE ALPHA' : 'MORADOR/SÍNDICO'} ${m.author_name || ''}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}`;
  const r = await gerarJSON(INSTR, entrada, { leve: true, tarefa: 'Pendências (controle)' });
  if (!r) return { novas: 0, atualizadas: 0, erro: true }; // não avança o cursor: tenta de novo na próxima
  const porId = new Map(msgs.map((m) => [m.id, m]));
  let novas = 0, atualizadas = 0;
  for (const n of r.novas || []) {
    if (!n.titulo) continue;
    const ms = (n.msg_ids || []).map((i) => porId.get(i)).filter(Boolean);
    const aberta = ms.length ? ms[0].ts : msgs[msgs.length - 1].ts;
    const urg = ['urgente', 'alta', 'normal', 'baixa'].includes(n.urgencia) ? n.urgencia : 'normal';
    // evita duplicar: mesmo título aberto no condomínio
    const dup = abertas.find((d) => normalize(d.titulo) === normalize(n.titulo));
    if (dup) continue;
    await q(`INSERT INTO demandas (condo_key, condo_nome, chat_jid, titulo, detalhe, categoria, urgencia, autor, aberta_em, prazo, responsavel, msg_ids, historico)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [c.condo_key, c.nome, ms[0] ? c.chats[0] : c.chats[0], String(n.titulo).slice(0, 120), n.detalhe || null, n.categoria || 'outro', urg,
        n.autor || ms[0]?.author_name || null, aberta, prazoPadrao(urg, aberta), c.responsavel, ms.map((m) => m.id),
        JSON.stringify([{ em: new Date(aberta).toISOString(), ev: 'aberta', txt: n.detalhe || n.titulo }])]);
    novas++;
  }
  for (const a of r.atualizacoes || []) {
    const d = abertas.find((x) => x.id === Number(a.id));
    if (!d || !a.status) continue;
    const hist = [...(d.historico || []), { em: new Date().toISOString(), ev: a.status, txt: a.conclusao || a.promessa || a.nota || '' }];
    if (a.status === 'concluida' || a.status === 'descartada') {
      await q(`UPDATE demandas SET status = $2, concluida_em = now(), conclusao = $3, historico = $4, atualizado_em = now() WHERE id = $1`,
        [d.id, a.status, a.conclusao || a.nota || null, JSON.stringify(hist)]);
    } else if (a.status === 'encaminhada') {
      const prom = lerDataIA(a.prazo_prometido);
      await q(`UPDATE demandas SET status = 'encaminhada', promessa = COALESCE($2, promessa), prazo = COALESCE($3, prazo), historico = $4, atualizado_em = now() WHERE id = $1`,
        [d.id, a.promessa || null, prom, JSON.stringify(hist)]);
    } else if (a.status === 'agendada') {
      const ag = lerDataIA(a.agendado_para);
      await q(`UPDATE demandas SET status = 'agendada', agendado_para = COALESCE($2, agendado_para), promessa = COALESCE($3, promessa), historico = $4, atualizado_em = now() WHERE id = $1`,
        [d.id, ag, a.promessa || null, JSON.stringify(hist)]);
    } else if (a.status === 'cobrada') {
      // morador cobrou de novo: sobe a urgência um degrau e marca no histórico
      const prox = { baixa: 'normal', normal: 'alta', alta: 'urgente', urgente: 'urgente' }[d.urgencia] || 'alta';
      await q(`UPDATE demandas SET urgencia = $2, historico = $3, atualizado_em = now() WHERE id = $1`, [d.id, prox, JSON.stringify(hist)]);
    } else continue;
    atualizadas++;
  }
  await setSetting(chave, new Date(msgs[msgs.length - 1].ts).toISOString());
  return { novas, atualizadas };
}

export async function analisarPendencias({ desde = null } = {}) {
  const condos = await condominiosNoEscopo();
  let novas = 0, atualizadas = 0;
  for (const c of condos) {
    try {
      const r = await analisarCondo(c, { desde });
      novas += r.novas; atualizadas += r.atualizadas;
    } catch (e) { console.error(`[pendências] ${c.nome}:`, e.message); }
  }
  if (novas || atualizadas) console.log(`[pendências] ${condos.length} condomínio(s): ${novas} nova(s), ${atualizadas} atualizada(s)`);
  return { condos: condos.length, novas, atualizadas };
}

// ---------- situação ----------
function atrasada(d, agora = new Date()) {
  if (d.status === 'agendada') return d.agendado_para && new Date(d.agendado_para).getTime() + 86400000 < agora.getTime();
  return d.prazo && new Date(d.prazo) < agora;
}
export async function listar({ responsavel = null } = {}) {
  const rows = (await q(`SELECT * FROM demandas WHERE status = ANY($1) ORDER BY aberta_em`, [ABERTOS])).rows;
  const pil = (await piloto()).map(normalize);
  return rows.filter((d) => (pil.includes('todos') || pil.includes(normalize(d.responsavel || ''))) &&
    (!responsavel || normalize(d.responsavel || '') === normalize(responsavel)))
    .map((d) => ({ ...d, atrasada: atrasada(d) }));
}

const URG = { urgente: '🔴', alta: '🟠', normal: '🟡', baixa: '⚪' };
function linhaFicha(d) {
  const dias = Math.floor((Date.now() - new Date(d.aberta_em)) / 86400000);
  const quando = d.status === 'agendada' && d.agendado_para ? `agendada p/ ${diaSem(d.agendado_para)} ${fmtH(d.agendado_para)}`
    : d.atrasada ? `prazo era ${fmtH(d.prazo)}` : `prazo ${diaSem(d.prazo)} ${fmtH(d.prazo)}`;
  return `${URG[d.urgencia] || '🟡'} *#${d.id} ${d.condo_nome}* — ${d.titulo}\n` +
    `   ${d.autor ? `${d.autor} · ` : ''}aberta ${fmt(d.aberta_em)} (${dias === 0 ? 'hoje' : dias === 1 ? 'há 1 dia' : `há ${dias} dias`}) · ${quando}` +
    (d.promessa ? `\n   _Alpha disse: "${String(d.promessa).slice(0, 90)}"_` : '\n   _sem retorno da Alpha ainda_');
}
export function relatorioResponsavel(nome, fichas) {
  const atr = fichas.filter((d) => d.atrasada);
  const ag = fichas.filter((d) => !d.atrasada && d.status === 'agendada');
  const prazo = fichas.filter((d) => !d.atrasada && d.status !== 'agendada');
  const partes = [`📌 *Pendências — ${nome}* · ${diaSem(new Date())} ${fmt(new Date())}\n${fichas.length} aberta(s)${atr.length ? ` · ⚠️ *${atr.length} atrasada(s)*` : ''}`];
  if (atr.length) partes.push(`⚠️ *Atrasadas (${atr.length})*\n${atr.map(linhaFicha).join('\n\n')}`);
  if (prazo.length) partes.push(`🕒 *No prazo (${prazo.length})*\n${prazo.map(linhaFicha).join('\n\n')}`);
  if (ag.length) partes.push(`📅 *Agendadas (${ag.length})*\n${ag.map(linhaFicha).join('\n\n')}`);
  if (!fichas.length) partes.push('🎉 Nenhuma pendência aberta.');
  partes.push('_Para dar baixa, é só responder ao morador no grupo do condomínio: a IA acompanha e fecha a ficha._');
  return partes.join('\n\n');
}

// visão geral para o grupo de sugestões
export async function visaoGeral(filtro = '') {
  const fichas = await listar({ responsavel: filtro || null });
  if (filtro) return [relatorioResponsavel(filtro, fichas)];
  const por = new Map();
  for (const d of fichas) por.set(d.responsavel || 'Sem responsável', [...(por.get(d.responsavel || 'Sem responsável') || []), d]);
  const pil = await piloto();
  const cab = `📌 *Pendências* (piloto: ${pil.join(', ')})\n${fichas.length} aberta(s) · ⚠️ ${fichas.filter((d) => d.atrasada).length} atrasada(s)\n\n` +
    [...por.entries()].map(([p, l]) => `• *${p}*: ${l.length} aberta(s), ${l.filter((d) => d.atrasada).length} atrasada(s)`).join('\n');
  return [cab, ...[...por.entries()].map(([p, l]) => relatorioResponsavel(p, l))];
}

export async function detalhe(id) {
  const d = (await q('SELECT * FROM demandas WHERE id = $1', [id])).rows[0];
  if (!d) return `Não achei a pendência #${id}.`;
  const hist = (d.historico || []).map((h) => `• ${fmtH(h.em)} — ${h.ev}${h.txt ? `: ${h.txt}` : ''}`).join('\n');
  return `📌 *#${d.id} ${d.condo_nome}* — ${d.titulo}\n${d.detalhe || ''}\n\n` +
    `Status: *${d.status}*${atrasada(d) && ABERTOS.includes(d.status) ? ' (⚠️ atrasada)' : ''} · urgência ${d.urgencia} · ${d.categoria}\n` +
    `Responsável: ${d.responsavel || '—'} · levantada por ${d.autor || '—'} em ${fmtH(d.aberta_em)}\n` +
    `Prazo: ${d.prazo ? fmtH(d.prazo) : '—'}${d.agendado_para ? ` · agendada para ${fmtH(d.agendado_para)}` : ''}\n` +
    (d.promessa ? `Alpha disse: "${d.promessa}"\n` : '') + (d.conclusao ? `Conclusão: ${d.conclusao}\n` : '') +
    `\n*Histórico*\n${hist || '—'}\n\n!pendencia concluir ${d.id} · !pendencia descartar ${d.id} · !pendencia prazo ${d.id} dd/mm`;
}
export async function mudarStatus(id, status, nota = '') {
  const d = (await q('SELECT * FROM demandas WHERE id = $1', [id])).rows[0];
  if (!d) return null;
  const hist = [...(d.historico || []), { em: new Date().toISOString(), ev: `${status} (manual)`, txt: nota }];
  const fecha = status === 'concluida' || status === 'descartada';
  await q(`UPDATE demandas SET status = $2, historico = $3, atualizado_em = now(), concluida_em = ${fecha ? 'now()' : 'NULL'},
           conclusao = ${fecha ? '$4' : 'conclusao'} WHERE id = $1`, fecha ? [id, status, JSON.stringify(hist), nota || null] : [id, status, JSON.stringify(hist)]);
  return d;
}
export async function mudarPrazo(id, data) {
  const m = String(data).match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:\s+(\d{1,2})[:h](\d{2})?)?/);
  if (!m) return null;
  const ano = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : br(new Date()).getUTCFullYear();
  const quando = new Date(Date.UTC(ano, +m[2] - 1, +m[1], m[4] ? +m[4] : 18, m[5] ? +m[5] : 0) + OFFSET);
  const d = (await q('SELECT * FROM demandas WHERE id = $1', [id])).rows[0];
  if (!d) return null;
  const hist = [...(d.historico || []), { em: new Date().toISOString(), ev: 'prazo (manual)', txt: fmtH(quando) }];
  await q(`UPDATE demandas SET prazo = $2, historico = $3, atualizado_em = now() WHERE id = $1`, [id, quando, JSON.stringify(hist)]);
  return quando;
}

// ---------- envios: todo dia útil 08:00 no grupo COND. de cada responsável; atrasadas também para a liderança ----------
export async function enviarRelatorios({ so = null } = {}) {
  const grupos = await gruposConfigurados(); // { jid, nome, lider } (COND. NATHAN → Nathan)
  const grupoDe = (p) => grupos.find((g) => normalize(g.lider) === normalize(p));
  const fichas = await listar();
  const pessoas = [...new Set([...(await piloto()).filter((p) => normalize(p) !== 'todos'), ...fichas.map((d) => d.responsavel).filter(Boolean)])];
  const lid = await lideranca();
  const atrasadasDoLider = new Map();
  let n = 0;
  for (const p of pessoas) {
    if (so && normalize(so) !== normalize(p)) continue;
    const minhas = fichas.filter((d) => normalize(d.responsavel || '') === normalize(p));
    const g = grupoDe(p);
    if (g) { await sendText(g.jid, relatorioResponsavel(p, minhas)); n++; }
    const l = lid[normalize(p)];
    const atr = minhas.filter((d) => d.atrasada);
    if (l && atr.length) atrasadasDoLider.set(l, [...(atrasadasDoLider.get(l) || []), ...atr]);
  }
  for (const [l, atr] of atrasadasDoLider) {
    const g = grupoDe(l);
    if (!g || (so && normalize(so) !== normalize(l))) continue;
    const por = [...new Set(atr.map((d) => d.responsavel))];
    await sendText(g.jid, `⚠️ *Pendências atrasadas da sua equipe — ${l}*\n${atr.length} atrasada(s): ${por.map((p) => `${p} (${atr.filter((d) => d.responsavel === p).length})`).join(', ')}\n\n` +
      atr.map(linhaFicha).join('\n\n'));
    n++;
  }
  return n;
}
export async function rodarPendencias() {
  const agora = br(new Date());
  const dow = agora.getUTCDay();
  const min = agora.getUTCHours() * 60 + agora.getUTCMinutes();
  const hoje = agora.toISOString().slice(0, 10);
  const [h, m] = (await getSetting('pendencias_hora', '08:00')).split(':').map(Number);
  if (dow >= 1 && dow <= 6 && min >= h * 60 + m && !(await getSetting(`pend_env_${hoje}`))) {
    await setSetting(`pend_env_${hoje}`, '1');
    await analisarPendencias().catch((e) => console.error('[pendências]', e.message));
    const n = await enviarRelatorios();
    if (n) console.log(`[pendências] relatório enviado para ${n} grupo(s)`);
  }
}
export async function definirPiloto(lista) { await setSetting('pendencias_piloto', JSON.stringify(lista)); }
export async function definirLider(pessoa, lider) {
  let m = {};
  try { m = JSON.parse(await getSetting('pendencias_lideranca', '{}')); } catch {}
  m[normalize(pessoa)] = lider;
  await setSetting('pendencias_lideranca', JSON.stringify(m));
}
