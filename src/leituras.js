// Controle de LEITURAS mensais (água/gás) dos condomínios.
// - Cadastro: condomínio + líder responsável (da planilha LEITURAS_2026; mantido por comando).
// - Leitura feita: vem do grupo de controle de leituras (a lista "* *Nome* (Pessoa) dd/mm" que a equipe manda),
//   ou à mão (!leitura feita Nome dd/mm).
// - Próxima leitura: mesmo dia do mês da última leitura, no mês seguinte. Entra na semana (seg–dom) em que cai.
// - Avisos: segunda de manhã, a lista da semana de cada líder no grupo dele; todo dia no fim da tarde, feitas e a fazer.
import { pool, getSetting, setSetting } from './db.js';
import { sendText } from './evolution.js';
import { normalize } from './groups.js';
import { pontuar } from './casar.js';
import { sendToSuggestionGroup } from './util.js';
import { LEITURAS_CADASTRO, LEITURAS_HISTORICO } from './leituras-padrao.js';

const q = (sql, p) => pool.query(sql, p);
const OFFSET = 3 * 3600 * 1000;
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

// ---------- datas (tudo em "dia de Brasília", como texto AAAA-MM-DD) ----------
export function hojeBR() { return new Date(Date.now() - OFFSET).toISOString().slice(0, 10); }
const d2 = (s) => new Date(`${s}T12:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const somaDias = (s, n) => iso(new Date(d2(s).getTime() + n * 86400000));
const ddmm = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
const diaSem = (s) => DIAS[d2(s).getUTCDay()];
export function semanaDe(s) {
  const dow = (d2(s).getUTCDay() + 6) % 7; // 0 = segunda
  const ini = somaDias(s, -dow);
  return { ini, fim: somaDias(ini, 6) };
}
// mesmo dia no mês seguinte (31/10 → 30/11)
function proximoMes(s) {
  const [a, m, d] = s.split('-').map(Number);
  const na = m === 12 ? a + 1 : a, nm = m === 12 ? 1 : m + 1;
  const ult = new Date(Date.UTC(na, nm, 0)).getUTCDate();
  return `${na}-${String(nm).padStart(2, '0')}-${String(Math.min(d, ult)).padStart(2, '0')}`;
}

// ---------- tabelas ----------
export async function initLeituras() {
  await q(`CREATE TABLE IF NOT EXISTS leituras_cad (
    chave TEXT PRIMARY KEY, nome TEXT NOT NULL, lider TEXT, ativo BOOLEAN DEFAULT TRUE)`);
  await q(`CREATE TABLE IF NOT EXISTS leituras (
    id SERIAL PRIMARY KEY, chave TEXT NOT NULL, data DATE NOT NULL, quem TEXT, origem TEXT,
    criado_em TIMESTAMPTZ DEFAULT now(), UNIQUE (chave, data))`);
  const n = (await q('SELECT COUNT(*)::int AS n FROM leituras_cad')).rows[0].n;
  if (!n) {
    for (const [nome, lider] of LEITURAS_CADASTRO) {
      await q('INSERT INTO leituras_cad (chave, nome, lider) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [normalize(nome), nome, lider]);
    }
    for (const [nome, data] of LEITURAS_HISTORICO) {
      await q(`INSERT INTO leituras (chave, data, origem) VALUES ($1,$2,'planilha') ON CONFLICT DO NOTHING`, [normalize(nome), data]);
    }
    console.log(`[leituras] cadastro carregado: ${LEITURAS_CADASTRO.length} condomínios, ${LEITURAS_HISTORICO.length} leituras`);
  }
}

// ---------- casar nome digitado com o cadastro ----------
async function apelidos() { try { return JSON.parse(await getSetting('leituras_apelidos', '{}')); } catch { return {}; } }
const compacto = (s) => normalize(s).replace(/ /g, '');
function lev(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
export async function acharCondominio(nome, cad = null) {
  cad = cad || (await q('SELECT * FROM leituras_cad WHERE ativo')).rows;
  const ap = await apelidos();
  const n = normalize(nome);
  if (!n) return null;
  if (ap[n]) return cad.find((c) => c.chave === ap[n]) || null;
  const exato = cad.find((c) => c.chave === n || compacto(c.nome) === compacto(nome));
  if (exato) return exato;
  // pela pontuação de palavras (abreviações, nome cortado)
  const notas = cad.map((c) => ({ c, s: pontuar(nome, c.nome) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (notas.length && (notas.length === 1 || notas[0].s > notas[1].s)) return notas[0].c;
  // nome colado ou com erro de digitação ("Montalto", "Jefersom Maria", "San Luzia")
  const cn = compacto(nome);
  const perto = cad.map((c) => {
    const cc = compacto(c.nome);
    const base = cc.startsWith(cn) && cn.length >= 5 ? 0 : lev(cn, cc.slice(0, Math.max(cn.length, Math.min(cc.length, cn.length + 2))));
    return { c, d: base };
  }).sort((a, b) => a.d - b.d);
  const tol = cn.length >= 10 ? 3 : cn.length >= 6 ? 2 : 1;
  if (perto[0] && perto[0].d <= tol && (!perto[1] || perto[1].d > perto[0].d)) return perto[0].c;
  return null;
}

// ---------- ler a lista do grupo de controle ----------
// "* *Villa trocoli* (Ygor) 03/11"  ·  "* *Giovanna* 13/11(Leandro)"  ·  "Serra dourada (Leandro) 17/11"
export function lerLinhas(texto) {
  const hoje = hojeBR();
  const anoAtual = Number(hoje.slice(0, 4)), mesAtual = Number(hoje.slice(5, 7));
  const out = [];
  for (const bruta of String(texto || '').split('\n')) {
    const l = bruta.replace(/[*_~]/g, ' ').replace(/^\s*[-•·]+\s*/, '').trim();
    if (!l || /^leituras?\s+m[eê]s/i.test(l)) continue;
    const md = l.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    const mq = l.match(/\(([^)]+)\)/);
    const nome = l.replace(/\([^)]*\)/g, ' ').replace(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/g, ' ').replace(/\s+/g, ' ').trim();
    if (!nome || nome.length < 2) continue;
    let data = null;
    if (md) {
      const dia = Number(md[1]), mes = Number(md[2]);
      let ano = md[3] ? Number(md[3].length === 2 ? `20${md[3]}` : md[3]) : anoAtual;
      if (!md[3] && mes > mesAtual + 1) ano--; // dezembro lido em janeiro
      if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) data = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    }
    out.push({ nome, quem: mq ? mq[1].trim() : '', data, linha: bruta.trim() });
  }
  return out;
}

export async function registrarLista(texto, { origem = 'grupo', avisarFalhas = true } = {}) {
  const cad = (await q('SELECT * FROM leituras_cad WHERE ativo')).rows;
  const linhas = lerLinhas(texto);
  let novas = 0;
  const naoAchei = [];
  for (const l of linhas) {
    if (!l.data) continue; // sem data: ainda não feita
    if (l.data > hojeBR()) continue; // data futura: digitação errada
    const c = await acharCondominio(l.nome, cad);
    if (!c) { naoAchei.push(l.linha); continue; }
    // uma leitura por condomínio por mês: se a data foi corrigida na lista, troca
    const mes = l.data.slice(0, 7);
    const ja = (await q(`SELECT id, data::text AS data FROM leituras WHERE chave = $1 AND to_char(data, 'YYYY-MM') = $2`, [c.chave, mes])).rows;
    if (ja.some((x) => x.data === l.data)) {
      // já estava (veio da planilha): só completa quem fez
      if (l.quem) await q(`UPDATE leituras SET quem = $3 WHERE chave = $1 AND data = $2 AND (quem IS NULL OR quem = '')`, [c.chave, l.data, l.quem]);
      continue;
    }
    if (ja.length) await q('DELETE FROM leituras WHERE id = ANY($1)', [ja.map((x) => x.id)]);
    await q(`INSERT INTO leituras (chave, data, quem, origem) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [c.chave, l.data, l.quem || null, origem]);
    novas++;
  }
  if (avisarFalhas && naoAchei.length) {
    const ja = JSON.parse(await getSetting('leituras_ja_avisados', '[]'));
    const avisar = naoAchei.filter((x) => !ja.includes(normalize(x)));
    if (avisar.length) {
      await setSetting('leituras_ja_avisados', JSON.stringify([...ja, ...avisar.map(normalize)].slice(-300)));
      await sendToSuggestionGroup(`📏 *Leituras:* não reconheci ${avisar.length === 1 ? 'esta linha' : 'estas linhas'} da lista:\n` +
        avisar.map((x) => `• ${x}`).join('\n') +
        `\n\nSe for um condomínio do controle: *!leituras apelido nome da lista = nome do controle*\nSe for novo: *!leituras incluir Nome = Líder*`);
    }
  }
  return { linhas: linhas.length, novas, naoAchei };
}

