import { config } from './config.js';
import {
  getSetting, getChat, upsertChat, saveMessage, linkContact, contactCondo,
  recentMessages, messagesSince, chatsOfCondo, markPending, resolveById, resolveChat, listCondos,
} from './db.js';
import { sentIds, fetchGroupName, getMediaBase64 } from './evolution.js';
import { getMode, getList, sendToSuggestionGroup, truncate, isEquipe, formatarSugestao } from './util.js';
import { classifyGroup, unificar } from './groups.js';
import { parseMessage } from './parse.js';
import { analisar, transcrever } from './gemini.js';
import { handleCommand } from './commands.js';

// ---------- entrada do webhook ----------
export async function handleWebhook(body) {
  if (!body) return;
  const evento = String(body.event || '').toLowerCase().replace(/_/g, '.');

  if (evento === 'connection.update') {
    console.log('[conexão]', JSON.stringify(body.data || {}).slice(0, 200));
    return;
  }
  if (evento !== 'messages.upsert') return;
  if (body.instance && body.instance !== config.instance) return;

  const itens = Array.isArray(body.data) ? body.data : [body.data];
  for (const d of itens) {
    try {
      await processar(d);
    } catch (e) {
      console.error('[mensagem]', e.message);
    }
  }
}

async function processar(d) {
  const msg = parseMessage(d);
  if (!msg || sentIds.has(msg.id)) return;

  const suggestionGroup = await getSetting('suggestion_group');

  msg.equipe = await isEquipe(msg);

  // Comandos começam com "!". Só a equipe usa; a exceção é o primeiro !aqui (cadastra você).
  if (msg.text.startsWith('!')) {
    const primeiroAqui = !suggestionGroup && msg.isGroup && /^!aqui\b/i.test(msg.text);
    if (msg.equipe || primeiroAqui) {
      if (await handleCommand(msg, suggestionGroup)) return;
    }
  }
  // O grupo de sugestões nunca é analisado
  if (msg.chatJid === suggestionGroup) return;

  const chat = await garantirChat(msg);
  if (!chat) return;

  // Condomínio da conversa
  let condoKey = chat.condo_key;
  if (chat.kind === 'privado' && !condoKey) {
    condoKey = await contactCondo([msg.chatJid, msg.authorJid, msg.authorAlt]);
    if (condoKey) {
      // grava o vínculo no privado, com o nome do condomínio
      const ref = (await chatsOfCondo(condoKey)).find((c) => c.kind !== 'privado');
      await upsertChat({ jid: msg.chatJid, kind: 'privado', condo_key: condoKey, condo_name: ref?.condo_name });
      Object.assign(chat, { condo_key: condoKey, condo_name: ref?.condo_name || chat.condo_name });
    }
  }
  const ok = await permitido(chat, condoKey);
  console.log(`[recebida] ${chat.kind} "${chat.name || msg.chatJid}" condo=${condoKey || '-'} equipe=${msg.equipe} ${ok ? 'MONITORADO' : 'ignorado'}: ${msg.text.slice(0, 60).replace(/\n/g, ' ')}`);
  if (!ok) return; // fora do teste / ignorado: nem grava

  if (msg.audio) {
    try {
      const midia = msg.base64 ? { base64: msg.base64, mimetype: msg.audio.mimetype } : await getMediaBase64(msg.key);
      if (!midia?.base64) throw new Error('áudio sem conteúdo');
      const texto = await transcrever(midia.base64, midia.mimetype || msg.audio.mimetype);
      if (texto) msg.text = `🎤 (áudio) ${texto}`;
      console.log(`[áudio] transcrito (${msg.audio.segundos}s): ${msg.text.slice(0, 80)}`);
    } catch (e) {
      console.error('[áudio] falha na transcrição:', e.message);
    }
  }

  const nova = await saveMessage({ ...msg, fromMe: msg.equipe, kind: chat.kind });
  if (!nova) return; // duplicada

  // Quem fala no grupo de moradores fica ligado àquele condomínio (serve para os privados)
  if (chat.kind === 'moradores' && !msg.equipe) {
    await linkContact(msg.authorJid, msg.authorName, condoKey);
    await linkContact(msg.authorAlt, msg.authorName, condoKey);
  }

  if (msg.equipe) {
    // A equipe respondeu: fecha a pendência citada, ou todas da conversa privada
    if (msg.quotedId) await resolveById(msg.quotedId);
    if (chat.kind === 'privado') await resolveChat(msg.chatJid);
    cancelarAnalise(msg.chatJid, chat.kind === 'privado');
    return;
  }

  agendarAnalise(msg, { ...chat, condo_key: condoKey });
  console.log(`[fila] "${chat.name}" análise em ${config.debounceSeconds}s`);
}

