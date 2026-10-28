// Controle de visitas e vistorias: detecta nos grupos dos condomínios os avisos de chegada e saída da equipe.
import XLSX from 'xlsx';
import { pool, getSetting, setSetting, listCondos } from './db.js';
import { gerarJSON } from './gemini.js';
import { sendToSuggestionGroup, digitos, getVistoriadores } from './util.js';
import { classifyGroup, unificar, normalize } from './groups.js';
import { sendDocument } from './evolution.js';

const q = (sql, params) => pool.query(sql, params);
const TZ = 'America/Sao_Paulo';
const OFFSET = 3 * 3600 * 1000; // Brasília, UTC-3 (sem horário de verão)

export async function initVisitas() {
  await q(`
    CREATE TABLE IF NOT EXISTS visitas (
      id               SERIAL PRIMARY KEY,
      condo_key        TEXT NOT NULL,
      condo_nome       TEXT,
      vistoriador      TEXT,
      tipo             TEXT DEFAULT 'ordinaria',   -- ordinaria | extraordinaria
      motivo           TEXT,
      entrada          TIMESTAMPTZ,
      saida            TIMESTAMPTZ,
      ultima_atividade TIMESTAMPTZ,
      entrada_txt      TEXT,
      saida_txt        TEXT,
      origem           TEXT DEFAULT 'grupo',      -- grupo | manual
      criado_em        TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_visitas_condo ON visitas (condo_key, entrada);
    CREATE TABLE IF NOT EXISTS carteira (
      id          SERIAL PRIMARY KEY,
      condo_nome  TEXT NOT NULL,
      condo_key   TEXT,
      vistoriador TEXT,
      telefone    TEXT,
      ativo       BOOLEAN DEFAULT TRUE
    );
  `);
}

// ---------- datas ----------
const fmt = (d, o) => new Date(d).toLocaleString('pt-BR', { timeZone: TZ, ...o });
export const hora = (d) => fmt(d, { hour: '2-digit', minute: '2-digit' });
export const dataCurta = (d) => fmt(d, { day: '2-digit', month: '2-digit' });
const dataLonga = (d) => fmt(d, { day: '2-digit', month: '2-digit', year: 'numeric' });
const diaBR = (d) => dataLonga(d);

// Semana de segunda 00:00 a domingo 23:59 (horário de Brasília). offset -1 = semana passada
export function semana(offset = 0, ref = new Date()) {
  const br = new Date(ref.getTime() - OFFSET);
  const dow = (br.getUTCDay() + 6) % 7; // 0 = segunda
  const inicio = new Date(Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate() - dow + offset * 7) + OFFSET);
  return { inicio, fim: new Date(inicio.getTime() + 7 * 86400000) };
}
function agoraBR() {
  const br = new Date(Date.now() - OFFSET);
  return { dow: br.getUTCDay(), hora: br.getUTCHours() };
}

// ---------- telefones (com e sem 55, com e sem o 9º dígito) ----------
export function variantesTelefone(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (!d) return [];
  if (d.length === 10 || d.length === 11) d = '55' + d;
  const v = new Set([d]);
  if (d.length === 13 && d[4] === '9') v.add(d.slice(0, 4) + d.slice(5));
  if (d.length === 12 && d.startsWith('55')) v.add(d.slice(0, 4) + '9' + d.slice(4));
  return [...v];
}

export async function nomeVistoriador(msg) {
  const vist = await getVistoriadores();
  for (const id of [digitos(msg.authorAlt), digitos(msg.authorJid)].filter(Boolean)) if (vist[id]) return vist[id];
  return (msg.authorName || 'Equipe').split(' ')[0];
}

// ---------- detecção nas mensagens ----------
const PREFILTRO = /(cheg|estou n|estamos n|t[oô] n[oa]|presente|no local|aqui n[oa]|in[ií]ci|vistori|visita|ronda|inspe[cç]|sa[ií]ndo|saida|sa[ií]da|finaliz|encerr|conclu|termin|deixando|j[aá] sa[ií]|at[eé] a pr[oó]xima|retornando|indo embora)/i;