// ---------- situação: o que vence na semana, o que está atrasado, o que foi feito ----------
export async function situacao(ref = hojeBR()) {
  const { ini, fim } = semanaDe(ref);
  const cad = (await q('SELECT * FROM leituras_cad WHERE ativo ORDER BY nome')).rows;
  const leit = (await q(`SELECT chave, data::text AS data, quem FROM leituras ORDER BY data`)).rows;
  const porCondo = new Map();
  for (const l of leit) porCondo.set(l.chave, [...(porCondo.get(l.chave) || []), l]);
  const itens = [];
  for (const c of cad) {
    const hist = porCondo.get(c.chave) || [];
    const feitaSemana = hist.filter((l) => l.data >= ini && l.data <= fim && l.data <= ref).pop();
    const antes = hist.filter((l) => l.data < (feitaSemana ? feitaSemana.data : '9999'));
    const base = feitaSemana ? antes[antes.length - 1] : hist[hist.length - 1];
    const alvo = base ? proximoMes(base.data) : null;
    let estado;
    if (feitaSemana) estado = 'feita';
    else if (!alvo) estado = 'sem_historico';
    else if (alvo < ini) estado = 'atrasada';
    else if (alvo <= fim) estado = alvo < ref ? 'atrasada' : 'semana';
    else estado = 'futura';
    // quem faz a leitura deste condomínio: quem fez a desta semana, senão quem fez a última (lista do grupo de controle)
    const executor = (feitaSemana?.quem) || [...hist].reverse().find((l) => l.quem)?.quem || null;
    itens.push({ ...c, ultima: base?.data || null, alvo, estado, feita: feitaSemana || null, executor });
  }
  return { ini, fim, ref, itens };
}

