import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
});

const q = (sql, params) => pool.query(sql, params);

export async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS chats (
      jid        TEXT PRIMARY KEY,
      name       TEXT,
      kind       TEXT,          -- moradores | sindico | conselho | privado | outro
      condo_key  TEXT,
      condo_name TEXT,
      enabled    BOOLEAN DEFAULT TRUE,
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    -- Liga uma pessoa (número ou LID) ao condomínio onde ela aparece no grupo de moradores
    CREATE TABLE IF NOT EXISTS contacts (
      jid       TEXT PRIMARY KEY,
      name      TEXT,
      condo_key TEXT,
      seen_at   TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      chat_jid    TEXT NOT NULL,
      ts          TIMESTAMPTZ NOT NULL,
      author_jid  TEXT,
      author_name TEXT,
      from_me     BOOLEAN DEFAULT FALSE,
      kind        TEXT,
      text        TEXT,
      quoted_id   TEXT,
      quoted_text TEXT,
      status      TEXT,         -- NULL | pendente | respondida | descartada
      summary     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_msg_chat_ts ON messages (chat_jid, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_msg_status  ON messages (status, ts DESC);
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS manual BOOLEAN DEFAULT FALSE;

    -- Compatibilidade com o banco da versão de 08/10, se ele for reaproveitado
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'chats' AND column_name = 'is_group') THEN
        ALTER TABLE chats ALTER COLUMN is_group DROP NOT NULL;
      END IF;
    END $$;
  `);
}

// ---------- settings ----------
export async function getSetting(key, fallback = null) {
  const r = await q('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows[0]?.value ?? fallback;
}
export async function setSetting(key, value) {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

// ---------- chats ----------
export async function getChat(jid) {
  return (await q('SELECT * FROM chats WHERE jid = $1', [jid])).rows[0] || null;
}
export async function upsertChat({ jid, name, kind, condo_key, condo_name }) {
  await q(
    `INSERT INTO chats (jid, name, kind, condo_key, condo_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (jid) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, chats.name),
       kind = COALESCE(EXCLUDED.kind, chats.kind),
       condo_key  = COALESCE(EXCLUDED.condo_key, chats.condo_key),
       condo_name = COALESCE(EXCLUDED.condo_name, chats.condo_name),
       updated_at = now()`,
    [jid, name || null, kind || null, condo_key || null, condo_name || null]
  );
}
export async function setCondoEnabled(condo_key, enabled) {
  await q('UPDATE chats SET enabled = $2 WHERE condo_key = $1', [condo_key, enabled]);
}
export async function listCondos() {
  const r = await q(`
    SELECT condo_key, MIN(condo_name) AS condo_name,
           ARRAY_AGG(DISTINCT kind) AS kinds,
           BOOL_AND(enabled) AS enabled
    FROM chats
    WHERE condo_key IS NOT NULL AND kind IN ('moradores','sindico','conselho')
    GROUP BY condo_key
    ORDER BY MIN(condo_name)`);
  return r.rows;
}
export async function chatsOfCondo(condo_key) {
  return (await q('SELECT * FROM chats WHERE condo_key = $1', [condo_key])).rows;
}

// ---------- contatos ----------
export async function linkContact(jid, name, condo_key) {
  if (!jid || !condo_key) return;
  await q(
    `INSERT INTO contacts (jid, name, condo_key) VALUES ($1, $2, $3)
     ON CONFLICT (jid) DO UPDATE SET name = COALESCE(EXCLUDED.name, contacts.name),
       condo_key = EXCLUDED.condo_key, seen_at = now()`,
    [jid, name || null, condo_key]
  );
}
export async function contactCondo(jids) {
  const lista = jids.filter(Boolean);
  if (!lista.length) return null;
  const r = await q('SELECT condo_key FROM contacts WHERE jid = ANY($1) ORDER BY seen_at DESC LIMIT 1', [lista]);
  return r.rows[0]?.condo_key || null;
}

// ---------- mensagens ----------
export async function saveMessage(m) {
  const r = await q(
    `INSERT INTO messages (id, chat_jid, ts, author_jid, author_name, from_me, kind, text, quoted_id, quoted_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO NOTHING`,
    [m.id, m.chatJid, m.ts, m.authorJid, m.authorName, m.fromMe, m.kind, m.text, m.quotedId, m.quotedText]
  );
  return r.rowCount === 1; // false = duplicada
}
export async function recentMessages(chatJid, limit) {
  const r = await q(
    `SELECT * FROM (SELECT * FROM messages WHERE chat_jid = $1 ORDER BY ts DESC LIMIT $2) t ORDER BY ts ASC`,
    [chatJid, limit]
  );
  return r.rows;
}
export async function messagesSince(chatJids, sinceHours, limit) {
  if (!chatJids.length) return [];
  const r = await q(
    `SELECT m.*, c.kind AS chat_kind FROM messages m JOIN chats c ON c.jid = m.chat_jid
     WHERE m.chat_jid = ANY($1) AND m.ts > now() - ($2 || ' hours')::interval
     ORDER BY m.ts DESC LIMIT $3`,
    [chatJids, String(sinceHours), limit]
  );
  return r.rows.reverse();
}
export async function markPending(ids, summary) {
  await q(`UPDATE messages SET status = 'pendente', summary = $2 WHERE id = ANY($1)`, [ids, summary]);
}
// Fecha a mensagem citada e as outras da mesma pendência (mesma conversa e mesmo resumo)
export async function resolveById(id) {
  const r = await q(
    `UPDATE messages m SET status = 'respondida'
     FROM messages alvo
     WHERE alvo.id = $1 AND m.status = 'pendente' AND m.chat_jid = alvo.chat_jid
       AND (m.id = alvo.id OR (alvo.summary IS NOT NULL AND m.summary = alvo.summary))`,
    [id]
  );
  return r.rowCount;
}
export async function resolveChat(chatJid) {
  const r = await q(`UPDATE messages SET status = 'respondida' WHERE chat_jid = $1 AND status = 'pendente'`, [chatJid]);
  return r.rowCount;
}
export async function listPending(hours) {
  const r = await q(
    `SELECT m.*, c.name AS chat_name, c.condo_name, c.kind AS chat_kind
     FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
     WHERE m.status = 'pendente' AND m.ts > now() - ($1 || ' hours')::interval
     ORDER BY c.condo_name NULLS LAST, m.ts`,
    [String(hours)]
  );
  return r.rows;
}
export async function stats() {
  const r = await q(`
    SELECT
      (SELECT COUNT(*) FROM messages WHERE ts > now() - interval '24 hours') AS msgs_24h,
      (SELECT COUNT(*) FROM messages WHERE status = 'pendente') AS pendentes,
      (SELECT COUNT(*) FROM chats WHERE kind <> 'privado') AS grupos`);
  return r.rows[0];
}
export async function purgeOld(days) {
  const r = await q(`DELETE FROM messages WHERE ts < now() - ($1 || ' days')::interval`, [String(days)]);
  if (r.rowCount) console.log(`[limpeza] ${r.rowCount} mensagens antigas removidas`);
}
