// Controle de visitas e vistorias: detecta nos grupos dos condomínios os avisos de chegada e saída da equipe.
import XLSX from 'xlsx';
import { pool, getSetting, setSetting, listCondos } from './db.js';
import { gerarJSON } from './gemini.js';
import { sendToSuggestionGroup, digitos, getVistoriadores } from './util.js';
import { classifyGroup, unificar, normalize, definirDistintos } from './groups.js';
import { sendDocument, sendText } from './evolution.js';
import { melhorCasamento } from './casar.js';
import { CARTEIRA_PADRAO, ORDEM_VISTORIADORES, SAIRAM } from './carteira-padrao.js';

const q = (sql, params) => pool.query(sql, params);
const TZ = 'America/Sao_Paulo';
const OFFSET = 3 * 3600 * 1000; // Brasília, UTC-3 (sem horário de verão)

export async function initVisitas() {
  await criarTabelas();
  try { definirDistintos((await q('SELECT condo_nome FROM carteira WHERE ativo')).rows.map((r) => r.condo_nome)); } catch {}
  // Carteira padrão (quadro de 12/11) se nenhuma planilha foi importada ainda
  const tem = (await q('SELECT COUNT(*)::int AS n FROM carteira')).rows[0].n;
  if (!tem) {
    for (const [v, lista] of Object.entries(CARTEIRA_PADRAO)) {
      for (const c of lista) await q('INSERT INTO carteira (condo_nome, vistoriador) VALUES ($1, $2)', [c, v]);
    }
    console.log('[visita] carteira padrão carregada');
  }
  // uma vez só: tira do quadro e para de monitorar os grupos desses condomínios
  // (dá para voltar com !carteira incluir e !ativar Nome)
  if (!(await getSetting('sairam_aplicado'))) {
    for (const nome of SAIRAM) await removerDaCarteira(nome);
    const condos = await listCondos();
    let ign = []; try { ign = JSON.parse(await getSetting('ignored_condos', '[]')); } catch {}
    for (const nome of SAIRAM) {
      const c = melhorCasamento(nome, condos);
      if (c && !ign.includes(c.condo_key)) ign.push(c.condo_key);
    }
    await setSetting('ignored_condos', JSON.stringify(ign));
    await setSetting('sairam_aplicado', new Date().toISOString());
  }
  await ajustarOrdinarias();
  await consolidarDuplicadas().catch((e) => console.error('[visita] consolidar', e.message));
}

// Semana sem ordinária mas com alguma ida → a primeira ida da semana passa a contar como a visita da semana
// (regra: qualquer ida conta). Idempotente: roda na inicialização e depois de apagar idas.
export async function ajustarOrdinarias() {
  await q(`
    WITH cand AS (
      SELECT v.id, v.condo_key, date_trunc('week', COALESCE(v.entrada, v.saida, v.ultima_atividade) AT TIME ZONE 'America/Sao_Paulo') AS sem,
             ROW_NUMBER() OVER (PARTITION BY v.condo_key, date_trunc('week', COALESCE(v.entrada, v.saida, v.ultima_atividade) AT TIME ZONE 'America/Sao_Paulo')
                                ORDER BY COALESCE(v.entrada, v.saida, v.ultima_atividade)) AS ordem
      FROM visitas v
      WHERE v.tipo <> 'ordinaria'
    )
    UPDATE visitas SET tipo = 'ordinaria'
    WHERE id IN (
      SELECT c.id FROM cand c WHERE c.ordem = 1 AND NOT EXISTS (
        SELECT 1 FROM visitas o WHERE o.condo_key = c.condo_key AND o.tipo = 'ordinaria'
          AND date_trunc('week', COALESCE(o.entrada, o.saida, o.ultima_atividade) AT TIME ZONE 'America/Sao_Paulo') = c.sem))`);
}

async function criarTabelas() {
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
    ALTER TABLE visitas ADD COLUMN IF NOT EXISTS saida_estimada BOOLEAN DEFAULT FALSE;
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
  return (await vistoriadorPeloNome(msg.authorName)) || (msg.authorName || 'Equipe').split(' ')[0];
}

// Nome do WhatsApp começa com o nome de um vistoriador do quadro? ("Ederson Silva" → Ederson)
export async function vistoriadorPeloNome(nome) {
  const primeiro = normalize(nome || '').split(' ')[0];
  if (!primeiro) return null;
  const r = await q(`SELECT DISTINCT vistoriador FROM carteira WHERE ativo AND vistoriador IS NOT NULL`);
  return r.rows.map((x) => x.vistoriador).find((v) => normalize(v).split(' ')[0] === primeiro) || null;
}

// Guarda o número/LID de quem foi reconhecido como vistoriador pelo nome
async function aprenderVistoriador(msg, nome) {
  const ids = [digitos(msg.authorJid), digitos(msg.authorAlt)].filter(Boolean);
  if (!ids.length) return;
  const vist = await getVistoriadores();
  let mudou = false;
  for (const id of ids) if (!vist[id]) { vist[id] = nome; mudou = true; }
  if (mudou) { await setSetting('vistoriadores', JSON.stringify(vist)); console.log(`[visita] ${nome} reconhecido pelo nome`); }
}

// ---------- detecção nas mensagens ----------
const PREFILTRO = /(cheg|estou n|estamos n|t[oô] n[oa]|presente|no local|aqui n[oa]|in[ií]ci|vistori|visita|ronda|inspe[cç]|sa[ií]ndo|saida|sa[ií]da|finaliz|encerr|conclu|termin|deixando|j[aá] sa[ií]|at[eé] a pr[oó]xima|retornando|indo embora)/i;

// Prova de que a pessoa ESTÁ ou ESTEVE no condomínio. Sem isso (e sem foto/vídeo), mensagem de texto não vira ida:
// avisar, responder, cobrar ou combinar pelo grupo não é ir ao condomínio.
export const PRESENCA = /(cheguei|chegamos|chegando a[ií]|estou aqui|estamos aqui|t[oô] aqui|aqui n[oa] (condom|pr[eé]dio|edif|port|garag|local)|(estou|estamos|t[oô]) n[oa] (condom|pr[eé]dio|edif|local|hall|t[eé]rreo|subsolo|telhado|sal[aã]o|playground|portaria|garagem|guarita|cobertura|piscina|casa de|[aá]rea)|presente|no local|in loco|estive|estivemos|passei (a[ií]|aqui|hoje|n[oa] |pel[oa])|fui (a[ií]|hoje|n[oa] |ao |at[eé])|fomos (a[ií]|hoje|n[oa] |ao )|vistoria (realizada|feita|conclu|finaliz|em andamento|ok)|realizei|realizamos|fiz a (vistoria|visita|leitura|entrega|ronda)|finaliz|encerr|sa[ií]ndo|deixei|entreguei|retirei|levei|acompanhei|acompanhando|verifiquei|constatei|conferi |segue[m]? (a |as |o |os )?(fotos?|imagens?|v[ií]deos?|registros?)|seguem fotos|fotos? (da|do|de) (vistoria|visita))/i;

// Aviso de visita/vistoria escrito por QUALQUER pessoa (a IA decide se é funcionário da Alpha)
export const AVISO_VISITA = /(vistori|estou no condom|estamos no condom|cheguei (no|ao) (condom|pr[eé]dio|edif)|presente no (local|condom)|no local para|visita (t[eé]cnica|de rotina|semanal))/i;