// ---------- mensagens ----------
function blocoLider(lider, itens, { ref, ini, fim }, tipo) {
  // vale o líder da planilha (Janaina, Kesse, Ederson) OU quem faz a leitura (Carlos, Samuel, Ygor…)
  const meus = itens.filter((i) => normalize(i.lider || '') === normalize(lider) || normalize(i.executor || '') === normalize(lider));
  const feitas = meus.filter((i) => i.estado === 'feita').sort((a, b) => a.feita.data.localeCompare(b.feita.data));
  const atras = meus.filter((i) => i.estado === 'atrasada').sort((a, b) => a.alvo.localeCompare(b.alvo));
  const semana = meus.filter((i) => i.estado === 'semana').sort((a, b) => a.alvo.localeCompare(b.alvo));
  const total = feitas.length + atras.length + semana.length;
  const lin = (i) => `• *${titulo(i.nome)}* — ${diaSem(i.alvo)} ${ddmm(i.alvo)} _(mês passado: ${ddmm(i.ultima)})_`;
  const partes = [];
  if (tipo === 'semana') {
    partes.push(`📏 *Leituras da semana — ${lider}*\n${ddmm(ini)} a ${ddmm(fim)} · ${atras.length + semana.length} a fazer${feitas.length ? ` · ✅ ${feitas.length} já feita(s)` : ''}`);
    if (atras.length) partes.push(`⚠️ *Atrasadas (${atras.length})*\n${atras.map(lin).join('\n')}`);
    if (semana.length) partes.push(`📅 *Nesta semana (${semana.length})*\n${semana.map(lin).join('\n')}`);
    if (!atras.length && !semana.length) partes.push('🎉 Nenhuma leitura prevista para esta semana.');
    partes.push('_A data é o mesmo dia da leitura do mês passado. Ao fazer, mande no grupo de controle de leituras como de costume._');
  } else {
    partes.push(`📏 *Leituras — ${lider}* · ${diaSem(ref)} ${ddmm(ref)}\n✅ ${feitas.length} de ${total} da semana`);
    if (feitas.length) partes.push(`✅ *Feitas (${feitas.length})*\n${feitas.map((i) => `• *${titulo(i.nome)}* ${diaSem(i.feita.data)} ${ddmm(i.feita.data)}${i.feita.quem ? ` · ${i.feita.quem}` : ''}`).join('\n')}`);
    const hoje = semana.filter((i) => i.alvo === ref);
    const depois = semana.filter((i) => i.alvo > ref);
    if (atras.length) partes.push(`⚠️ *Atrasadas (${atras.length})*\n${atras.map(lin).join('\n')}`);
    if (hoje.length) partes.push(`📌 *Hoje (${hoje.length})*\n${hoje.map(lin).join('\n')}`);
    if (depois.length) partes.push(`📅 *Ainda nesta semana (${depois.length})*\n${depois.map(lin).join('\n')}`);
    if (!atras.length && !semana.length) partes.push('🎉 Todas as leituras da semana foram feitas.');
  }
  return partes.join('\n\n');
}
const titulo = (s) => String(s).trim().toLowerCase().replace(/(^|\s)\S/g, (x) => x.toUpperCase()).replace(/ (Da|Das|De|Do|Dos|E) /g, (x) => x.toLowerCase());

export async function lideres() {
  const l = (await q(`SELECT DISTINCT lider FROM leituras_cad WHERE ativo AND lider IS NOT NULL AND lider <> '' ORDER BY lider`)).rows.map((r) => r.lider);
  return [...l, ...(await executores()).filter((e) => !l.some((x) => normalize(x) === normalize(e)))];
}
// quem fez leituras nos últimos 90 dias (pela lista do grupo de controle)
export async function executores() {
  const rows = (await q(`SELECT quem, COUNT(*) AS n FROM leituras WHERE quem IS NOT NULL AND quem <> '' AND data > now() - interval '90 days'
                          GROUP BY quem ORDER BY n DESC`)).rows;
  const vistos = new Map();
  for (const r of rows) { const k = normalize(r.quem); if (k && !vistos.has(k) && !/manual/.test(k)) vistos.set(k, r.quem.trim().replace(/^\w/, (x) => x.toUpperCase())); }
  return [...vistos.values()];
}

