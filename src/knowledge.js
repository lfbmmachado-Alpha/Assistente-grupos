// Aprendizado: exemplos de respostas da equipe, base de fatos por condomínio e documentos.
import { pool, getSetting, setSetting, listCondos } from './db.js';
import { gerarJSON } from './gemini.js';

const q = (sql, params) => pool.query(sql, params);

export async function initKnowledge() {
  await q(`
    CREATE TABLE IF NOT EXISTS exemplos (
      id         SERIAL PRIMARY KEY,
      condo_key  TEXT,
      chat_kind  TEXT,
      pergunta   TEXT NOT NULL,
      resposta   TEXT NOT NULL,
      autor      TEXT,
      ts         TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS fatos (
      id            SERIAL PRIMARY KEY,
      condo_key     TEXT NOT NULL,
      fato          TEXT NOT NULL,
      fonte         TEXT DEFAULT 'conversas',   -- conversas | manual
      criado_em     TIMESTAMPTZ DEFAULT now(),
      atualizado_em TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_fatos_condo ON fatos (condo_key);
    CREATE TABLE IF NOT EXISTS documentos (
      id        SERIAL PRIMARY KEY,
      condo_key TEXT NOT NULL,
      titulo    TEXT NOT NULL,
      texto     TEXT NOT NULL,
      criado_em TIMESTAMPTZ DEFAULT now()
    );
  `);
}

// ---------- exemplos da equipe ----------
// Chamado quando alguém da equipe escreve numa conversa monitorada.
export async function registrarExemplo(chat, msg) {
  if (!msg.text || msg.text.length < 15 || msg.text.startsWith('!')) return;
  let alvo = null;
  if (msg.quotedId) {
    alvo = (await q(`SELECT * FROM messages WHERE id = $1 AND from_me = FALSE`, [msg.quotedId])).rows[0];
  }
  if (!alvo) {
    alvo = (await q(
      `SELECT * FROM messages WHERE chat_jid = $1 AND from_me = FALSE AND status = 'pendente'
         AND ts > now() - interval '24 hours' ORDER BY ts DESC LIMIT 1`,
      [msg.chatJid]
    )).rows[0];
  }
  if (!alvo) return;

  // A pergunta pode ter vindo em várias mensagens seguidas (mesmo resumo)
  let pergunta = alvo.text;
  if (alvo.summary) {
    const r = await q(
      `SELECT text FROM messages WHERE chat_jid = $1 AND summary = $2 AND from_me = FALSE ORDER BY ts`,
      [alvo.chat_jid, alvo.summary]
    );
    if (r.rows.length) pergunta = r.rows.map((x) => x.text).join('\n');
  }
  await q(
    `INSERT INTO exemplos (condo_key, chat_kind, pergunta, resposta, autor) VALUES ($1,$2,$3,$4,$5)`,
    [chat.condo_key, chat.kind, pergunta.slice(0, 1500), msg.text.slice(0, 2000), msg.authorName || null]
  );
  console.log(`[aprendizado] exemplo salvo (${chat.condo_key}): ${msg.text.slice(0, 50)}`);
}

export async function exemplosPara(condoKey, porCondo = 4, gerais = 4) {
  const mesmos = (await q(
    `SELECT * FROM exemplos WHERE condo_key = $1 ORDER BY ts DESC LIMIT $2`, [condoKey, porCondo]
  )).rows;
  const outros = (await q(
    `SELECT * FROM exemplos WHERE condo_key IS DISTINCT FROM $1 ORDER BY ts DESC LIMIT $2`, [condoKey, gerais]
  )).rows;
  return [...mesmos, ...outros];
}

export async function contarExemplos() {
  return (await q(`SELECT condo_key, COUNT(*)::int AS n FROM exemplos GROUP BY condo_key`)).rows;
}

// ---------- fatos ----------
export async function fatosDo(condoKey) {
  return (await q(`SELECT * FROM fatos WHERE condo_key = $1 ORDER BY atualizado_em DESC, id DESC`, [condoKey])).rows;
}
export async function adicionarFato(condoKey, fato, fonte = 'manual') {
  await q(`INSERT INTO fatos (condo_key, fato, fonte) VALUES ($1, $2, $3)`, [condoKey, fato, fonte]);
}
export async function removerFato(id) {
  return (await q(`DELETE FROM fatos WHERE id = $1`, [id])).rowCount;
}

// ---------- documentos ----------
export async function docsDo(condoKey) {
  return (await q(`SELECT * FROM documentos WHERE condo_key = $1 ORDER BY id`, [condoKey])).rows;
}
export async function salvarDocumento(condoKey, titulo, texto) {
  await q(`INSERT INTO documentos (condo_key, titulo, texto) VALUES ($1, $2, $3)`, [condoKey, titulo, texto]);
}
export async function removerDocumento(id) {
  return (await q(`DELETE FROM documentos WHERE id = $1`, [id])).rowCount;
}
export async function listarDocumentos() {
  return (await q(`SELECT id, condo_key, titulo, LENGTH(texto) AS tamanho, criado_em FROM documentos ORDER BY condo_key, id`)).rows;
}

