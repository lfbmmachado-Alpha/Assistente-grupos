// Converte o payload da Evolution (messages.upsert) em um objeto simples.

function desembrulhar(msg) {
  let m = msg || {};
  for (let i = 0; i < 4; i++) {
    const interno =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.documentWithCaptionMessage?.message ||
      m.editedMessage?.message;
    if (!interno) break;
    m = interno;
  }
  return m;
}

export function extrairConteudo(raw) {
  const m = desembrulhar(raw);
  if (m.conversation) return { text: m.conversation, ctx: null };
  if (m.extendedTextMessage) return { text: m.extendedTextMessage.text || '', ctx: m.extendedTextMessage.contextInfo };
  if (m.imageMessage) return { text: m.imageMessage.caption || '[imagem]', ctx: m.imageMessage.contextInfo };
  if (m.videoMessage) return { text: m.videoMessage.caption || '[vídeo]', ctx: m.videoMessage.contextInfo };
  if (m.documentMessage) {
    const d = m.documentMessage;
    return { text: d.caption || `[documento] ${d.fileName || ''}`.trim(), ctx: d.contextInfo, documento: { mimetype: d.mimetype || '', nome: d.fileName || '' } };
  }
  if (m.audioMessage) return { text: '[áudio]', ctx: m.audioMessage.contextInfo, audio: { mimetype: m.audioMessage.mimetype || 'audio/ogg', segundos: m.audioMessage.seconds || 0 } };
  const poll = m.pollCreationMessage || m.pollCreationMessageV3;
  if (poll) return { text: `[enquete] ${poll.name} — ${(poll.options || []).map((o) => o.optionName).join(' | ')}`, ctx: null };
  return null; // reação, figurinha, exclusão, protocolo: ignora
}

export function parseMessage(d) {
  const key = d?.key;
  if (!key?.remoteJid || !key.id) return null;
  const chatJid = key.remoteJid;
  if (chatJid === 'status@broadcast' || chatJid.endsWith('@newsletter') || chatJid.endsWith('@broadcast')) return null;

  const conteudo = extrairConteudo(d.message);
  if (!conteudo || !conteudo.text.trim()) return null;

  const isGroup = chatJid.endsWith('@g.us');
  const fromMe = !!key.fromMe;

  // Em grupo, o autor vem em participant (às vezes como LID); participantAlt traz o número quando há
  const authorJid = isGroup ? key.participant || d.participant || '' : fromMe ? '' : chatJid;
  const authorAlt = isGroup ? key.participantAlt || key.participantPn || '' : key.remoteJidAlt || key.senderPn || '';

  const ctx = conteudo.ctx;
  const quoted = ctx?.quotedMessage ? extrairConteudo(ctx.quotedMessage) : null;

  const ts = d.messageTimestamp ? new Date(Number(d.messageTimestamp) * 1000) : new Date();

  return {
    id: key.id,
    chatJid,
    isGroup,
    fromMe,
    authorJid,
    authorAlt,
    authorName: fromMe ? 'Você' : d.pushName || '',
    text: conteudo.text.trim(),
    quotedId: ctx?.stanzaId || null,
    quotedText: quoted?.text?.slice(0, 500) || null,
    ts,
    audio: conteudo.audio || null,
    documento: conteudo.documento || null,
    base64: d.message?.base64 || null, // vem preenchido se "Webhook Base64" estiver ligado
    key,
  };
}
