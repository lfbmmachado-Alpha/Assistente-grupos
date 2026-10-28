import { config } from './config.js';

const headers = { apikey: config.evolutionKey, 'Content-Type': 'application/json' };
const base = (path) => `${config.evolutionUrl}${path}/${encodeURIComponent(config.instance)}`;

// IDs das mensagens que o próprio sistema enviou (para não processar de volta)
export const sentIds = new Set();

// Fila de envio: no máximo uma mensagem a cada 1,5 s, para não chamar atenção do WhatsApp
const fila = [];
let enviando = false;

export function sendText(jid, text) {
  return new Promise((resolve) => {
    fila.push({ jid, text, resolve });
    processarFila();
  });
}

async function processarFila() {
  if (enviando) return;
  enviando = true;
  while (fila.length) {
    const { jid, text, resolve } = fila.shift();
    try {
      const res = await fetch(base('/message/sendText'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ number: jid, text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) console.error('[evolution] envio falhou', res.status, JSON.stringify(body).slice(0, 300));
      const id = body?.key?.id;
      if (id) {
        sentIds.add(id);
        if (sentIds.size > 2000) sentIds.delete(sentIds.values().next().value);
      }
      resolve(body);
    } catch (e) {
      console.error('[evolution] erro de envio:', e.message);
      resolve(null);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  enviando = false;
}

// Lista todos os grupos em que o número participa (só nomes, sem participantes)
export async function fetchAllGroups() {
  const res = await fetch(`${base('/group/fetchAllGroups')}?getParticipants=false`, { headers });
  if (!res.ok) throw new Error(`fetchAllGroups ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (Array.isArray(data) ? data : data?.groups || []).map((g) => ({ jid: g.id, name: g.subject || '' }));
}

export async function fetchGroupName(jid) {
  try {
    const res = await fetch(`${base('/group/findGroupInfos')}?groupJid=${encodeURIComponent(jid)}`, { headers });
    if (!res.ok) return '';
    return (await res.json())?.subject || '';
  } catch {
    return '';
  }
}

// Baixa uma mídia recebida (áudio, imagem…) em base64
export async function getMediaBase64(key) {
  const res = await fetch(base('/chat/getBase64FromMediaMessage'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: { key }, convertToMp4: false }),
  });
  if (!res.ok) throw new Error(`getBase64FromMediaMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { base64: data?.base64, mimetype: data?.mimetype };
}

// Envia um arquivo (planilha) para um chat
export async function sendDocument(jid, base64, fileName, caption = '') {
  const res = await fetch(base('/message/sendMedia'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      number: jid,
      mediatype: 'document',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      caption,
      media: base64,
      fileName,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`sendMedia ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  if (body?.key?.id) sentIds.add(body.key.id);
  return body;
}