const INSTR_VISITA = `Você analisa mensagens de funcionários da Alpha Condomínios em grupos de WhatsApp dos condomínios, para o CONTROLE DE VISITAS.
Classifique a mensagem do funcionário:
- "entrada": avisa que chegou, está no condomínio ou está iniciando a visita/vistoria AGORA ("Bom dia, estou no condomínio para a vistoria", "Cheguei", "Presente no local").
- "saida": avisa que terminou ou está saindo ("Vistoria finalizada", "Saindo do condomínio", "Encerrando a visita").
- "durante": relato feito no local durante a visita ("verifiquei a bomba", "segue foto do hall", "deixei o material na portaria",
  "entreguei as lâmpadas ao zelador", "estou aqui com o técnico"), sem aviso de chegada ou saída.
TODA IDA CONTA, qualquer que seja o motivo: vistoria, entrega ou retirada de material, acompanhar técnico ou obra, atender chamado,
reunião, assembleia, leitura de gás, buscar chave/documento.
- "nenhum": visita FUTURA ou A CAMINHO ("passo aí amanhã às 10h", "vou levar o material", "estou a caminho", "indo para o condomínio", "chego em 10 minutos" — quem diz que está indo AINDA NÃO chegou e pode não ir), resposta ou comunicado feito à distância,
  cobrança, aviso geral, relato de problema ou providência SEM dizer que está no local ("a fechadura está com defeito, já acionei o chaveiro",
  "vamos verificar a porta da garagem", "o técnico vai passar") — ou seja, quando NÃO dá para concluir que a pessoa está ou esteve no condomínio naquele momento.
tipo: "ordinaria" se for vistoria de rotina ou mencionar vistoria; "extraordinaria" para qualquer outro motivo (entrega de material,
técnico, obra, chamado, assembleia, reunião…); "indefinido" se não der para saber.
motivo: poucas palavras dizendo para que foi (ex.: "entrega de material", "acompanhar técnico do portão", "vistoria").
Qualquer funcionário da Alpha conta (vistoriador, gestor, assistente, zelador volante da Alpha).
Quando o autor estiver marcado como "não identificado", decida pelo conteúdo se é funcionário da Alpha fazendo visita:
mensagens como "Bom dia, estou no condomínio para a vistoria" são da Alpha; morador, síndico morador ou prestador
terceirizado (eletricista, empresa de portão, dedetizadora) NÃO contam → "nenhum".
Responda SOMENTE JSON: {"evento":"entrada|saida|durante|nenhum","tipo":"ordinaria|extraordinaria|indefinido","motivo":"poucas palavras ou vazio"}`;

// Visita em curso neste condomínio: a aberta do dia OU uma que terminou (saída estimada) há menos de 90 min.
// Assim fotos em sequência, mensagens fora de ordem e a mesma ida contada por duas pessoas viram UMA visita.
async function visitaAberta(condoKey, vistoriador, ts) {
  const r = await q(
    `SELECT * FROM visitas WHERE condo_key = $1 AND entrada IS NOT NULL AND origem <> 'lista'
       AND entrada <= $2::timestamptz + interval '30 minutes'
       AND COALESCE(saida, ultima_atividade, entrada) >= $2::timestamptz - interval '90 minutes'
     ORDER BY (vistoriador = $3) DESC, (saida IS NULL) DESC, entrada DESC LIMIT 1`,
    [condoKey, ts, vistoriador]
  );
  const v = r.rows[0];
  if (!v || diaBR(v.entrada) !== diaBR(ts)) return null;
  // mensagem depois de uma saída só estimada: a visita continuava, reabre
  if (v.saida && v.saida_estimada && new Date(ts) > new Date(v.saida)) {
    await q(`UPDATE visitas SET saida = NULL, saida_estimada = FALSE WHERE id = $1`, [v.id]);
    v.saida = null;
  }
  // mensagem antes da entrada registrada (chegou fora de ordem): adianta a entrada
  if (new Date(ts) < new Date(v.entrada)) {
    await q(`UPDATE visitas SET entrada = $2 WHERE id = $1`, [v.id, ts]);
    v.entrada = ts;
  }
  return v;
}

// Mensagens do mesmo condomínio são processadas uma de cada vez (fotos de um álbum chegam juntas)
const filaCondo = new Map();
function emFila(chave, fn) {
  const ant = filaCondo.get(chave) || Promise.resolve();
  const prox = ant.catch(() => {}).then(fn);
  filaCondo.set(chave, prox.finally(() => { if (filaCondo.get(chave) === prox) filaCondo.delete(chave); }));
  return prox;
}

// Junta registros repetidos da MESMA ida (mesmo condomínio, mesmo dia, horários sobrepostos ou a menos de 90 min).
// A lançada pela lista (sem horário) some se houver uma ida com horário no mesmo dia.
export async function consolidarDuplicadas() {
  const rows = (await q(
    `SELECT * FROM visitas WHERE COALESCE(entrada, saida, ultima_atividade) IS NOT NULL
     ORDER BY condo_key, COALESCE(entrada, saida, ultima_atividade), id`)).rows;
  const ref = (v) => new Date(v.entrada || v.saida || v.ultima_atividade);
  const fimDe = (v) => new Date(v.saida || v.ultima_atividade || v.entrada || ref(v));
  const grupos = new Map();
  for (const v of rows) {
    const k = `${v.condo_key}|${diaBR(ref(v))}`;
    grupos.set(k, [...(grupos.get(k) || []), v]);
  }
  let removidas = 0;
  for (const lista of grupos.values()) {
    if (lista.length < 2) continue;
    const comHora = lista.filter((v) => v.origem !== 'lista');
    if (comHora.length) {
      for (const v of lista.filter((x) => x.origem === 'lista')) {
        // a lista confirmava a ida; a de horário passa a ser a vistoria se a da lista era
        if (v.tipo === 'ordinaria') await q(`UPDATE visitas SET tipo = 'ordinaria' WHERE id = $1`, [comHora[0].id]);
        await q('DELETE FROM visitas WHERE id = $1', [v.id]); removidas++;
      }
    }
    const blocos = [];
    for (const v of comHora) {
      const b = blocos[blocos.length - 1];
      if (b && ref(v) - b.fim <= 90 * 60000) { b.itens.push(v); if (fimDe(v) > b.fim) b.fim = fimDe(v); }
      else blocos.push({ itens: [v], fim: fimDe(v) });
    }
    for (const { itens } of blocos) {
      if (itens.length < 2) continue;
      const manter = itens[0];
      const entradas = itens.filter((x) => x.entrada).map((x) => new Date(x.entrada));
      const reais = itens.filter((x) => x.saida && !x.saida_estimada).map((x) => new Date(x.saida));
      const est = itens.filter((x) => x.saida).map((x) => new Date(x.saida));
      const saida = reais.length ? new Date(Math.max(...reais)) : est.length ? new Date(Math.max(...est)) : null;
      const motivos = [...new Set(itens.map((x) => (x.motivo || '').trim()).filter(Boolean))];
      const motivo = (motivos.length > 1 ? motivos.filter((m) => !/^fotos no grupo$/i.test(m)) : motivos).join('; ').slice(0, 250) || null;
      const quem = [...new Set(itens.map((x) => x.vistoriador).filter(Boolean))].join(' e ');
      const ultima = new Date(Math.max(...itens.map((x) => fimDe(x))));
      await q(
        `UPDATE visitas SET entrada = $2, saida = $3, saida_estimada = $4, motivo = $5, vistoriador = $6, ultima_atividade = $7,
           tipo = $8 WHERE id = $1`,
        [manter.id, entradas.length ? new Date(Math.min(...entradas)) : manter.entrada, saida, !!saida && !reais.length, motivo,
          quem || manter.vistoriador, ultima, itens.some((x) => x.tipo === 'ordinaria') ? 'ordinaria' : manter.tipo]);
      for (const x of itens.slice(1)) { await q('DELETE FROM visitas WHERE id = $1', [x.id]); removidas++; }
    }
  }
  if (removidas) {
    await ajustarOrdinarias();
    console.log(`[visita] ${removidas} registro(s) repetido(s) da mesma ida foram juntados`);
  }
  return removidas;
}

// A primeira visita da semana que mencione "vistoria" conta como a ordinária, mesmo junto com outra tarefa
// ("vistoria e acompanhar empresa X"). Extraordinária pura (só o chamado) não conta.
// Regra (Luiz, 17/11): a PRIMEIRA ida da semana, por qualquer motivo, conta como a visita da semana ("ordinaria").
// As seguintes são idas extras.
async function definirTipo(condoKey, tipoIA, ts, texto = '') {
  const { inicio, fim } = semana(0, new Date(ts));
  const r = await q(
    `SELECT 1 FROM visitas WHERE condo_key = $1 AND tipo = 'ordinaria'
       AND COALESCE(entrada, saida, ultima_atividade) >= $2 AND COALESCE(entrada, saida, ultima_atividade) < $3 LIMIT 1`,
    [condoKey, inicio, fim]
  );
  return r.rows.length ? 'extraordinaria' : 'ordinaria';
}

