import { config } from './config.js';
import { getSetting } from './db.js';

const { url, apiKey, instance } = config.evolution;
const groupNameCache = new Map();

async function call(path, options = {}) {
  const res = await fetch(`${url}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', apikey: apiKey, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Evolution ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * ÚNICA forma de enviar mensagem neste serviço: sempre para o grupo de sugestões.
 * Não existe função para enviar a grupos de condomínio ou a contatos.
 */
export async function sendToSuggestionGroup(text) {
  const jid = await getSetting('suggestion_group');
  if (!jid) throw new Error('Grupo de sugestões não definido (envie !aqui no grupo escolhido).');
  return call(`/message/sendText/${instance}`, {
    method: 'POST',
    body: JSON.stringify({ number: jid, text }),
  });
}

export async function getGroupName(jid) {
  if (groupNameCache.has(jid)) return groupNameCache.get(jid);
  const data = await call(`/group/findGroupInfos/${instance}?groupJid=${encodeURIComponent(jid)}`);
  const name = data?.subject || null;
  groupNameCache.set(jid, name);
  return name;
}

export async function fetchAllGroups() {
  const data = await call(`/group/fetchAllGroups/${instance}?getParticipants=false`);
  return (Array.isArray(data) ? data : []).filter((g) => g?.id?.endsWith('@g.us'));
}