// Visão geral (para o grupo de sugestões)
export async function relatorioLeituras(filtro = '') {
  const s = await situacao();
  const ls = (await lideres()).filter((l) => !filtro || normalize(l).includes(normalize(filtro)));
  if (!ls.length) return [`Não achei o líder "${filtro}". Líderes: ${(await lideres()).join(', ')}`];
  const msgs = ls.map((l) => blocoLider(l, s.itens, s, 'dia'));
  const sem = s.itens.filter((i) => i.estado === 'sem_historico');
  if (!filtro && sem.length) msgs.push(`❔ *Sem leitura registrada* (não dá para calcular a data): ${sem.map((i) => titulo(i.nome)).join(' · ')}`);
  return msgs;
}

// ---------- grupos e envios ----------
// { "<líder normalizado>": { jid, nome } }  ·  grupo de controle em leituras_grupo
async function gruposLider() { try { return JSON.parse(await getSetting('leituras_grupos', '{}')); } catch { return {}; } }
export async function definirGrupoLider(lider, g) {
  const m = await gruposLider();
  m[normalize(lider)] = { jid: g.jid, nome: g.name, lider };
  await setSetting('leituras_grupos', JSON.stringify(m));
}
export async function removerGrupoLider(lider) {
  const m = await gruposLider();
  delete m[normalize(lider)];
  await setSetting('leituras_grupos', JSON.stringify(m));
}
export async function listarGrupos() {
  const m = await gruposLider();
  const ctrl = await getSetting('leituras_grupo_controle_nome');
  return { lideres: Object.values(m), controle: ctrl };
}
export async function enviarAvisos(tipo, { so = null } = {}) {
  const s = await situacao();
  const m = await gruposLider();
  let n = 0;
  for (const g of Object.values(m)) {
    if (so && normalize(g.lider) !== normalize(so)) continue;
    await sendText(g.jid, blocoLider(g.lider, s.itens, s, tipo));
    n++;
  }
  return n;
}

// segunda 07:30: semana · todo dia (seg–sáb) 17:30: feitas e a fazer
export async function rodarAvisosLeituras() {
  const br = new Date(Date.now() - OFFSET);
  const min = br.getUTCHours() * 60 + br.getUTCMinutes();
  const hoje = hojeBR();
  const dow = br.getUTCDay();
  const [hs, ms] = (await getSetting('leituras_hora_semana', '07:30')).split(':').map(Number);
  const [hd, md] = (await getSetting('leituras_hora_dia', '17:30')).split(':').map(Number);
  if (dow === 1 && min >= hs * 60 + ms && !(await getSetting(`leit_sem_${hoje}`))) {
    await setSetting(`leit_sem_${hoje}`, '1');
    const n = await enviarAvisos('semana');
    if (n) console.log(`[leituras] aviso da semana enviado para ${n} grupo(s)`);
  }
  if (dow >= 1 && dow <= 6 && min >= hd * 60 + md && !(await getSetting(`leit_dia_${hoje}`))) {
    await setSetting(`leit_dia_${hoje}`, '1');
    const n = await enviarAvisos('dia');
    if (n) console.log(`[leituras] resumo do dia enviado para ${n} grupo(s)`);
  }
}

// ---------- cadastro ----------
export async function incluirCondominio(nome, lider) {
  await q(`INSERT INTO leituras_cad (chave, nome, lider, ativo) VALUES ($1,$2,$3,TRUE)
           ON CONFLICT (chave) DO UPDATE SET nome = $2, lider = $3, ativo = TRUE`, [normalize(nome), nome.toUpperCase(), lider]);
}
export async function removerCondominio(nome) {
  const c = await acharCondominio(nome);
  if (!c) return null;
  await q('UPDATE leituras_cad SET ativo = FALSE WHERE chave = $1', [c.chave]);
  return c;
}
export async function salvarApelido(de, para) {
  const c = await acharCondominio(para);
  if (!c) return null;
  const ap = await apelidos();
  ap[normalize(de)] = c.chave;
  await setSetting('leituras_apelidos', JSON.stringify(ap));
  return c;
}
export async function leituraManual(nome, data, quem) {
  const c = await acharCondominio(nome);
  if (!c) return null;
  await registrarLista(`${c.nome} (${quem || 'manual'}) ${data}`, { origem: 'manual', avisarFalhas: false });
  return c;
}
