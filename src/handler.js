import { config } from './config.js';
import { parseMessage } from './parser.js';
import { analyze } from './analyzer.js';
import { KINDS, KIND_LABEL, normalize, condoFromName } from './classifier.js';
import { sendToSuggestionGroup, getGroupName, fetchAllGroups } from './evolution.js';
import {
  getSetting, setSetting, getChat, upsertGroupChat, upsertPrivateChat, listChats, listCondos,
  setChatCondo, setChatKind, setChatEnabled, inferCondo,
  saveMessage, getHistory, getRelated, saveAnalysis, isAnswered, markAnswered, listPending,
} from './db.js';

// Quais outros grupos do mesmo condomínio entram como contexto, e de quantos dias
const RELATED = {
  moradores: { kinds: ['sindico', 'conselho'], days: 30 },
  sindico: { kinds: ['moradores', 'conselho'], days: 14 },
  conselho: { kinds: ['moradores', 'sindico'], days: 14 },
  privado: { kinds: ['moradores'], days: 14 },
  outro: { kinds: [], days: 0 },
};

// ---------- fila simples para limitar chamadas simultâneas ao Gemini ----------
let running = 0;
const queue = [];
function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (running < config.maxConcurrent && queue.length) {
    const { fn, resolve, reject } = queue.shift();
    running++;
    fn().then(resolve, reject).finally(() => { running--; pump(); });
  }
}

// ---------- entrada do webhook ----------
export async function handleWebhook(body) {
  const event = String(body?.event || '').toLowerCase().replace(/_/g, '.');
  const items = Array.isArray(body?.data) ? body.data : [body?.data];

  // Grupo criado/renomeado → reclassifica pelo novo nome
  if (event.startsWith('group')) {
    for (const g of items) {
      if (g?.id?.endsWith('@g.us') && g.subject) await upsertGroupChat(g.id, g.subject).catch(() => {});
    }
    return;
  }

  if (event !== 'messages.upsert') return;

  for (const data of items) {
    const msg = parseMessage(data);
    if (!msg) continue;
    try {
      await handleMessage(msg);
    } catch (err) {
      console.error('[mensagem]', msg.chatJid, msg.id, err.message);
    }
  }
}

async function handleMessage(msg) {
  const suggestionGroup = await getSetting('suggestion_group');

  // Comandos: só seus, só em grupo
  if (msg.isGroup && msg.fromMe && msg.text.startsWith('!')) {
    if (await handleCommand(msg, suggestionGroup)) return;
  }

  // O grupo de sugestões nunca é analisado (evita loop)
  if (msg.chatJid === suggestionGroup) return;

  const chat = await ensureChat(msg);
  if (!chat.enabled || !msg.text) return;
  if (!(await isAllowed(chat))) return; // modo teste: só condomínios da lista

  if (!(await saveMessage(msg))) return; // duplicada

  // Suas mensagens viram histórico (como você responde) e fecham pendências
  if (msg.fromMe) {
    await markAnswered(msg.chatJid, msg.ts, msg.quotedId);
    return;
  }

  if (msg.text.length < config.minChars) return;

  enqueue(() => analyzeAndNotify(msg)).catch((err) =>
    console.error('[análise]', msg.chatJid, msg.id, err.message)
  );
}

async function ensureChat(msg) {
  let chat = await getChat(msg.chatJid);
  if (msg.isGroup) {
    if (!chat) {
      const name = await getGroupName(msg.chatJid).catch(() => null);
      chat = await upsertGroupChat(msg.chatJid, name);
    }
  } else {
    if (!chat || (msg.authorName && chat.name !== msg.authorName) || (msg.chatJidAlt && !chat.jid_alt)) {
      chat = await upsertPrivateChat(msg.chatJid, msg.chatJidAlt, msg.authorName);
    }
    // Descobre o condomínio pelo grupo de moradores onde a pessoa escreve
    if (!chat.manual) {
      const found = await inferCondo([chat.jid, chat.jid_alt].filter(Boolean));
      if (found && found.condo_key !== chat.condo_key) {
        await setChatCondo(chat.jid, found.condo_key, found.condo_name, false);
        chat = { ...chat, ...found };
      }
    }
  }
  return chat;
}

// ---------- modo teste ----------
async function getMode() {
  return (await getSetting('mode')) || config.defaultMode;
}