const INSTR_VISITA = `Você analisa mensagens de funcionários da Alpha Condomínios em grupos de WhatsApp dos condomínios, para o CONTROLE DE VISITAS.
Classifique a mensagem do funcionário:
- "entrada": avisa que chegou, está no condomínio ou está iniciando a visita/vistoria AGORA ("Bom dia, estou no condomínio para a vistoria", "Cheguei", "Presente no local").
- "saida": avisa que terminou ou está saindo ("Vistoria finalizada", "Saindo do condomínio", "Encerrando a visita").
- "durante": relato feito no local durante a visita ("verifiquei a bomba", "segue foto do hall"), sem aviso de chegada ou saída.
- "nenhum": qualquer outra coisa: visita FUTURA ("passo aí amanhã às 10h"), resposta a morador, cobrança, comunicado, ou quem claramente não está no local.
tipo: "extraordinaria" se indicar visita fora da rotina (emergência, vazamento, acompanhar obra ou serviço, assembleia, reunião, atender chamado); "ordinaria" se for vistoria de rotina; "indefinido" se não der para saber.
Responda SOMENTE JSON: {"evento":"entrada|saida|durante|nenhum","tipo":"ordinaria|extraordinaria|indefinido","motivo":"poucas palavras ou vazio"}`;

async function visitaAberta(condoKey, vistoriador, ts) {
  const r = await q(
    `SELECT * FROM visitas WHERE condo_key = $1 AND vistoriador = $2 AND saida IS NULL
     ORDER BY COALESCE(entrada, ultima_atividade) DESC LIMIT 1`,
    [condoKey, vistoriador]
  );
  const v = r.rows[0];
  return v && diaBR(v.entrada || v.ultima_atividade) === diaBR(ts) ? v : null;
}

async function definirTipo(condoKey, tipoIA, ts) {
  if (tipoIA === 'extraordinaria') return 'extraordinaria';
  const { inicio, fim } = semana(0, new Date(ts));
  const r = await q(
    `SELECT 1 FROM visitas WHERE condo_key = $1 AND tipo = 'ordinaria'
       AND COALESCE(entrada, saida, ultima_atividade) >= $2 AND COALESCE(entrada, saida, ultima_atividade) < $3 LIMIT 1`,
    [condoKey, inicio, fim]
  );
  return r.rows.length ? 'extraordinaria' : 'ordinaria';
}

