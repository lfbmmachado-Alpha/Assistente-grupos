import pg from 'pg';
import { config } from './config.js';
import { classifyGroupName } from './classifier.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.pgSsl ? { rejectUnauthorized: false } : false,
});

const q = (text, params) => pool.query(text, params);

export async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Grupos e conversas privadas
    CREATE TABLE IF NOT EXISTS chats (
      jid        TEXT PRIMARY KEY,
      jid_alt    TEXT,
      is_group   BOOLEAN NOT NULL,
      name       TEXT,
      kind       TEXT NOT NULL,              -- moradores | sindico | conselho | privado | outro
      condo_key  TEXT,                       -- chave normalizada que liga os grupos do mesmo condomínio
      condo_name TEXT,
      manual     BOOLEAN NOT NULL DEFAULT FALSE, -- true = vínculo/tipo definido por você (não é sobrescrito)
      enabled    BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chats_condo ON chats (condo_key);

    CREATE TABLE IF NOT EXISTS chat_messages (
      chat_jid       TEXT NOT NULL REFERENCES chats(jid) ON DELETE CASCADE,
      id             TEXT NOT NULL,
      author_jid     TEXT,
      author_jid_alt TEXT,
      author_name    TEXT,
      from_me        BOOLEAN NOT NULL DEFAULT FALSE,
      text           TEXT NOT NULL,
      quoted_id      TEXT,
      ts             TIMESTAMPTZ NOT NULL,
      category       TEXT,
      urgency        TEXT,
      needs_response BOOLEAN,
      summary        TEXT,
      suggestion     TEXT,
      internal_note  TEXT,
      answered       BOOLEAN NOT NULL DEFAULT FALSE,
      analyzed_at    TIMESTAMPTZ,
      PRIMARY KEY (chat_jid, id)
    );
    CREATE INDEX IF NOT EXISTS cm_chat_ts  ON chat_messages (chat_jid, ts DESC);
    CREATE INDEX IF NOT EXISTS cm_pending  ON chat_messages (needs_response, answered, ts DESC);
    CREATE INDEX IF NOT EXISTS cm_author   ON chat_messages (author_jid);
    CREATE INDEX IF NOT EXISTS cm_author2  ON chat_messages (author_jid_alt);
  `);
}

// ---------- settings ----------
export async function getSetting(key) {
  const { rows } = await q('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export function setSetting(key, value) {
  return q(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

// ---------- chats ----------
export async function getChat(jid) {
  const { rows } = await q('SELECT * FROM chats WHERE jid = $1', [jid]);
  return rows[0] || null;
}

/** Cria/atualiza um grupo, classificando pelo nome (respeita vínculos manuais). */
export async function upsertGroupChat(jid, name) {
  const c = name ? classifyGroupName(name) : { kind: 'moradores', condoKey: null, condoName: null };
  const { rows } = await q(
    `INSERT INTO chats (jid, is_group, name, kind, condo_key, condo_name)
     VALUES ($1, TRUE, $2, $3, $4, $5)
     ON CONFLICT (jid) DO UPDATE SET
       name       = COALESCE(EXCLUDED.name, chats.name),
       kind       = CASE WHEN chats.manual OR EXCLUDED.name IS NULL THEN chats.kind       ELSE EXCLUDED.kind       END,
       condo_key  = CASE WHEN chats.manual OR EXCLUDED.name IS NULL THEN chats.condo_key  ELSE EXCLUDED.condo_key  END,
       condo_name = CASE WHEN chats.manual OR EXCLUDED.name IS NULL THEN chats.condo_name ELSE EXCLUDED.condo_name END,
       updated_at = now()
     RETURNING *`,
    [jid, name, c.kind, c.condoKey, c.condoName]
  );
  return rows[0];
}

export async function upsertPrivateChat(jid, jidAlt, name) {
  const { rows } = await q(
    `INSERT INTO chats (jid, jid_alt, is_group, name, kind)
     VALUES ($1, $2, FALSE, $3, 'privado')
     ON CONFLICT (jid) DO UPDATE SET
       name    = COALESCE(EXCLUDED.name, chats.name),
       jid_alt = COALESCE(EXCLUDED.jid_alt, chats.jid_alt),
       updated_at = now()
     RETURNING *`,
    [jid, jidAlt, name]
  );
  return rows[0];
}

export async function listChats(isGroup) {
  const { rows } = await q(
    'SELECT * FROM chats WHERE is_group = $1 ORDER BY name NULLS LAST, jid',
    [isGroup]
  );
  return rows;
}

export function setChatCondo(jid, condoKey, condoName, manual) {
  return q(
    `UPDATE chats SET condo_key = $2, condo_name = $3, manual = manual OR $4, updated_at = now() WHERE jid = $1`,
    [jid, condoKey, condoName, manual]
  );
}

export function setChatKind(jid, kind) {
  return q('UPDATE chats SET kind = $2, manual = TRUE, updated_at = now() WHERE jid = $1', [jid, kind]);
}

export function setChatEnabled(jid, enabled) {
  return q('UPDATE chats SET enabled = $2 WHERE jid = $1', [jid, enabled]);
}

export async function listCondos() {
  const { rows } = await q(
    `SELECT condo_key,
            (array_agg(condo_name ORDER BY (kind = 'moradores') DESC))[1] AS condo_name,
            array_agg(DISTINCT kind) AS kinds
     FROM chats
     WHERE is_group AND condo_key IS NOT NULL
     GROUP BY condo_key
     ORDER BY 2`
  );
  return rows;
}

/** Para conversa privada: descobre o condomínio pelo grupo onde a pessoa escreveu por último. */
export async function inferCondo(jids) {
  const { rows } = await q(
    `SELECT c.condo_key, c.condo_name
     FROM chat_messages m JOIN chats c ON c.jid = m.chat_jid
     WHERE c.is_group AND c.condo_key IS NOT NULL AND c.kind = 'moradores'
       AND (m.author_jid = ANY($1) OR m.author_jid_alt = ANY($1))
     ORDER BY m.ts DESC LIMIT 1`,
    [jids]
  );
  return rows[0] || null;
}

// ---------- mensagens ----------
/** Retorna true se a mensagem é nova (evita processar duplicadas do webhook). */
export async function saveMessage(m) {
  const r = await q(
    `INSERT INTO chat_messages (chat_jid, id, author_jid, author_jid_alt, author_name, from_me, text, quoted_id, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING`,
    [m.chatJid, m.id, m.authorJid, m.authorJidAlt, m.authorName, m.fromMe, m.text, m.quotedId, m.ts]
  );
  return r.rowCount === 1;
}

export async function getHistory(chatJid, beforeTs, limit) {
  const { rows } = await q(
    `SELECT author_name, from_me, text, ts FROM chat_messages
     WHERE chat_jid = $1 AND ts < $2
     ORDER BY ts DESC LIMIT $3`,
    [chatJid, beforeTs, limit]
  );
  return rows.reverse();
}

/** Mensagens recentes dos OUTROS grupos do mesmo condomínio. */
export async function getRelated(condoKey, excludeJid, kinds, beforeTs, days, limit) {
  if (!condoKey || !kinds.length) return [];
  const { rows } = await q(
    `SELECT m.author_name, m.from_me, m.text, m.ts, c.kind, c.name AS chat_name
     FROM chat_messages m JOIN chats c ON c.jid = m.chat_jid
     WHERE c.condo_key = $1 AND c.jid <> $2 AND c.is_group AND c.kind = ANY($3)
       AND m.ts < $4::timestamptz AND m.ts > $4::timestamptz - make_interval(days => $5::int)
     ORDER BY m.ts DESC LIMIT $6`,
    [condoKey, excludeJid, kinds, beforeTs, days, limit]
  );
  return rows.reverse();
}

export function saveAnalysis(chatJid, id, a) {
  return q(
    `UPDATE chat_messages
     SET category = $3, urgency = $4, needs_response = $5, summary = $6,
         suggestion = $7, internal_note = $8, analyzed_at = now()
     WHERE chat_jid = $1 AND id = $2`,
    [chatJid, id, a.categoria, a.urgencia, a.precisa_resposta, a.resumo, a.sugestao, a.nota_interna]
  );
}

export async function isAnswered(chatJid, id) {
  const { rows } = await q('SELECT answered FROM chat_messages WHERE chat_jid = $1 AND id = $2', [chatJid, id]);
  return rows[0]?.answered === true;
}

/**
 * Quando você responde:
 * - se citou uma mensagem, marca só ela como respondida;
 * - senão, marca as pendências das últimas 48h daquele chat.
 */
export function markAnswered(chatJid, ts, quotedId) {
  if (quotedId) {
    return q('UPDATE chat_messages SET answered = TRUE WHERE chat_jid = $1 AND id = $2', [chatJid, quotedId]);
  }
  return q(
    `UPDATE chat_messages SET answered = TRUE
     WHERE chat_jid = $1 AND NOT answered AND NOT from_me
       AND ts <= $2::timestamptz AND ts > $2::timestamptz - interval '48 hours'`,
    [chatJid, ts]
  );
}

export async function listPending(hours) {
  const { rows } = await q(
    `SELECT m.*, c.name AS chat_name, c.kind, c.condo_name
     FROM chat_messages m JOIN chats c ON c.jid = m.chat_jid
     WHERE m.needs_response AND NOT m.answered AND c.enabled
       AND m.ts > now() - make_interval(hours => $1::int)
     ORDER BY COALESCE(c.condo_name, c.name), c.kind, m.ts`,
    [hours]
  );
  return rows;
}

export function purgeOld(days) {
  return q('DELETE FROM chat_messages WHERE ts < now() - make_interval(days => $1::int)', [days]);
}