async function garantirChat(msg) {
  let chat = await getChat(msg.chatJid);
  if (msg.isGroup) {
    if (!chat) {
      const name = await fetchGroupName(msg.chatJid);
      const existentes = (await listCondos()).map((c) => ({ condo_key: c.condo_key, condo_name: c.condo_name }));
      await upsertChat({ jid: msg.chatJid, name, ...unificar(classifyGroup(name), existentes) });
      chat = await getChat(msg.chatJid);
    }
  } else if (!chat || (!msg.equipe && msg.authorName && chat.name !== msg.authorName)) {
    await upsertChat({ jid: msg.chatJid, name: msg.equipe ? null : msg.authorName, kind: 'privado' });
    chat = await getChat(msg.chatJid);
  }
  return chat;
}

async function permitido(chat, condoKey) {
  if (chat.kind === 'outro' || !condoKey) return false; // grupos fora do padrão e privados sem vínculo
  const ignorados = await getList('ignored_condos');
  if (ignorados.includes(condoKey)) return false;
  if ((await getMode()) === 'teste') {
    const teste = await getList('test_condos');
    return teste.includes(condoKey);
  }
  return true;
}

// ---------- análise com espera (debounce) ----------
// Espera a pessoa parar de escrever e analisa a sequência de mensagens de uma vez.
const pendentesPorChat = new Map(); // chatJid -> { timer, msgs, chat }

function agendarAnalise(msg, chat) {
  const atual = pendentesPorChat.get(msg.chatJid) || { msgs: [], chat };
  clearTimeout(atual.timer);
  atual.msgs.push(msg);
  atual.chat = chat;
  atual.timer = setTimeout(() => {
    pendentesPorChat.delete(msg.chatJid);
    executarAnalise(atual.chat, atual.msgs).catch((e) => console.error('[análise]', e.message));
  }, config.debounceSeconds * 1000);
  pendentesPorChat.set(msg.chatJid, atual);
}

function cancelarAnalise(chatJid, cancelar) {
  // No privado, se você já respondeu antes da análise, não precisa notificar
  if (!cancelar) return;
  const atual = pendentesPorChat.get(chatJid);
  if (atual) { clearTimeout(atual.timer); pendentesPorChat.delete(chatJid); }
}

export async function executarAnalise(chat, msgs) {
  const ids = new Set(msgs.map((m) => m.id));
  const todas = await recentMessages(chat.jid, config.contextMessages + msgs.length);
  const novas = todas.filter((m) => ids.has(m.id));
  if (!novas.length) return;
  const ultimaTs = new Date(novas[novas.length - 1].ts).getTime();

  // Se você já respondeu depois da última mensagem, não notifica
  if (todas.some((m) => m.from_me && new Date(m.ts).getTime() > ultimaTs)) {
    console.log(`[análise] "${chat.name}" → equipe já respondeu, sem aviso`);
    return;
  }

  const historico = todas.filter((m) => !ids.has(m.id) && new Date(m.ts).getTime() <= ultimaTs);

  let interno = [];
  if (chat.condo_key && ['moradores', 'privado'].includes(chat.kind)) {
    const internos = (await chatsOfCondo(chat.condo_key)).filter((c) => ['sindico', 'conselho'].includes(c.kind));
    interno = await messagesSince(internos.map((c) => c.jid), config.internalDays * 24, config.internalMessages);
  }

  const a = await analisar({ chat, historico, novas, interno });
  console.log(`[análise] "${chat.name}" → ${a?.precisa_atencao ? 'AVISAR' : 'não precisa'} (${a?.categoria || '-'}, ${a?.urgencia || '-'}) ${a?.resumo || ''}`);
  if (!a?.precisa_atencao) return;

  await markPending([...ids], a.resumo || null);
  await notificar(chat, novas, a);
}

const ICONE = { alta: '🔴', media: '🟡', baixa: '🟢' };
const ORIGEM = { moradores: '👥 Moradores', sindico: '🧑‍💼 Síndico', conselho: '📊 Conselho', privado: '💬 Privado' };

async function notificar(chat, novas, a) {
  const hora = new Date(novas[0].ts).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const autor = novas[0].author_name || chat.name || 'Participante';
  const textos = novas.map((m) => m.text).join('\n');
  const condo = chat.condo_name || chat.condo_key || '';

  const cabecalho =
    `${ICONE[a.urgencia] || '⚪'} *${condo}*\n` +
    `${ORIGEM[chat.kind] || ''}${chat.kind === 'privado' ? ` com ${chat.name || 'contato'}` : ''} · ${a.categoria || 'outro'}\n\n` +
    `👤 *${autor}* (${hora}):\n${truncate(textos, 600)}\n\n` +
    `📝 ${a.resumo || ''}` +
    (a.nota_interna ? `\n\n🔎 _${a.nota_interna}_` : '') +
    (a.sugestao ? '\n\n💬 Sugestão na próxima mensagem 👇' : '');

  await sendToSuggestionGroup(cabecalho);
  if (a.sugestao) await sendToSuggestionGroup(await formatarSugestao(a.sugestao, chat.condo_key)); // separada para copiar fácil
}