// Chamado para toda mensagem da equipe num grupo de condomínio (independe do modo teste)
export async function processarVisita(chat, condoKey, msg) {
  const vistoriador = await nomeVistoriador(msg);
  const ts = msg.ts;
  const aberta = await visitaAberta(condoKey, vistoriador, ts);
  if (aberta) await q(`UPDATE visitas SET ultima_atividade = $2 WHERE id = $1`, [aberta.id, ts]);
  if (!PREFILTRO.test(msg.text)) return;

  const r = await gerarJSON(INSTR_VISITA,
    `Funcionário: ${vistoriador}\nCondomínio: ${chat.condo_name || condoKey}\nGrupo: ${chat.name || ''}\n` +
    `Horário: ${fmt(ts, { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}\n` +
    `Visita aberta hoje: ${aberta ? `sim, entrada às ${aberta.entrada ? hora(aberta.entrada) : '?'}` : 'não'}\n` +
    `Mensagem: ${msg.text.slice(0, 1500)}`);
  const evento = r?.evento || 'nenhum';
  const nome = chat.condo_name || condoKey;
  const txt = msg.text.slice(0, 500);

  if (evento === 'entrada' || (evento === 'durante' && !aberta)) {
    if (aberta) return;
    const tipo = await definirTipo(condoKey, r.tipo, ts);
    await q(
      `INSERT INTO visitas (condo_key, condo_nome, vistoriador, tipo, motivo, entrada, ultima_atividade, entrada_txt)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7)`,
      [condoKey, nome, vistoriador, tipo, r.motivo || null, ts, txt]
    );
    console.log(`[visita] ENTRADA ${vistoriador} em ${nome} ${hora(ts)} (${tipo})`);
  } else if (evento === 'saida') {
    if (aberta) {
      await q(`UPDATE visitas SET saida = $2, saida_txt = $3, ultima_atividade = $2,
               motivo = COALESCE(motivo, $4) WHERE id = $1`, [aberta.id, ts, txt, r.motivo || null]);
      console.log(`[visita] SAÍDA ${vistoriador} de ${nome} ${hora(ts)}`);
    } else {
      // "saindo" repetido logo depois de uma saída: ignora
      const rec = await q(`SELECT 1 FROM visitas WHERE condo_key = $1 AND vistoriador = $2 AND saida > $3::timestamptz - interval '60 minutes'`,
        [condoKey, vistoriador, ts]);
      if (rec.rows.length) return;
      const tipo = await definirTipo(condoKey, r.tipo, ts);
      await q(
        `INSERT INTO visitas (condo_key, condo_nome, vistoriador, tipo, motivo, saida, ultima_atividade, saida_txt)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7)`,
        [condoKey, nome, vistoriador, tipo, r.motivo || null, ts, txt]
      );
      console.log(`[visita] SAÍDA sem entrada ${vistoriador} de ${nome} ${hora(ts)}`);
    }
  }
}

// ---------- carteira (planilha de condomínios e vistoriadores) ----------
function casarCondo(nome, condos) {
  const cls = classifyGroup(`Condominio ${nome}`);
  if (!cls.condo_key) return null;
  if (condos.some((c) => c.condo_key === cls.condo_key)) return cls.condo_key;
  const u = unificar(cls, condos);
  return condos.some((c) => c.condo_key === u.condo_key) ? u.condo_key : cls.condo_key;
}

export async function importarCarteira(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const linhas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  const iCab = linhas.findIndex((l) => l.some((c) => normalize(String(c)).includes('condominio')));
  if (iCab < 0) throw new Error('não achei a coluna "Condomínio" na primeira aba');
  const cab = linhas[iCab].map((c) => normalize(String(c)));
  const col = (...nomes) => cab.findIndex((c) => nomes.some((n) => c.includes(n)));
  const cC = col('condominio'), cV = col('vistoriador', 'responsavel', 'gestor'), cT = col('telefone', 'celular', 'whatsapp', 'numero');

  const condos = (await listCondos()).map((c) => ({ condo_key: c.condo_key, condo_name: c.condo_name }));
  const rows = [];
  for (const l of linhas.slice(iCab + 1)) {
    const nome = String(l[cC] || '').trim();
    if (!nome) continue;
    rows.push({
      nome,
      key: casarCondo(nome, condos),
      vistoriador: cV >= 0 ? String(l[cV] || '').trim() : '',
      telefone: cT >= 0 ? String(l[cT] || '').trim() : '',
    });
  }
  if (!rows.length) throw new Error('a planilha não tem condomínios abaixo do cabeçalho');

  await q('DELETE FROM carteira');
  const vist = {};
  for (const r of rows) {
    await q(`INSERT INTO carteira (condo_nome, condo_key, vistoriador, telefone) VALUES ($1,$2,$3,$4)`,
      [r.nome, r.key, r.vistoriador || null, r.telefone || null]);
    if (r.vistoriador && r.telefone) for (const v of variantesTelefone(r.telefone)) vist[v] = r.vistoriador;
  }
  // mantém LIDs já aprendidos dos vistoriadores que continuam na planilha
  const antigos = await getVistoriadores();
  const nomes = new Set(Object.values(vist));
  for (const [id, nome] of Object.entries(antigos)) if (!vist[id] && nomes.has(nome)) vist[id] = nome;
  await setSetting('vistoriadores', JSON.stringify(vist));

  const keysGrupo = new Set(condos.map((c) => c.condo_key));
  const semGrupo = rows.filter((r) => !r.key || !keysGrupo.has(r.key)).map((r) => r.nome);
  const vistoriadores = [...new Set(rows.map((r) => r.vistoriador).filter(Boolean))];
  const semTelefone = [...new Set(rows.filter((r) => r.vistoriador && !r.telefone).map((r) => r.vistoriador))];
  return { total: rows.length, vistoriadores, semGrupo, semTelefone };
}