// ---------- extração de fatos das conversas ----------
const INSTRUCOES_EXTRACAO = `Você mantém a BASE DE CONHECIMENTO de um condomínio para a administradora Alpha Condomínios.
Leia as conversas novas e atualize a base com fatos DURÁVEIS e úteis para responder perguntas futuras.

GUARDE: horários e regras de uso de áreas; fornecedores e prestadores (serviço e empresa); andamento de demandas
(o que foi pedido, orçado, aprovado, agendado, concluído — sempre com a data); decisões do síndico, conselho ou assembleia;
valores aprovados de obras e serviços do condomínio; procedimentos (como reservar, como pedir algo);
contatos de serviço (portaria, zeladoria, empresa de manutenção).

NÃO GUARDE: dados pessoais de moradores; inadimplência ou débitos de unidades; conflitos pessoais; opiniões, boatos,
cumprimentos, conversa casual; nada sobre saúde, religião, política.

Regras:
- Cada fato: uma frase curta e autocontida, citando a data quando for andamento ("Em 26/10/2026, o síndico pediu ...").
- Prefira o que foi dito pela EQUIPE ALPHA ou pelo síndico. Se vier só de morador, termine com "(segundo morador)".
- Se um fato existente mudou (ex.: orçamento aprovado), ATUALIZE-o em vez de criar outro. Remova o que ficou obsoleto.
- Não repita fatos que já existem. Se nada novo, devolva listas vazias.

Responda SOMENTE com JSON:
{"novos": ["..."], "atualizar": [{"id": 0, "fato": "..."}], "remover": [0]}`;

let aprendendo = false;

export async function aprender({ forcar = false } = {}) {
  if (aprendendo) return { ocupado: true };
  aprendendo = true;
  const resumo = { condominios: 0, novos: 0, atualizados: 0, removidos: 0 };
  try {
    const teste = JSON.parse(await getSetting('test_condos', '[]'));
    const modo = await getSetting('mode', 'teste');
    const condos = (await listCondos()).filter((c) => modo !== 'teste' || teste.includes(c.condo_key));

    for (const c of condos) {
      const chaveUlt = `kb_last_${c.condo_key}`;
      const ultimo = await getSetting(chaveUlt, '1970-01-01T00:00:00Z');
      const msgs = (await q(
        `SELECT m.*, ch.kind AS chat_kind FROM messages m JOIN chats ch ON ch.jid = m.chat_jid
         WHERE ch.condo_key = $1 AND m.ts > $2 ORDER BY m.ts LIMIT 400`,
        [c.condo_key, ultimo]
      )).rows;
      if (msgs.length < (forcar ? 1 : 5)) continue;

      const fatos = await fatosDo(c.condo_key);
      const linhas = msgs.map((m) => {
        const quando = new Date(m.ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const quem = m.from_me ? `EQUIPE ALPHA (${m.author_name || ''})` : m.author_name || 'Participante';
        return `[${quando}] (${m.chat_kind}) ${quem}: ${m.text}`;
      });
      const entrada =
        `CONDOMÍNIO: ${c.condo_name}\n\nBASE ATUAL:\n` +
        (fatos.length ? fatos.map((f) => `#${f.id}: ${f.fato}`).join('\n') : '(vazia)') +
        `\n\nCONVERSAS NOVAS:\n${linhas.join('\n')}`;

      const r = await gerarJSON(INSTRUCOES_EXTRACAO, entrada);
      const ids = new Set(fatos.map((f) => f.id));
      for (const f of r?.novos || []) {
        if (f && String(f).trim()) { await adicionarFato(c.condo_key, String(f).trim(), 'conversas'); resumo.novos++; }
      }
      for (const u of r?.atualizar || []) {
        if (ids.has(Number(u?.id)) && u?.fato) {
          await q(`UPDATE fatos SET fato = $2, atualizado_em = now() WHERE id = $1`, [Number(u.id), String(u.fato).trim()]);
          resumo.atualizados++;
        }
      }
      for (const id of r?.remover || []) {
        // fatos cadastrados à mão só saem com !esquecer
        const f = fatos.find((x) => x.id === Number(id));
        if (f && f.fonte !== 'manual') { await removerFato(f.id); resumo.removidos++; }
      }
      await setSetting(chaveUlt, new Date(msgs[msgs.length - 1].ts).toISOString());
      resumo.condominios++;
      console.log(`[aprendizado] ${c.condo_name}: +${(r?.novos || []).length} novos, ${(r?.atualizar || []).length} atualizados, ${(r?.remover || []).length} removidos`);
    }
  } finally {
    aprendendo = false;
  }
  return resumo;
}