async function getTestCondos() {
  try { return JSON.parse((await getSetting('test_condos')) || '[]'); } catch { return []; }
}

async function isAllowed(chat) {
  if ((await getMode()) !== 'teste') return true;
  return !!chat.condo_key && (await getTestCondos()).includes(chat.condo_key);
}

/** Acha um condomínio pelo nome (exato ou parcial). Retorna {condo} ou {options}. */
async function findCondo(text) {
  const key = condoFromName(text).condoKey;
  if (!key) return {};
  const condos = await listCondos();
  const exact = condos.find((c) => c.condo_key === key);
  if (exact) return { condo: exact };
  const partial = condos.filter((c) => c.condo_key.includes(key));
  return partial.length === 1 ? { condo: partial[0] } : { options: partial };
}

async function analyzeAndNotify(msg) {
  const chat = await getChat(msg.chatJid);

  const rel = RELATED[chat.kind] || RELATED.outro;
  const [history, related] = await Promise.all([
    getHistory(chat.jid, msg.ts, config.contextSize),
    getRelated(chat.condo_key, chat.jid, rel.kinds, msg.ts, rel.days, config.crossContextSize),
  ]);

  const a = await analyze({ chat, history, related, message: msg });
  await saveAnalysis(chat.jid, msg.id, a);

  if (!a.precisa_resposta && a.urgencia !== 'alta') return;
  if (await isAnswered(chat.jid, msg.id)) return; // você respondeu enquanto a IA analisava

  const icon = { alta: '🔴', media: '🟡', baixa: '🟢' }[a.urgencia];
  const hora = msg.ts.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const titulo = chat.condo_name || chat.name || 'Sem nome';
  const origem = chat.kind === 'privado'
    ? `${KIND_LABEL.privado} com ${chat.name || 'contato'}`
    : `${KIND_LABEL[chat.kind]} · ${chat.name || ''}`;

  const header =
    `${icon} *${titulo}*\n` +
    `${origem}\n` +
    `${a.categoria} · urgência ${a.urgencia}\n\n` +
    `👤 *${msg.authorName || chat.name || 'Participante'}* (${hora}):\n${truncate(msg.text, 500)}\n\n` +
    `📝 ${a.resumo}` +
    (a.nota_interna ? `\n\n🔎 _${a.nota_interna}_` : '') +
    (a.sugestao ? '\n\n💬 Sugestão na próxima mensagem 👇' : '');

  await sendToSuggestionGroup(header);
  if (a.sugestao) await sendToSuggestionGroup(a.sugestao); // separada para facilitar copiar/encaminhar
}

// ---------- comandos (no grupo de sugestões) ----------
const AJUDA = `🤖 *Comandos*
!teste — mostra o modo e os condomínios em teste
!teste incluir Nome (ou N) — coloca um condomínio no teste
!teste remover Nome (ou N) — tira do teste
!modo teste | !modo producao — só a lista de teste, ou tudo
!pendentes — sem resposta nas últimas ${config.pendingHours}h
!sincronizar — importa e classifica todos os seus grupos
!condominios [filtro] — condomínios e seus grupos
!grupos [página | filtro | sem] — lista grupos numerados
!privados [página | filtro] — lista conversas privadas (p1, p2…)
!vincular N Nome do condomínio — liga o grupo/privado N a um condomínio
!tipo N moradores|sindico|conselho|outro — corrige o tipo
!ignorar N / !ativar N — para ou volta a monitorar (use pN para privados)
!aqui — define o grupo atual como grupo de sugestões`;