async function universo() {
  const condos = await listCondos();
  const cart = (await q('SELECT * FROM carteira WHERE ativo ORDER BY vistoriador NULLS LAST, condo_nome')).rows;
  if (!cart.length) {
    return {
      temCarteira: false, fora: [],
      itens: condos.map((c) => ({ condo_key: c.condo_key, nome: c.condo_name, vistoriador: 'Sem planilha', temGrupo: true })),
    };
  }
  const keysGrupo = new Set(condos.map((c) => c.condo_key));
  const naCarteira = new Set(cart.map((r) => r.condo_key).filter(Boolean));
  return {
    temCarteira: true,
    itens: cart.map((r) => ({ condo_key: r.condo_key, nome: r.condo_nome, vistoriador: r.vistoriador || 'Sem vistoriador', temGrupo: !!r.condo_key && keysGrupo.has(r.condo_key) })),
    fora: condos.filter((c) => !naCarteira.has(c.condo_key)),
  };
}

async function visitasNoPeriodo(inicio, fim) {
  return (await q(
    `SELECT * FROM visitas WHERE COALESCE(entrada, saida, ultima_atividade) >= $1 AND COALESCE(entrada, saida, ultima_atividade) < $2
     ORDER BY COALESCE(entrada, saida, ultima_atividade)`,
    [inicio, fim]
  )).rows;
}

function faixa(v) {
  const ref = v.entrada || v.saida || v.ultima_atividade;
  const e = v.entrada ? hora(v.entrada) : '?';
  let s = '…';
  if (v.saida) s = hora(v.saida);
  else if (v.ultima_atividade && v.entrada && new Date(v.ultima_atividade) > new Date(v.entrada)) s = `${hora(v.ultima_atividade)}*`;
  return `${dataCurta(ref)} ${e}–${s}`;
}

function emMensagens(blocos, limite = 3500) {
  const out = [];
  let atual = '';
  for (const b of blocos) {
    if (atual && (atual + '\n\n' + b).length > limite) { out.push(atual); atual = ''; }
    atual = atual ? `${atual}\n\n${b}` : b;
  }
  if (atual) out.push(atual);
  return out;
}

