/**
 * Converte o payload "messages.upsert" da Evolution API v2 num objeto simples.
 * Aceita grupos (@g.us) e conversas privadas (@s.whatsapp.net / @lid).
 * Ignora status, canais e listas de transmissão.
 */
export function parseMessage(d) {
  const key = d?.key;
  const jid = key?.remoteJid;
  if (!jid || !key.id) return null;

  const isGroup = jid.endsWith('@g.us');
  const isPrivate = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
  if (!isGroup && !isPrivate) return null;

  const m = d.message || {};
  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    '';

  const ctx =
    d.contextInfo ||
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    null;
  const quoted = ctx?.quotedMessage;
  const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || quoted?.imageMessage?.caption || null;

  const rawTs = d.messageTimestamp;
  const seconds = typeof rawTs === 'object' && rawTs !== null ? rawTs.low : Number(rawTs);
  const ts = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();

  const fromMe = !!key.fromMe;
  const chatJidAlt = key.remoteJidAlt || null;

  let authorJid = null;
  let authorJidAlt = null;
  if (!fromMe) {
    if (isGroup) {
      authorJid = key.participant || d.participant || null;
      authorJidAlt = key.participantAlt || null;
    } else {
      authorJid = jid;
      authorJidAlt = chatJidAlt;
    }
  }

  return {
    id: key.id,
    chatJid: jid,
    chatJidAlt,
    isGroup,
    fromMe,
    authorJid,
    authorJidAlt,
    authorName: fromMe ? null : d.pushName || null,
    text: text.trim(),
    quotedId: ctx?.stanzaId || null,
    quotedText,
    ts,
  };
}