async function handleCommand(msg, suggestionGroup) {
  const [rawCmd, ...args] = msg.text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();

  if (cmd === '!aqui') {
    await setSetting('suggestion_group', msg.chatJid);
    const mode = await getMode();
    await sendToSuggestionGroup(
      '✅ Este grupo agora recebe as análises e sugestões.\n' +
      (mode === 'teste' ? '🧪 Você está no *modo teste*: nada é analisado até incluir condomínios com !teste incluir.\n' : '') +
      '\n' + AJUDA
    );
    return true;
  }

  // Os demais comandos só funcionam dentro do grupo de sugestões
  if (msg.chatJid !== suggestionGroup) return false;

  const reply = (t) => sendToSuggestionGroup(truncate(t, 3800));

  switch (cmd) {
    case '!ajuda':
      await reply(AJUDA);
      return true;

    case '!modo': {
      const m = normalize(args[0]);
      if (m !== 'teste' && m !== 'producao') { await reply('Uso: !modo teste | !modo producao'); return true; }
      await setSetting('mode', m);
      await reply(m === 'teste'
        ? '🧪 *Modo teste*: só os condomínios da lista são lidos e analisados. Veja com !teste.'
        : '🚀 *Modo produção*: todos os grupos e privados ativos são lidos e analisados.');
      return true;
    }

    case '!teste': {
      const sub = normalize(args[0]);
      let list = await getTestCondos();

      if (sub === 'incluir' || sub === 'remover') {
        const rest = args.slice(1).join(' ');
        let condo = null;
        const target = await resolveTarget(rest, suggestionGroup);
        if (target) {
          if (!target.condo_key) { await reply('Esse grupo não tem condomínio. Use !vincular antes.'); return true; }
          condo = { condo_key: target.condo_key, condo_name: target.condo_name };
        } else {
          const r = await findCondo(rest);
          if (r.options?.length) {
            await reply(`Encontrei mais de um:\n${r.options.slice(0, 15).map((c) => `• ${c.condo_name}`).join('\n')}\n\nSeja mais específico.`);
            return true;
          }
          condo = r.condo;
          if (!condo) { await reply(`Não encontrei "${rest}". Rode !sincronizar e confira com !condominios.`); return true; }
        }
        list = sub === 'incluir'
          ? [...new Set([...list, condo.condo_key])]
          : list.filter((k) => k !== condo.condo_key);
        await setSetting('test_condos', JSON.stringify(list));
        await reply(`${sub === 'incluir' ? '🧪 Incluído' : '➖ Removido'}: ${condo.condo_name}`);
      }

      const mode = await getMode();
      const condos = await listCondos();
      const icons = { moradores: '👥', sindico: '🧑‍💼', conselho: '📊' };
      const lines = list.map((k) => {
        const c = condos.find((x) => x.condo_key === k);
        return c ? `• ${c.condo_name} ${c.kinds.map((t) => icons[t] || '').join('')}` : `• ${k} ⚠️ sem grupos`;
      });
      await reply(
        `${mode === 'teste' ? '🧪 *Modo teste*' : '🚀 *Modo produção* (a lista abaixo não está sendo usada)'}\n\n` +
        (lines.length ? `Condomínios em teste:\n${lines.join('\n')}` : 'Nenhum condomínio em teste. Use !teste incluir Nome.')
      );
      return true;
    }

    case '!pendentes': {
      const rows = await listPending(config.pendingHours);
      if (!rows.length) { await reply('✅ Nenhuma pendência sem resposta.'); return true; }
      let out = `📋 *Pendentes (${rows.length})*\n`;
      let last = null;
      for (const r of rows) {
        const bloco = `${r.condo_name || r.chat_name || 'Sem nome'} · ${KIND_LABEL[r.kind]}`;
        if (bloco !== last) { out += `\n*${bloco}*\n`; last = bloco; }
        const hora = new Date(r.ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        out += `• ${hora} ${r.author_name || 'Participante'}: ${r.summary || truncate(r.text, 80)}\n`;
      }
      await reply(out);
      return true;
    }

    case '!sincronizar': {
      const groups = await fetchAllGroups();
      for (const g of groups) if (g.id !== suggestionGroup) await upsertGroupChat(g.id, g.subject || null);
      const all = (await listChats(true)).filter((c) => c.jid !== suggestionGroup);
      const semCondo = all.filter((c) => c.kind !== 'outro' && !c.condo_key).length;
      const count = (k) => all.filter((c) => c.kind === k).length;
      await reply(
        `🔄 ${all.length} grupos sincronizados\n` +
        `${KIND_LABEL.moradores}: ${count('moradores')}\n${KIND_LABEL.sindico}: ${count('sindico')}\n${KIND_LABEL.conselho}: ${count('conselho')}\n` +
        (semCondo ? `\n⚠️ ${semCondo} sem condomínio identificado — veja com *!grupos sem* e use *!vincular*.` : '') +
        `\n\nGrupos pessoais (família, amigos) aparecem como moradores: use *!tipo N outro* ou *!ignorar N*.`
      );
      return true;
    }

    case '!condominios': {
      const filtro = normalize(args.join(' '));
      const condos = (await listCondos()).filter((c) => !filtro || c.condo_key.includes(filtro));
      const icons = { moradores: '👥', sindico: '🧑‍💼', conselho: '📊' };
      const lines = condos.map((c) => `• ${c.condo_name} ${c.kinds.map((k) => icons[k] || '').join('')}`);
      await reply(lines.length ? `🏢 *Condomínios (${condos.length})*\n👥 moradores · 🧑‍💼 síndico · 📊 conselho\n\n${lines.join('\n')}` : 'Nenhum condomínio encontrado.');
      return true;
    }

    case '!grupos':
    case '!privados': {
      const isGroup = cmd === '!grupos';
      const prefix = isGroup ? '' : 'p';
      const rows = (await listChats(isGroup)).filter((c) => c.jid !== suggestionGroup).map((c, i) => ({ c, n: i + 1 }));
      const rest = args.join(' ');
      let page = 1;
      let filtered = rows;
      if (/^\d+$/.test(rest)) page = Number(rest);
      else if (rest.toLowerCase() === 'sem') filtered = rows.filter((r) => r.c.kind !== 'outro' && !r.c.condo_key);
      else if (rest) {
        const f = normalize(rest);
        filtered = rows.filter((r) => normalize(r.c.name).includes(f) || normalize(r.c.condo_name).includes(f));
      }
      const PAGE = 40;
      const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
      const slice = filtered.slice((page - 1) * PAGE, page * PAGE);
      const lines = slice.map(({ c, n }) =>
        `${prefix}${n}. ${c.enabled ? '✅' : '🔕'} ${KIND_LABEL[c.kind].split(' ')[0]} ${c.name || c.jid}` +
        (c.kind === 'outro' ? '' : c.condo_name ? ` → ${c.condo_name}` : ' ⚠️ sem condomínio')
      );
      await reply(
        lines.length
          ? `*${isGroup ? 'Grupos' : 'Privados'}* (${filtered.length}) · página ${page}/${pages}\n\n${lines.join('\n')}`
          : 'Nada encontrado.'
      );
      return true;
    }

    case '!vincular': {
      const target = await resolveTarget(args[0], suggestionGroup);
      const nome = args.slice(1).join(' ');
      if (!target || !nome) { await reply('Uso: !vincular N Nome do condomínio  (ex.: !vincular 12 Serra do Capivari)'); return true; }
      const { condoKey, condoName } = condoFromName(nome);
      // Reaproveita o nome já usado pelo grupo de moradores, se existir
      const existente = (await listCondos()).find((c) => c.condo_key === condoKey);
      await setChatCondo(target.jid, condoKey, existente?.condo_name || condoName, true);
      await reply(`🔗 ${target.name || target.jid} → ${existente?.condo_name || condoName}${existente ? '' : '\n(condomínio novo — confira o nome com !condominios)'}`);
      return true;
    }

    case '!tipo': {
      const target = await resolveTarget(args[0], suggestionGroup);
      const kind = normalize(args[1]);
      if (!target || !KINDS.includes(kind) || kind === 'privado') {
        await reply('Uso: !tipo N moradores|sindico|conselho|outro');
        return true;
      }
      await setChatKind(target.jid, kind);
      await reply(`✏️ ${target.name || target.jid} agora é ${KIND_LABEL[kind]}`);
      return true;
    }

    case '!ignorar':
    case '!ativar': {
      const target = await resolveTarget(args[0], suggestionGroup);
      if (!target) { await reply('Número inválido. Use !grupos ou !privados para ver a lista.'); return true; }
      const enabled = cmd === '!ativar';
      await setChatEnabled(target.jid, enabled);
      await reply(`${enabled ? '✅ Monitorando' : '🔕 Ignorando'}: ${target.name || target.jid}`);
      return true;
    }

    default:
      await reply('Comando não reconhecido.\n\n' + AJUDA);
      return true;
  }
}

/** "12" → 12º da lista de grupos; "p5" → 5º da lista de privados. */
async function resolveTarget(arg, suggestionGroup) {
  if (!arg || !/^p?\d+$/i.test(arg)) return null;
  const isPrivate = /^p/i.test(arg);
  const list = (await listChats(!isPrivate)).filter((c) => c.jid !== suggestionGroup);
  return list[Number(arg.replace(/^p/i, '')) - 1] || null;
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