// Relatório da semana: lista de mensagens prontas para enviar
export async function relatorio(offset = 0, { apenasPendentes = false } = {}) {
  const { inicio, fim } = semana(offset);
  const { itens, fora, temCarteira } = await universo();
  const vis = await visitasNoPeriodo(inicio, fim);
  const porCondo = new Map();
  for (const v of vis) porCondo.set(v.condo_key, [...(porCondo.get(v.condo_key) || []), v]);

  let ok = 0, pend = 0, semGrupo = 0;
  const porVist = new Map();
  for (const it of itens) {
    const vs = it.condo_key ? porCondo.get(it.condo_key) || [] : [];
    const ords = vs.filter((v) => v.tipo === 'ordinaria');
    const extras = vs.filter((v) => v.tipo !== 'ordinaria');
    let linha;
    if (ords.length) {
      ok++;
      linha = `✅ ${it.nome}: ${ords.map((v) => `${faixa(v)}${v.vistoriador && v.vistoriador !== it.vistoriador ? ` (${v.vistoriador})` : ''}`).join(' · ')}`;
    } else if (!it.temGrupo) {
      semGrupo++;
      linha = `⚠️ ${it.nome} (IA não está no grupo)`;
    } else {
      pend++;
      linha = `❌ ${it.nome}`;
    }
    if (extras.length) linha += `\n   ➕ extra: ${extras.map((v) => `${faixa(v)}${v.motivo ? ` (${v.motivo})` : ''}`).join(' · ')}`;
    if (apenasPendentes && ords.length) continue;
    const g = porVist.get(it.vistoriador) || { linhas: [], total: 0, ok: 0 };
    g.linhas.push(linha);
    porVist.set(it.vistoriador, g);
  }
  // total e visitados por vistoriador (conta mesmo os que não aparecem em "só pendentes")
  for (const it of itens) {
    const g = porVist.get(it.vistoriador);
    if (!g) continue;
    g.total++;
    if ((porCondo.get(it.condo_key) || []).some((v) => v.tipo === 'ordinaria')) g.ok++;
  }

  const ultimoDia = new Date(fim.getTime() - 86400000);
  const cab =
    `📋 *${apenasPendentes ? 'Vistorias pendentes' : 'Vistorias da semana'}* (${dataCurta(inicio)} a ${dataCurta(ultimoDia)})\n` +
    `✅ Visitados: ${ok} de ${itens.length}\n❌ Pendentes: ${pend}\n⚠️ Sem grupo da IA: ${semGrupo}` +
    (fora.length ? `\n❔ Grupos fora da planilha: ${fora.length}` : '') +
    (!temCarteira ? `\n\n_Planilha de vistoriadores ainda não enviada: usando os condomínios dos grupos._` : '') +
    (!apenasPendentes && vis.length ? `\n\n* = saída estimada pela última mensagem` : '');

  const blocos = [cab];
  for (const [v, g] of porVist) {
    if (!g.linhas.length) continue;
    blocos.push(`👷 *${v}* (${g.ok}/${g.total})\n${g.linhas.join('\n')}`);
  }
  if (apenasPendentes && pend + semGrupo === 0) blocos.push('🎉 Nenhum condomínio pendente nesta semana!');
  if (fora.length && !apenasPendentes) blocos.push(`❔ *Grupos fora da planilha*\n${fora.map((c) => `• ${c.condo_name}`).join('\n')}`);
  return emMensagens(blocos);
}

// Histórico de um condomínio (últimas 20 visitas)
export async function historico(condoKey) {
  return (await q(
    `SELECT * FROM visitas WHERE condo_key = $1 ORDER BY COALESCE(entrada, saida, ultima_atividade) DESC LIMIT 20`, [condoKey]
  )).rows;
}
export function linhaVisita(v, i) {
  return `${i + 1}. ${faixa(v)} · ${v.vistoriador || '-'} · ${v.tipo === 'ordinaria' ? 'ordinária' : 'extraordinária'}` +
    `${v.motivo ? ` (${v.motivo})` : ''}${v.origem === 'manual' ? ' ✍️' : ''}`;
}
export async function removerVisita(id) {
  return (await q('DELETE FROM visitas WHERE id = $1', [id])).rowCount;
}
export async function lancarManual({ condo_key, condo_nome, vistoriador, tipo, motivo, entrada, saida }) {
  await q(
    `INSERT INTO visitas (condo_key, condo_nome, vistoriador, tipo, motivo, entrada, saida, ultima_atividade, origem)
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,COALESCE($7::timestamptz,$6::timestamptz),'manual')`,
    [condo_key, condo_nome, vistoriador, tipo, motivo || null, entrada, saida]
  );
}
export async function listarCarteira() {
  return (await q('SELECT * FROM carteira WHERE ativo ORDER BY vistoriador NULLS LAST, condo_nome')).rows;
}