// Quando o vistoriador aparece em outro condomínio, a visita aberta no anterior é encerrada:
// saída = última mensagem dele lá (se houver depois da entrada) ou a chegada no próximo, marcada como estimada.
async function fecharAnteriores(vistoriador, condoKey, ts) {
  const abertas = (await q(
    `SELECT * FROM visitas WHERE vistoriador = $1 AND condo_key <> $2 AND saida IS NULL AND entrada IS NOT NULL
       AND entrada < $3 AND entrada > $3::timestamptz - interval '14 hours'`, [vistoriador, condoKey, ts]
  )).rows;
  for (const v of abertas) {
    const fim = v.ultima_atividade && new Date(v.ultima_atividade) > new Date(v.entrada) ? v.ultima_atividade : ts;
    await q(`UPDATE visitas SET saida = $2, saida_estimada = TRUE WHERE id = $1`, [v.id, fim]);
    console.log(`[visita] SAÍDA estimada ${vistoriador} de ${v.condo_nome} ${hora(fim)} (chegou em outro condomínio)`);
  }
}

// Encerra no fim do dia as visitas que ficaram abertas (saída = última mensagem do vistoriador no local)
export async function fecharDia() {
  const abertas = (await q(
    `SELECT * FROM visitas WHERE saida IS NULL AND entrada IS NOT NULL AND entrada < now() - interval '3 hours'
       AND (entrada AT TIME ZONE 'America/Sao_Paulo')::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date
       OR (saida IS NULL AND entrada IS NOT NULL AND entrada < now() - interval '10 hours')`
  )).rows;
  for (const v of abertas) {
    if (v.ultima_atividade && new Date(v.ultima_atividade) > new Date(v.entrada)) {
      await q(`UPDATE visitas SET saida = ultima_atividade, saida_estimada = TRUE WHERE id = $1`, [v.id]);
    }
  }
}

// Saída informada à mão: !saida ipe 11:30
export async function registrarSaida(condoKey, quando) {
  const v = (await q(
    `SELECT * FROM visitas WHERE condo_key = $1 AND entrada IS NOT NULL AND entrada <= $2 ORDER BY entrada DESC LIMIT 1`, [condoKey, quando]
  )).rows[0];
  if (!v) return null;
  await q(`UPDATE visitas SET saida = $2, saida_estimada = FALSE, ultima_atividade = GREATEST(ultima_atividade, $2) WHERE id = $1`, [v.id, quando]);
  return v;
}

