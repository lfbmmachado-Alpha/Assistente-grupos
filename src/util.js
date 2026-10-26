import { config } from './config.js';
import { getSetting, setSetting } from './db.js';
import { sendText } from './evolution.js';

export async function getMode() {
  return getSetting('mode', config.defaultMode);
}

export async function getList(key) {
  try { return JSON.parse(await getSetting(key, '[]')); } catch { return []; }
}

export async function sendToSuggestionGroup(text) {
  const g = await getSetting('suggestion_group');
  if (!g) { console.warn('[sugestões] grupo de sugestões ainda não definido (envie !aqui)'); return; }
  return sendText(g, truncate(text, 3900));
}

export function truncate(s, n) {
  s = s || '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export const digitos = (jid) => (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

// A mensagem é da equipe? (o próprio número da IA, quem fez o !aqui, ou EQUIPE_NUMEROS)
export async function isEquipe(msg) {
  if (msg.fromMe) return true;
  const admins = await getList('admins');
  const ids = [digitos(msg.authorJid), digitos(msg.authorAlt)].filter(Boolean);
  return ids.some((i) => admins.includes(i) || config.equipe.includes(i));
}

export async function registrarAdmin(msg) {
  const admins = await getList('admins');
  const ids = [digitos(msg.authorJid), digitos(msg.authorAlt)].filter(Boolean);
  await setSetting('admins', JSON.stringify([...new Set([...admins, ...ids])]));
}

// Assinaturas: { padrao: "Luiz", "cristiana": "Ygor", ... } (chave = condo_key)
export async function getAssinaturas() {
  try { return JSON.parse(await getSetting('assinaturas', '{}')); } catch { return {}; }
}

// Garante parágrafos separados por linha em branco e acrescenta a assinatura padrão da Alpha
export async function formatarSugestao(texto, condoKey) {
  const corpo = String(texto || '')
    .replace(/\r/g, '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^(att|atenciosamente|abs|abraços?)[.,!]*$/i.test(l) && !/alpha (administradora|condom[ií]nios)/i.test(l))
    .join('\n\n');
  const ass = await getAssinaturas();
  const nome = (condoKey && ass[condoKey]) || ass.padrao || '';
  return `${corpo}\n\nAtt\n\n${nome ? `${nome}\n` : ''}*Alpha Administradora*`;
}