// Converte "28/10" + "09:10" (horário de Brasília) em Date
export function dataHoraBR(data, horaTxt) {
  const [d, m, a] = data.split('/').map(Number);
  const hoje = new Date(Date.now() - OFFSET);
  const ano = a ? (a < 100 ? 2000 + a : a) : hoje.getUTCFullYear();
  const [hh, mm] = String(horaTxt).replace('h', ':').split(':').map(Number);
  return new Date(Date.UTC(ano, m - 1, d, hh, mm || 0) + OFFSET);
}

// ---------- planilha Excel ----------
export async function exportar(inicio, fim, titulo) {
  const vis = await visitasNoPeriodo(inicio, fim);
  const linhas = vis.map((v) => {
    const fimEst = v.saida || (v.entrada && v.ultima_atividade > v.entrada ? v.ultima_atividade : null);
    return {
      Data: dataLonga(v.entrada || v.saida || v.ultima_atividade),
      'Condomínio': v.condo_nome,
      Vistoriador: v.vistoriador,
      Tipo: v.tipo === 'ordinaria' ? 'Ordinária' : 'Extraordinária',
      Entrada: v.entrada ? hora(v.entrada) : 'não informada',
      'Saída': v.saida ? hora(v.saida) : fimEst ? `${hora(fimEst)} (estimada)` : 'não informada',
      'Duração (min)': v.entrada && fimEst ? Math.round((new Date(fimEst) - new Date(v.entrada)) / 60000) : '',
      Motivo: v.motivo || '',
      Origem: v.origem === 'manual' ? 'Lançada à mão' : 'Grupo do WhatsApp',
      'Mensagem de entrada': v.entrada_txt || '',
      'Mensagem de saída': v.saida_txt || '',
    };
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(linhas.length ? linhas : [{ Aviso: 'Nenhuma visita registrada no período' }]);
  ws['!cols'] = [12, 28, 16, 15, 14, 18, 14, 24, 18, 50, 50].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Visitas');

  // Situação da semana atual
  const { itens } = await universo();
  const sem = semana(0);
  const atuais = await visitasNoPeriodo(sem.inicio, sem.fim);
  const sit = itens.map((it) => {
    const vs = atuais.filter((v) => v.condo_key === it.condo_key);
    const ord = vs.find((v) => v.tipo === 'ordinaria');
    return {
      'Condomínio': it.nome,
      Vistoriador: it.vistoriador,
      'Situação': ord ? 'Visitado' : it.temGrupo ? 'Pendente' : 'IA não está no grupo',
      'Visita ordinária': ord ? faixa(ord) : '',
      'Extraordinárias': vs.filter((v) => v.tipo !== 'ordinaria').length || '',
    };
  });
  const ws2 = XLSX.utils.json_to_sheet(sit.length ? sit : [{ Aviso: 'Sem condomínios' }]);
  ws2['!cols'] = [30, 16, 20, 22, 14].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws2, 'Semana atual');

  const base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  return { base64, total: vis.length, fileName: `Vistorias ${titulo}.xlsx` };
}

export async function enviarPlanilha(jid, inicio, fim, titulo) {
  const p = await exportar(inicio, fim, titulo);
  await sendDocument(jid, p.base64, p.fileName, `📊 ${p.total} visita(s) · ${titulo}`);
  return p.total;
}

// ---------- alerta semanal ----------
export async function alertaSemanal() {
  const dia = Number(process.env.VISITAS_ALERTA_DIA || 5);   // 5 = sexta
  const h = Number(process.env.VISITAS_ALERTA_HORA || 12);
  const agora = agoraBR();
  if (agora.dow !== dia || agora.hora < h) return;
  const chave = `visitas_alerta_${semana(0).inicio.toISOString().slice(0, 10)}`;
  if (await getSetting(chave)) return;
  await setSetting(chave, new Date().toISOString());
  for (const m of await relatorio(0, { apenasPendentes: true })) await sendToSuggestionGroup(m);
  console.log('[visita] alerta semanal enviado');
}