// Chamado para toda mensagem da equipe num grupo de condomínio (independe do modo teste)
export function processarVisita(chat, condoKey, msg) {
  return emFila(condoKey, () => processarVisitaAgora(chat, condoKey, msg));
}
async function processarVisitaAgora(chat, condoKey, msg) {
  const vistoriador = await nomeVistoriador(msg);
  const ts = msg.ts;
  // mesma mensagem já registrada (reprocessamento)
  const ja = await q(`SELECT 1 FROM visitas WHERE condo_key = $1 AND (entrada = $2 OR saida = $2) LIMIT 1`, [condoKey, ts]);
  if (ja.rows.length) return 'repetida';
  const aberta = await visitaAberta(condoKey, vistoriador, ts);
  if (aberta) await q(`UPDATE visitas SET ultima_atividade = $2 WHERE id = $1`, [aberta.id, ts]);
  // Foto/vídeo sem legenda mandado por funcionário: conta como presença no local
  const soMidia = /^\[(imagem|vídeo)\]$/.test(String(msg.text).trim());
  if (soMidia && (msg.equipe || (await vistoriadorPeloNome(msg.authorName)))) {
    if (aberta) return 'durante';
    await fecharAnteriores(vistoriador, condoKey, ts);
    const tipo = await definirTipo(condoKey, 'indefinido', ts, '');
    await q(
      `INSERT INTO visitas (condo_key, condo_nome, vistoriador, tipo, motivo, entrada, ultima_atividade, entrada_txt)
       VALUES ($1,$2,$3,$4,'fotos no grupo',$5,$5,$6)`,
      [condoKey, chat.condo_name || condoKey, vistoriador, tipo, ts, msg.text]
    );
    console.log(`[visita] ENTRADA (fotos) ${vistoriador} em ${chat.condo_name || condoKey} ${hora(ts)} (${tipo})`);
    return 'entrada';
  }
  const funcionario = msg.equipe || !!(await vistoriadorPeloNome(msg.authorName));
  // Mensagem de funcionário: sempre analisa (qualquer ida conta: entrega de material, técnico, chamado…).
  // Autor não identificado: só se tiver cara de aviso de visita.
  if (!funcionario && !PREFILTRO.test(msg.text)) return 'nenhum';
  if (funcionario && String(msg.text).trim().length < 4) return 'nenhum';

  const conhecido = msg.equipe || !!(await vistoriadorPeloNome(msg.authorName));
  const r = await gerarJSON(INSTR_VISITA,
    `Autor: ${msg.authorName || vistoriador}${conhecido ? ` (funcionário da Alpha: ${vistoriador})` : ' (não identificado)'}\nCondomínio: ${chat.condo_name || condoKey}\nGrupo: ${chat.name || ''}\n` +
    `Horário: ${fmt(ts, { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}\n` +
    `Visita aberta hoje: ${aberta ? `sim, entrada às ${aberta.entrada ? hora(aberta.entrada) : '?'}` : 'não'}\n` +
    `Mensagem: ${msg.text.slice(0, 1500)}`, { leve: true, tarefa: 'Vistorias (mensagens da equipe)' });
  let evento = r?.evento || 'nenhum';
  // trava: texto sem sinal de presença no local não vira ida (ex.: "Bom dia, amanhã passo aí", aviso, cobrança)
  if (evento !== 'nenhum' && !PRESENCA.test(msg.text)) {
    console.log(`[visita] ignorada (sem sinal de presença) ${vistoriador} em ${chat.condo_name || condoKey}: ${String(msg.text).slice(0, 80)}`);
    evento = 'nenhum';
  }
  if (evento !== 'nenhum' && !msg.equipe && conhecido) await aprenderVistoriador(msg, vistoriador);
  const nome = chat.condo_name || condoKey;
  const txt = msg.text.slice(0, 500);

  if (evento === 'entrada' || (evento === 'durante' && !aberta)) {
    if (aberta) return;
    await fecharAnteriores(vistoriador, condoKey, ts);
    const tipo = await definirTipo(condoKey, r.tipo, ts, `${msg.text} ${r.motivo || ''}`);
    await q(
      `INSERT INTO visitas (condo_key, condo_nome, vistoriador, tipo, motivo, entrada, ultima_atividade, entrada_txt)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7)`,
      [condoKey, nome, vistoriador, tipo, r.motivo || null, ts, txt]
    );
    console.log(`[visita] ENTRADA ${vistoriador} em ${nome} ${hora(ts)} (${tipo})`);
  } else if (evento === 'saida') {
    if (aberta) {
      await q(`UPDATE visitas SET saida = $2, saida_txt = $3, ultima_atividade = $2, saida_estimada = FALSE,
               motivo = COALESCE(motivo, $4) WHERE id = $1`, [aberta.id, ts, txt, r.motivo || null]);
      console.log(`[visita] SAÍDA ${vistoriador} de ${nome} ${hora(ts)}`);
    } else {
      // "saindo" repetido logo depois de uma saída: ignora
      const rec = await q(`SELECT 1 FROM visitas WHERE condo_key = $1 AND vistoriador = $2 AND saida > $3::timestamptz - interval '60 minutes'`,
        [condoKey, vistoriador, ts]);
      if (rec.rows.length) return;
      const tipo = await definirTipo(condoKey, r.tipo, ts, `${msg.text} ${r.motivo || ''}`);
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
// chavesProprias: chaves exatas de todos os nomes da planilha (evita casar "Minas" com "Minas das Esmeraldas")
function casarCondo(nome, condos, chavesProprias = new Set()) {
  const cls = classifyGroup(`Condominio ${nome}`);
  if (!cls.condo_key) return null;
  if (condos.some((c) => c.condo_key === cls.condo_key)) return cls.condo_key;
  const u = unificar(cls, condos);
  if (u.condo_key !== cls.condo_key && chavesProprias.has(u.condo_key)) return cls.condo_key;
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
  const nomes0 = linhas.slice(iCab + 1).map((l) => String(l[cC] || '').trim()).filter(Boolean);
  const chavesProprias = new Set(nomes0.map((n) => classifyGroup(`Condominio ${n}`).condo_key).filter(Boolean));
  const rows = [];
  for (const l of linhas.slice(iCab + 1)) {
    const nome = String(l[cC] || '').trim();
    if (!nome) continue;
    rows.push({
      nome,
      key: casarCondo(nome, condos, chavesProprias),
      vistoriador: cV >= 0 ? String(l[cV] || '').trim() : '',
      telefone: cT >= 0 ? String(l[cT] || '').trim() : '',
    });
  }
  if (!rows.length) throw new Error('a planilha não tem condomínios abaixo do cabeçalho');

  // Aba opcional "Telefones": Vistoriador | Telefone (preenche quem ficou sem telefone na aba principal)
  const abaTel = wb.SheetNames.find((n) => normalize(n).includes('telefone'));
  if (abaTel) {
    const tl = XLSX.utils.sheet_to_json(wb.Sheets[abaTel], { header: 1, defval: '' });
    const mapa = {};
    for (const l of tl.slice(1)) if (String(l[0]).trim() && String(l[1]).trim()) mapa[normalize(String(l[0]))] = String(l[1]).trim();
    for (const r of rows) if (!r.telefone && r.vistoriador) r.telefone = mapa[normalize(r.vistoriador)] || '';
  }

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

  const u = await universo();
  const semGrupo = u.itens.filter((i) => !i.temGrupo).map((i) => i.nome);
  const vistoriadores = [...new Set(rows.map((r) => r.vistoriador).filter(Boolean))];
  const semTelefone = [...new Set(rows.filter((r) => r.vistoriador && !r.telefone).map((r) => r.vistoriador))];
  return { total: rows.length, vistoriadores, semGrupo, semTelefone };
}

async function getApelidos() {
  try { return JSON.parse(await getSetting('apelidos', '{}')); } catch { return {}; }
}

// Casa cada condomínio da carteira com o grupo da IA na hora do relatório (grupos novos entram sozinhos)
async function universo() {
  const condos = await listCondos();
  const cart = (await q('SELECT * FROM carteira WHERE ativo ORDER BY id')).rows;
  definirDistintos(cart.map((r) => r.condo_nome));
  if (!cart.length) {
    return {
      temCarteira: false, fora: [], vistoriadores: ['Sem planilha'],
      itens: condos.map((c) => ({ condo_key: c.condo_key, nome: c.condo_name, vistoriador: 'Sem planilha', temGrupo: true })),
    };
  }
  const apelidos = await getApelidos();
  const nomes = cart.map((r) => r.condo_nome);
  const usados = new Set();
  const itens = cart.map((r) => {
    const ap = apelidos[normalize(r.condo_nome)];
    let c = ap ? condos.find((x) => x.condo_key === ap) : null;
    if (!c) c = melhorCasamento(r.condo_nome, condos.filter((x) => !usados.has(x.condo_key)), nomes);
    if (c) usados.add(c.condo_key);
    return { condo_key: c?.condo_key || null, nome: r.condo_nome, nomeGrupo: c?.condo_name, vistoriador: r.vistoriador || 'Sem vistoriador', temGrupo: !!c };
  });
  const ordem = [...new Set([...ORDEM_VISTORIADORES.filter((v) => itens.some((i) => i.vistoriador === v)), ...itens.map((i) => i.vistoriador)])];
  return { temCarteira: true, itens, vistoriadores: ordem, fora: condos.filter((c) => !usados.has(c.condo_key)) };
}

export async function definirApelido(nomePlanilha, condoKey) {
  const a = await getApelidos();
  a[normalize(nomePlanilha)] = condoKey;
  await setSetting('apelidos', JSON.stringify(a));
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

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const diaSemana = (d) => DIAS[new Date(new Date(d).getTime() - OFFSET).getUTCDay()];
const barra = (ok, total) => {
  const n = total ? Math.round((ok / total) * 10) : 0;
  return '▓'.repeat(n) + '░'.repeat(10 - n);
};
const pct = (ok, total) => (total ? Math.round((ok / total) * 100) : 0);

function quando(v) {
  const ref = v.entrada || v.saida || v.ultima_atividade;
  if (v.origem === 'lista') return `${diaSemana(ref)} ${dataCurta(ref)} · horário não informado 📝`;
  const e = v.entrada ? hora(v.entrada) : '?';
  const hojeBR = dataLonga(new Date());
  let s;
  if (v.saida) s = `${hora(v.saida)}${v.saida_estimada ? '*' : ''}`;
  else if (v.entrada && dataLonga(v.entrada) === hojeBR) {
    const ult = v.ultima_atividade && new Date(v.ultima_atividade) > new Date(v.entrada) ? ` (última msg ${hora(v.ultima_atividade)})` : '';
    return `${diaSemana(ref)} ${dataCurta(ref)} · ${e} · 🟢 *em andamento*${ult}`;
  } else if (v.ultima_atividade && v.entrada && new Date(v.ultima_atividade) > new Date(v.entrada)) s = `${hora(v.ultima_atividade)}*`;
  else s = 'saída não informada';
  return `${diaSemana(ref)} ${dataCurta(ref)} · ${e}–${s}`;
}

// Relatório da semana: lista de mensagens prontas para enviar (resumo + uma mensagem por vistoriador)
export async function relatorio(offset = 0, { apenasPendentes = false, so = null } = {}) {
  const { inicio, fim } = semana(offset);
  const { itens, fora, temCarteira, vistoriadores } = await universo();
  const vis = await visitasNoPeriodo(inicio, fim);
  const porCondo = new Map();
  for (const v of vis) porCondo.set(v.condo_key, [...(porCondo.get(v.condo_key) || []), v]);
  const refVis = (v) => new Date(v.entrada || v.saida || v.ultima_atividade);

  const grupos = new Map(vistoriadores.map((v) => [v, { ok: [], pend: [], sem: [], extras: [] }]));
  for (const it of itens) {
    const g = grupos.get(it.vistoriador);
    const vs = it.condo_key ? porCondo.get(it.condo_key) || [] : [];
    const ord = vs.filter((v) => v.tipo === 'ordinaria').sort((a, b) => refVis(a) - refVis(b))[0];
    for (const x of vs.filter((v) => v !== ord)) g.extras.push({ it, v: x });
    if (ord) g.ok.push({ it, v: ord });
    else if (!it.temGrupo) g.sem.push(it);
    else g.pend.push(it);
  }

  const total = itens.length;
  const ok = [...grupos.values()].reduce((s, g) => s + g.ok.length, 0);
  const pend = [...grupos.values()].reduce((s, g) => s + g.pend.length, 0);
  const sem = [...grupos.values()].reduce((s, g) => s + g.sem.length, 0);
  const ultimoDia = new Date(fim.getTime() - 86400000);
  const hoje = offset === 0 ? `\nHoje: ${diaSemana(new Date())} ${dataCurta(new Date())}` : '';

  const linhasVist = vistoriadores.map((v) => {
    const g = grupos.get(v);
    const t = g.ok.length + g.pend.length + g.sem.length;
    return `*${v}*\n${barra(g.ok.length, t)} ${g.ok.length}/${t}${g.pend.length ? ` · ❌ ${g.pend.length} pendente${g.pend.length > 1 ? 's' : ''}` : ' ✔️'}`;
  });

  const msgs = [];
  if (so) {
    // relatório de um vistoriador só (envio diário para o grupo dele)
    const v = vistoriadores.find((x) => normalize(x) === normalize(so));
    if (!v) return [`Não encontrei o vistoriador "${so}" no quadro.`];
    const g = grupos.get(v);
    const agora = new Date();
    const cab = `📋 *Vistorias da semana*\n${diaSemana(inicio)} ${dataCurta(inicio)} a ${diaSemana(ultimoDia)} ${dataCurta(ultimoDia)}\nAtualizado: ${diaSemana(agora)} ${dataCurta(agora)} às ${hora(agora)}`;
    vistoriadores.splice(0, vistoriadores.length, v);
    msgs.push(cab);
  } else
  msgs.push(
    `📋 *${apenasPendentes ? 'Vistorias pendentes' : 'Vistorias da semana'}*\n${diaSemana(inicio)} ${dataCurta(inicio)} a ${diaSemana(ultimoDia)} ${dataCurta(ultimoDia)}${hoje}\n\n` +
    `✅ *${ok}* de ${total} vistoriados (${pct(ok, total)}%)\n❌ *${pend}* pendentes\n` +
    (sem ? `⚠️ *${sem}* sem grupo da IA (não dá para conferir)\n` : '') +
    `\n👷 *Por vistoriador*\n\n${linhasVist.join('\n\n')}` +
    (!temCarteira ? `\n\n_Sem planilha de vistoriadores: usando os condomínios dos grupos._` : '')
  );

  // Formato compacto: uma linha por condomínio, pendentes corridos, sem linhas em branco entre itens
  const curtoQuando = (x) => quando(x).replace(' · ', ' ').replace('horário não informado 📝', '📝').replace('🟢 *em andamento*', '🟢 em andamento');
  for (const v of vistoriadores) {
    const g = grupos.get(v);
    const t = g.ok.length + g.pend.length + g.sem.length;
    if (apenasPendentes && !g.pend.length && !g.sem.length) continue;
    const partes = [`👷 *${v.toUpperCase()}* · ${g.ok.length}/${t} (${pct(g.ok.length, t)}%)`];

    // 1º o que foi feito, na ordem em que aconteceu
    if (!apenasPendentes && g.ok.length) {
      const feitos = g.ok.sort((a, b) => refVis(a.v) - refVis(b.v)).map(({ it, v: x }) =>
        `• *${it.nome}* ${curtoQuando(x)}` +
        (x.vistoriador && normalize(x.vistoriador) !== normalize(v) ? ` · ${x.vistoriador}` : '') +
        (x.motivo && !/vistori|lan[cç]ada pela lista/i.test(x.motivo) ? ` · _${x.motivo}_` : ''));
      partes.push(`✅ *Feitas (${g.ok.length})*\n${feitos.join('\n')}`);
    }
    if (g.pend.length) partes.push(`❌ *Pendentes (${g.pend.length})*\n${g.pend.map((it) => it.nome).join(' · ')}`);
    if (g.sem.length) partes.push(`⚠️ *Sem grupo da IA (${g.sem.length})*\n${g.sem.map((it) => it.nome).join(' · ')}`);
    if (!apenasPendentes && g.extras.length) {
      const ex = g.extras.sort((a, b) => refVis(a.v) - refVis(b.v)).map(({ it, v: x }) =>
        `• *${it.nome}* ${curtoQuando(x)}${x.motivo ? ` · _${x.motivo}_` : ''}`);
      partes.push(`➕ *Idas extras (${g.extras.length})*\n${ex.join('\n')}`);
    }
    if (!g.pend.length && !g.sem.length) partes.push('🎉 Todos vistoriados nesta semana.');
    msgs.push(partes.join('\n\n'));
  }

  if (!apenasPendentes && fora.length && !so) {
    const linhas = fora.map((c) => {
      const vs = porCondo.get(c.condo_key) || [];
      return `• ${c.condo_name}${vs.length ? ` (${vs.length} ida${vs.length > 1 ? 's' : ''})` : ''}`;
    });
    msgs.push(`❔ *Grupos fora da carteira (${fora.length})*\nTêm grupo com a IA, mas não estão no quadro de vistorias. Se for o mesmo condomínio com outro nome:\n_!apelido nome no quadro = nome do grupo_\n\n${linhas.join('\n')}`);
  }
  if (!apenasPendentes && !so && vis.some((v) => !v.saida)) msgs.push('_* saída estimada (última mensagem no local ou chegada no condomínio seguinte)_');
  // uma mensagem por bloco; quebra só se passar do limite do WhatsApp
  return msgs.flatMap((m) => {
    if (m.length <= 3800) return [m];
    const partes = [];
    let atual = '';
    for (const l of m.split('\n')) {
      if ((atual + '\n' + l).length > 3800) { partes.push(atual); atual = ''; }
      atual = atual ? `${atual}\n${l}` : l;
    }
    if (atual) partes.push(atual);
    return partes;
  });
}

// Histórico de um condomínio (últimas 20 visitas)
export async function historico(condoKey) {
  return (await q(
    `SELECT * FROM visitas WHERE condo_key = $1 ORDER BY COALESCE(entrada, saida, ultima_atividade) DESC LIMIT 20`, [condoKey]
  )).rows;
}
export function linhaVisita(v, i) {
  return `${i + 1}. ${faixa(v)} · ${v.vistoriador || '-'} · ${v.tipo === 'ordinaria' ? 'ordinária' : 'extraordinária'}` +
    `${v.motivo ? ` (${v.motivo})` : ''}${v.origem === 'manual' ? ' ✍️' : v.origem === 'verificacao' ? ' 🔎' : ''}`;
}
export async function removerVisita(id) {
  const n = (await q('DELETE FROM visitas WHERE id = $1', [id])).rowCount;
  await ajustarOrdinarias();
  return n;
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
      'Saída': v.saida ? `${hora(v.saida)}${v.saida_estimada ? ' (estimada)' : ''}` : fimEst ? `${hora(fimEst)} (estimada)` : 'não informada',
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

// Reprocessa as mensagens guardadas da semana (ex.: vistoriador que ainda não era reconhecido)
export async function reprocessarSemana(offset = 0) {
  const { inicio, fim } = semana(offset);
  const nomes = (await q(`SELECT DISTINCT vistoriador FROM carteira WHERE ativo AND vistoriador IS NOT NULL`)).rows
    .map((x) => normalize(x.vistoriador).split(' ')[0]);
  const msgs = (await q(
    `SELECT m.*, c.kind AS chat_kind, c.condo_key, c.condo_name, c.name AS chat_name FROM messages m JOIN chats c ON c.jid = m.chat_jid
     WHERE m.ts >= $1 AND m.ts < $2 AND c.condo_key IS NOT NULL AND c.kind IN ('moradores','sindico','conselho')
     ORDER BY m.ts`, [inicio, fim]
  )).rows;
  let lidas = 0;
  const antes = (await q(`SELECT COUNT(*)::int AS n FROM visitas`)).rows[0].n;
  for (const m of msgs) {
    const doVist = nomes.includes(normalize(m.author_name || '').split(' ')[0]);
    if (!m.from_me && !doVist && !AVISO_VISITA.test(m.text || '')) continue;
    lidas++;
    try {
      await processarVisita({ name: m.chat_name, condo_name: m.condo_name, kind: m.chat_kind }, m.condo_key,
        { text: m.text, ts: new Date(m.ts), authorName: m.author_name, authorJid: m.author_jid, authorAlt: '', equipe: m.from_me });
    } catch (e) { console.error('[visita] reprocessar', e.message); }
  }
  await consolidarDuplicadas().catch(() => {});
  const depois = (await q(`SELECT COUNT(*)::int AS n FROM visitas`)).rows[0].n;
  return { lidas, novas: depois - antes };
}

// Diagnóstico: por que um condomínio do quadro está (ou não) com vistoria
export async function diagnostico(nome) {
  const u = await universo();
  const alvo = normalize(nome);
  const it = u.itens.find((i) => normalize(i.nome) === alvo) || u.itens.find((i) => normalize(i.nome).includes(alvo));
  const linhas = [];
  let condoKey = it?.condo_key;
  if (it) {
    linhas.push(`📋 Quadro: *${it.nome}* · vistoriador *${it.vistoriador}*`);
    linhas.push(it.temGrupo ? `🔗 Ligado ao grupo: *${it.nomeGrupo}*` : `⚠️ Não achei grupo da IA com esse nome. Se existir com outro nome: !apelido ${it.nome.toLowerCase()} = nome do grupo`);
  } else {
    linhas.push(`📋 "${nome}" não está no quadro de vistorias.`);
    const c = (await listCondos()).find((x) => normalize(x.condo_name).includes(alvo));
    condoKey = c?.condo_key;
    if (c) linhas.push(`🔗 Mas há grupo da IA: *${c.condo_name}*`);
  }
  if (!condoKey) return linhas.join('\n');

  const grupos = (await q(`SELECT name, kind, COALESCE(ativo, TRUE) AS ativo FROM chats WHERE condo_key = $1 AND kind <> 'privado'`, [condoKey])).rows;
  linhas.push(`\n👥 Grupos: ${grupos.map((g) => `${g.name} (${g.kind}${g.ativo ? '' : ', IA saiu'})`).join(' · ') || 'nenhum'}`);
  const teste = JSON.parse((await getSetting('test_condos', '[]')) || '[]');
  linhas.push(`📥 Mensagens sendo guardadas: ${teste.includes(condoKey) ? 'sim' : '*não* (fora do teste: use !estudar ' + (it?.nome || nome).toLowerCase() + ')'}`);

  const { inicio, fim } = semana(0);
  const msgs = (await q(
    `SELECT m.ts, m.author_name, m.from_me, m.text FROM messages m JOIN chats c ON c.jid = m.chat_jid
     WHERE c.condo_key = $1 AND m.ts >= $2 AND m.ts < $3 ORDER BY m.ts DESC LIMIT 15`, [condoKey, inicio, fim]
  )).rows.reverse();
  linhas.push(`\n💬 Mensagens desta semana (${msgs.length}${msgs.length === 15 ? '+' : ''}):`);
  for (const m of msgs) {
    const vist = !m.from_me && (await vistoriadorPeloNome(m.author_name));
    const marca = m.from_me ? '🟢 equipe' : vist ? `🟡 ${vist}?` : '⚪';
    linhas.push(`${marca} ${diaSemana(m.ts)} ${hora(m.ts)} *${m.author_name || '?'}*: ${String(m.text).replace(/\s+/g, ' ').slice(0, 70)}`);
  }
  const vis = (await q(`SELECT * FROM visitas WHERE condo_key = $1 AND COALESCE(entrada, saida, ultima_atividade) >= $2 ORDER BY id`, [condoKey, inicio])).rows;
  linhas.push(`\n🏁 Visitas registradas na semana: ${vis.length ? vis.map((v) => `${quando(v)} ${v.vistoriador} (${v.tipo})`).join(' · ') : 'nenhuma'}`);
  linhas.push('\n🟢 = reconhecido como equipe · 🟡 = nome igual ao de um vistoriador · ⚪ = tratado como morador');
  return linhas.join('\n');
}

// ---------- verificação geral: a IA lê todas as mensagens da semana dos condomínios ainda sem vistoria ----------
const INSTR_VERIFICAR = `Você confere o CONTROLE DE VISITAS da Alpha Condomínios (administradora). Recebe todas as mensagens da semana
dos grupos de WhatsApp de UM condomínio e diz se algum FUNCIONÁRIO DA ALPHA esteve fisicamente no condomínio.
Conta como presença QUALQUER ida, por qualquer motivo: aviso de chegada/vistoria, fotos ou relatos feitos no local
("verifiquei a bomba", "estou aqui com o técnico"), entrega ou retirada de material ("deixei o material na portaria",
"levei as lâmpadas"), acompanhar serviço ou obra, atender chamado, reunião/assembleia, saída ("finalizado", "saindo").
NÃO conta: visita futura, agendada ou "a caminho" ("passo amanhã", "vou levar o material", "estou a caminho", "indo aí") sem confirmação de que chegou, resposta à distância, relato de problema ou providência sem dizer que está no local ("a fechadura está com defeito", "vamos verificar a porta"), morador, síndico morador, prestador terceirizado.
Na dúvida, NÃO registre: é melhor faltar uma ida (o Luiz lança à mão) do que inventar uma que não houve.
Funcionários da Alpha costumam assinar "Alpha Administradora" ou estar marcados como EQUIPE ALPHA, mas podem não estar.
Fotos ou vídeos ([imagem], [vídeo]) mandados por funcionário da Alpha durante o dia contam como presença no local.
Use SÓ as mensagens do próprio grupo deste condomínio: não conte ida a OUTRO condomínio citado na conversa (nomes parecidos, ex.: "Beatriz" x "Paula Beatriz").
Para cada ida diferente, informe data, hora de entrada (aproximada pela primeira mensagem no local) e de saída (se houver), quem foi e o tipo:
"ordinaria" se for vistoria de rotina ou mencionar vistoria; "extraordinaria" para qualquer outro motivo (entrega de material, chamado, serviço…).
Responda SOMENTE JSON: {"visitas":[{"data":"dd/mm","entrada":"hh:mm","saida":"hh:mm ou vazio","quem":"nome","tipo":"ordinaria|extraordinaria","motivo":"poucas palavras","evidencia":"trecho curto da mensagem"}]}`;

export async function verificarSemana(offset = 0, { aoProgresso } = {}) {
  const { inicio, fim } = semana(offset);
  const { itens, fora } = await universo();
  const vis = await visitasNoPeriodo(inicio, fim);
  const comOrd = new Set(vis.filter((v) => v.tipo === 'ordinaria').map((v) => v.condo_key));
  // todos os condomínios com grupo (toda ida conta, não só a vistoria que falta)
  const alvos = [...itens.filter((i) => i.temGrupo),
    ...fora.map((c) => ({ condo_key: c.condo_key, nome: c.condo_name, vistoriador: 'fora do quadro', temGrupo: true }))];
  const descartadas = await getDescartadas();
  const achados = [];
  let semMsgs = 0;
  for (const [n, it] of alvos.entries()) {
    const msgs = (await q(
      `SELECT m.ts, m.author_name, m.from_me, m.text, c.kind FROM messages m JOIN chats c ON c.jid = m.chat_jid
       WHERE c.condo_key = $1 AND m.ts >= $2 AND m.ts < $3 ORDER BY m.ts LIMIT 600`, [it.condo_key, inicio, fim]
    )).rows;
    if (!msgs.length) { semMsgs++; continue; }
    if (aoProgresso && n && n % 15 === 0) await aoProgresso(`🔎 ${n} de ${alvos.length} condomínios conferidos…`);
    try {
      const r = await gerarJSON(INSTR_VERIFICAR,
        `CONDOMÍNIO: ${it.nome}\nMENSAGENS DA SEMANA:\n` +
        msgs.map((m) => {
          const eq = m.from_me || /alpha\s+(administradora|condom[ií]nios)/i.test(m.text || '');
          return `[${fmt(m.ts, { day: '2-digit', month: '2-digit' })} ${hora(m.ts)}] (${m.kind}) ${eq ? `EQUIPE ALPHA (${m.author_name || ''})` : m.author_name || 'Participante'}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 300)}`;
        }).join('\n'), { leve: true, tarefa: 'Vistorias (verificação geral)' });
      for (const v of r?.visitas || []) {
        if (!v?.data || !v?.entrada) continue;
        // trava: precisa de foto/vídeo ou mensagem com sinal de presença naquele dia
        const doDia = msgs.filter((m) => fmt(m.ts, { day: '2-digit', month: '2-digit' }) === String(v.data).slice(0, 5).padStart(5, '0'));
        const quem1 = normalize(v.quem || '').split(' ')[0];
        const prova = doDia.some((m) => (m.from_me || /alpha\s+(administradora|condom)/i.test(m.text || '') || (quem1 && normalize(m.author_name || '').includes(quem1))) &&
          (PRESENCA.test(m.text || '') || /^\[(imagem|vídeo)\]/.test(String(m.text || '').trim())));
        if (!prova) { console.log(`[verificar] ${it.nome} ${v.data}: sem prova de presença, não registrada`); continue; }
        const entrada = dataHoraBR(v.data, v.entrada);
        if (isNaN(entrada) || entrada < inicio || entrada >= fim) continue;
        const saida = v.saida && /\d/.test(v.saida) ? dataHoraBR(v.data, v.saida) : null;
        // não duplica ida já registrada no mesmo condomínio (até 2h de diferença)
        const dup = await q(
          `SELECT 1 FROM visitas WHERE condo_key = $1 AND ABS(EXTRACT(EPOCH FROM (COALESCE(entrada, saida) - $2::timestamptz))) < 7200 LIMIT 1`,
          [it.condo_key, entrada]);
        if (dup.rows.length) continue;
        if (descartadas.includes(`${it.condo_key}|${diaBR(entrada)}`)) continue; // apagada à mão: não volta
        const tipo = !comOrd.has(it.condo_key) ? 'ordinaria' : 'extraordinaria'; // 1ª ida da semana conta
        if (tipo === 'ordinaria') comOrd.add(it.condo_key);
        await q(
          `INSERT INTO visitas (condo_key, condo_nome, vistoriador, tipo, motivo, entrada, saida, ultima_atividade, entrada_txt, origem)
           VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,COALESCE($7::timestamptz,$6::timestamptz),$8,'verificacao')`,
          [it.condo_key, it.nome, (v.quem || 'Equipe').split(' ')[0], tipo, v.motivo || null, entrada, saida, v.evidencia || null]);
        achados.push({ it, v, tipo });
      }
    } catch (e) {
      console.error('[verificar]', it.nome, e.message);
    }
  }
  await consolidarDuplicadas().catch(() => {});
  return { conferidos: alvos.length, semMsgs, achados };
}

// Condomínios do quadro sem grupo da IA + grupos da IA fora do quadro (para usar !apelido)
export async function semGrupo() {
  const { itens, fora, vistoriadores } = await universo();
  const sem = itens.filter((i) => !i.temGrupo);
  const blocos = [`🔗 *Quadro x grupos da IA*\n✅ ${itens.length - sem.length} de ${itens.length} condomínios do quadro têm grupo com a IA\n⚠️ ${sem.length} sem grupo · ❔ ${fora.length} grupo(s) fora do quadro`];
  for (const v of vistoriadores) {
    const l = sem.filter((i) => i.vistoriador === v);
    if (l.length) blocos.push(`👷 *${v}* (${l.length})\n${l.map((i) => `• ${i.nome}`).join('\n')}`);
  }
  if (fora.length) {
    blocos.push(`❔ *Grupos da IA que não casaram com o quadro (${fora.length})*\n${fora.map((c) => `• ${c.condo_name}`).join('\n')}\n\n` +
      `Se um deles for um condomínio da lista ⚠️ com outro nome, ligue com:\n_!apelido nome no quadro = nome do grupo_\nEx.: _!apelido helena perez = helena borja_`);
  }
  blocos.push(`Para os ⚠️ que não têm grupo: adicione o número da IA no grupo e mande *!sincronizar*.`);
  return blocos;
}

// ---------- manutenção da carteira ----------
export async function removerDaCarteira(nome) {
  const alvo = normalize(nome);
  const r = (await q(`SELECT id, condo_nome FROM carteira WHERE ativo`)).rows.filter((x) => normalize(x.condo_nome) === alvo);
  for (const x of r) await q(`UPDATE carteira SET ativo = FALSE WHERE id = $1`, [x.id]);
  return r.map((x) => x.condo_nome);
}
export async function incluirNaCarteira(nome, vistoriador) {
  const ja = (await q(`SELECT id FROM carteira WHERE ativo`)).rows.length &&
    (await q(`SELECT id, condo_nome FROM carteira WHERE ativo`)).rows.find((x) => normalize(x.condo_nome) === normalize(nome));
  if (ja) await q(`UPDATE carteira SET vistoriador = $2 WHERE id = $1`, [ja.id, vistoriador]);
  else await q(`INSERT INTO carteira (condo_nome, vistoriador) VALUES ($1, $2)`, [nome, vistoriador]);
  return ja ? 'trocado' : 'incluido';
}
export async function buscarNaCarteira(nome) {
  const alvo = normalize(nome);
  const rows = (await q(`SELECT condo_nome, vistoriador FROM carteira WHERE ativo ORDER BY id`)).rows;
  return rows.find((x) => normalize(x.condo_nome) === alvo) || null;
}

// ---------- envios programados: relatório de um vistoriador para um grupo, todo dia num horário ----------
async function getEnvios() {
  try { return JSON.parse(await getSetting('envios', '[]')); } catch { return []; }
}
export async function listarEnvios() { return getEnvios(); }
export async function salvarEnvio(e) {
  const l = (await getEnvios()).filter((x) => !(x.jid === e.jid && normalize(x.vistoriador) === normalize(e.vistoriador)));
  l.push(e);
  await setSetting('envios', JSON.stringify(l));
}
export async function removerEnvio(i) {
  const l = await getEnvios();
  const [r] = l.splice(i, 1);
  await setSetting('envios', JSON.stringify(l));
  return r;
}
export async function enviarRelatorioVistoriador(e) {
  const msgs = await relatorio(0, { so: e.vistoriador });
  for (const m of msgs) await sendText(e.jid, m);
}
export async function rodarEnvios() {
  const agora = new Date(Date.now() - OFFSET);
  const hoje = agora.toISOString().slice(0, 10);
  for (const e of await getEnvios()) {
    const [h, m] = String(e.hora).split(':').map(Number);
    if (agora.getUTCHours() * 60 + agora.getUTCMinutes() < h * 60 + (m || 0)) continue;
    if (e.dias && !e.dias.includes(agora.getUTCDay())) continue;
    const chave = `envio_${e.jid}_${normalize(e.vistoriador)}_${hoje}`;
    if (await getSetting(chave)) continue;
    await setSetting(chave, new Date().toISOString());
    try {
      await enviarRelatorioVistoriador(e);
      console.log(`[envio] relatório de ${e.vistoriador} enviado para ${e.nome}`);
    } catch (err) {
      console.error('[envio]', err.message);
    }
  }
}

// ---------- conferência automática: todo dia às 18h40 (e segunda 06h para a semana anterior) ----------
export async function conferenciaAutomatica() {
  await fecharDia().catch((e) => console.error('[visita] fechar dia', e.message));
  const agora = new Date(Date.now() - OFFSET);
  const min = agora.getUTCHours() * 60 + agora.getUTCMinutes();
  const hoje = agora.toISOString().slice(0, 10);
  const tarefas = [];
  if (min >= 18 * 60 + 40) tarefas.push({ chave: `conf_auto_${hoje}`, offset: 0 }); // antes dos relatórios das 19h
  if (agora.getUTCDay() === 1 && min >= 6 * 60) tarefas.push({ chave: `conf_auto_passada_${hoje}`, offset: -1 });
  for (const t of tarefas) {
    if (await getSetting(t.chave)) continue;
    await setSetting(t.chave, new Date().toISOString());
    try {
      const rel = await reprocessarSemana(t.offset);
      const r = await verificarSemana(t.offset);
      const total = rel.novas + r.achados.length;
      console.log(`[conferência] ${t.offset ? 'semana passada' : 'semana'}: ${total} ida(s) recuperada(s)`);
      if (total) {
        await sendToSuggestionGroup(
          `🔎 *Conferência automática das vistorias${t.offset ? ' (semana passada)' : ''}*\n${total} ida(s) que tinham passado foram registradas.` +
          (r.achados.length ? `\n\n${r.achados.map(({ it, v }) => `• ${it.nome} — ${v.data} ${v.entrada} · ${v.quem || 'equipe'}`).join('\n')}` : '')
        );
      }
    } catch (e) {
      console.error('[conferência]', e.message);
    }
  }
}

// ---------- comparar com a lista da equipe (colada no WhatsApp) ----------
// Linhas: NOME <tab> dd/mm/aaaa <tab> QUEM [<tab> dd/mm observação QUEM]
function lerLista(texto) {
  const linhas = String(texto).split('\n').map((l) => l.trim()).filter(Boolean);
  const itens = [];
  for (const l of linhas) {
    const m = l.match(/^(.+?)[\t ]{1,}(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)[\t ]+([A-Za-zÀ-ú]+)(?:[\t ]+(.*))?$/);
    if (!m) continue;
    itens.push({ nome: m[1].trim(), data: m[2], quem: m[3], extras: [], obs: (m[4] || '').trim() });
  }
  // observação "17/11 LIMPEZA CX GORDURA NATHAN" ou "17/11 NATHAN SUBSTITUIR SENSOR PORTÃO":
  // quem foi = a palavra que é nome de alguém da coluna QUEM
  const pessoas = new Set(itens.map((i) => normalize(i.quem)));
  for (const it of itens) {
    const e = it.obs.match(/^(\d{1,2}\/\d{1,2})\s+(.+)$/);
    if (!e) continue;
    const pal = e[2].split(/\s+/);
    const iq = pal.findIndex((w) => pessoas.has(normalize(w)));
    const quem = iq >= 0 ? pal[iq] : it.quem;
    const motivo = pal.filter((_, i) => i !== iq).join(' ').trim();
    it.extras.push({ data: e[1], motivo, quem });
  }
  return itens;
}

const nomeProprio = (s) => String(s || '').toLowerCase().replace(/(^|\s)\S/g, (x) => x.toUpperCase());

export async function compararLista(texto, { lancar = false } = {}) {
  const itens = lerLista(texto);
  if (!itens.length) return ['Não reconheci nenhuma linha. Formato: NOME  dd/mm/aaaa  QUEM (uma por linha, pode colar da planilha).'];
  const condos = await listCondos();
  const nomesLista = itens.map((i) => i.nome);
  const apelidos = await getApelidos();
  const ok = [], faltam = [], semGrupo = [], lancadas = [];

  for (const it of itens) {
    const ap = apelidos[normalize(it.nome)];
    const c = (ap && condos.find((x) => x.condo_key === ap)) || melhorCasamento(it.nome, condos, nomesLista);
    if (!c) { semGrupo.push(it); continue; }
    const ini = dataHoraBR(it.data, '00:00');
    const fim = new Date(ini.getTime() + 86400000);
    const tem = (await q(
      `SELECT * FROM visitas WHERE condo_key = $1 AND COALESCE(entrada, saida, ultima_atividade) >= $2 AND COALESCE(entrada, saida, ultima_atividade) < $3 LIMIT 1`,
      [c.condo_key, ini, fim])).rows[0];
    if (tem) { ok.push({ it, c, v: tem }); }
    else {
      faltam.push({ it, c });
      if (lancar) {
        await q(
          `INSERT INTO visitas (condo_key, condo_nome, vistoriador, tipo, motivo, entrada, ultima_atividade, origem)
           VALUES ($1,$2,$3,'ordinaria','lançada pela lista',$4,$4,'lista')`,
          [c.condo_key, c.condo_name, nomeProprio(it.quem), dataHoraBR(it.data, '12:00')]);
        lancadas.push(it);
      }
    }
    // idas extras anotadas na observação
    for (const e of it.extras) {
      const ei = dataHoraBR(e.data, '00:00');
      const ja = (await q(
        `SELECT 1 FROM visitas WHERE condo_key = $1 AND COALESCE(entrada, saida, ultima_atividade) >= $2 AND COALESCE(entrada, saida, ultima_atividade) < $3
           AND (motivo ILIKE $4 OR vistoriador ILIKE $5) LIMIT 1`,
        [c.condo_key, ei, new Date(ei.getTime() + 86400000), `%${e.motivo.split(' ')[0]}%`, e.quem])).rows.length;
      if (!ja && lancar) {
        await q(
          `INSERT INTO visitas (condo_key, condo_nome, vistoriador, tipo, motivo, entrada, ultima_atividade, origem)
           VALUES ($1,$2,$3,'extraordinaria',$4,$5,$5,'lista')`,
          [c.condo_key, c.condo_name, nomeProprio(e.quem), e.motivo.toLowerCase(), dataHoraBR(e.data, '12:00')]);
      }
    }
  }
  if (lancar) await consolidarDuplicadas().catch(() => {});
  // se a 1ª ida da semana ficou como extra, a correção do início acerta; aqui só garantimos a regra
  const msgs = [];
  msgs.push(
    `📋 *Comparação com a sua lista* (${itens.length} idas)\n\n` +
    `✅ ${ok.length} já estavam registradas\n❌ ${faltam.length} não estavam no sistema${lancar ? ` → *${lancadas.length} lançadas agora*` : ''}\n` +
    (semGrupo.length ? `⚠️ ${semGrupo.length} sem grupo da IA (não dá para registrar)\n` : '') +
    `\nRegistradas: ${itens.length ? Math.round((ok.length / itens.length) * 100) : 0}% da sua lista`
  );
  if (faltam.length) {
    msgs.push(`❌ *Não estavam no sistema*\n\n${faltam.map(({ it, c }) => `• ${it.nome} → ${c.condo_name}\n   ${it.data} · ${nomeProprio(it.quem)}`).join('\n')}` +
      (lancar ? '' : `\n\nPara lançar todas de uma vez, mande a mesma lista com *!vistorias lancar* na primeira linha.`));
  }
  if (semGrupo.length) {
    msgs.push(`⚠️ *Sem grupo da IA*\n${semGrupo.map((i) => `• ${i.nome} (${i.data})`).join('\n')}\n\nSe o grupo existir com outro nome: _!apelido nome da lista = nome do grupo_`);
  }
  if (ok.length && !lancar) {
    msgs.push(`✅ *Já registradas*\n${ok.map(({ it, v }) => `• ${it.nome} · ${quando(v)}`).join('\n')}`);
  }
  return msgs;
}

// ---------- apagar ida registrada por engano (ex.: "a caminho" que não foi, condomínio confundido) ----------
async function getDescartadas() {
  try { return JSON.parse(await getSetting('visitas_descartadas', '[]')); } catch { return []; }
}
export async function apagarVisitas(nome, data) {
  const u = await universo();
  const alvo = normalize(nome);
  const it = u.itens.find((i) => normalize(i.nome) === alvo) || u.itens.find((i) => normalize(i.nomeGrupo || '') === alvo);
  let condoKey = it?.condo_key, rotulo = it?.nome;
  if (!condoKey) {
    const c = (await listCondos()).find((x) => normalize(x.condo_name) === alvo) || u.fora.find((x) => normalize(x.condo_name).includes(alvo));
    condoKey = c?.condo_key; rotulo = c?.condo_name;
  }
  if (!condoKey) return `Não achei "${nome}". Use o nome como está no relatório (ex.: !vistorias apagar antares).`;
  let ini, fim;
  if (data) { ini = dataHoraBR(data, '00:00'); fim = new Date(ini.getTime() + 86400000); }
  else ({ inicio: ini, fim } = semana(0));
  const vis = (await q(
    `SELECT * FROM visitas WHERE condo_key = $1 AND COALESCE(entrada, saida, ultima_atividade) >= $2 AND COALESCE(entrada, saida, ultima_atividade) < $3 ORDER BY id`,
    [condoKey, ini, fim])).rows;
  if (!vis.length) return `Nenhuma ida registrada para *${rotulo}* ${data ? `em ${data}` : 'nesta semana'}.`;
  const desc = await getDescartadas();
  for (const v of vis) {
    await q('DELETE FROM visitas WHERE id = $1', [v.id]);
    const k = `${condoKey}|${diaBR(v.entrada || v.saida || v.ultima_atividade)}`;
    if (!desc.includes(k)) desc.push(k);
  }
  await setSetting('visitas_descartadas', JSON.stringify(desc.slice(-500)));
  await ajustarOrdinarias(); // se apagou a ordinária, a próxima ida da semana passa a contar
  return `🗑️ *${rotulo}*: apaguei ${vis.length} ida(s):\n${vis.map((v) => `• ${quando(v)} ${v.vistoriador}${v.motivo ? ` _(${v.motivo})_` : ''}`).join('\n')}\n\n` +
    `A verificação não registra de novo nesse dia. O condomínio volta para pendente se não houver outra ida na semana.`;
}

// ---------- planilha Google: todas as idas (lida pelo Apps Script em /api/idas/<token>) ----------
const ORIGEM_TXT = { grupo: 'Grupo', manual: 'Lançada à mão', verificacao: 'Verificação geral', lista: 'Lista da equipe' };
export async function planilhaIdas() {
  const { itens } = await universo();
  const porKey = new Map(itens.filter((i) => i.condo_key).map((i) => [i.condo_key, i]));
  const rows = (await q(`SELECT * FROM visitas ORDER BY COALESCE(entrada, saida, ultima_atividade), id`)).rows;
  const semanaDe = (d) => { const { inicio } = semana(0, new Date(d)); return dataLonga(inicio); };
  return rows.map((v) => {
    const ref = v.entrada || v.saida || v.ultima_atividade;
    const it = porKey.get(v.condo_key);
    const semHora = v.origem === 'lista';
    const ent = v.entrada && !semHora ? hora(v.entrada) : '';
    const sai = v.saida && !semHora ? hora(v.saida) : '';
    const min = v.entrada && v.saida && !semHora ? Math.round((new Date(v.saida) - new Date(v.entrada)) / 60000) : null;
    return {
      id: v.id,
      data: ref ? dataLonga(ref) : '',
      dia: ref ? diaSemana(ref) : '',
      semana: ref ? semanaDe(ref) : '',
      mes: ref ? fmt(ref, { month: '2-digit', year: 'numeric' }) : '',
      condominio: it?.nome || v.condo_nome || v.condo_key,
      responsavel: it?.vistoriador || '',
      quem: v.vistoriador || '',
      tipo: v.tipo === 'ordinaria' ? 'Vistoria da semana' : 'Ida extra',
      motivo: v.motivo && !/lan[cç]ada pela lista/i.test(v.motivo) ? v.motivo : '',
      entrada: ent,
      saida: sai,
      saida_estimada: v.saida && v.saida_estimada ? 'Sim' : '',
      duracao: min != null && min >= 0 ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}` : '',
      origem: ORIGEM_TXT[v.origem] || v.origem || '',
      evidencia: (v.entrada_txt || '').slice(0, 200),
    };
  });
}
