import { config } from './config.js';
import { pool, setSetting, upsertChat, listCondos, listPending, resolveById, stats, getChat } from './db.js';
import { fetchAllGroups } from './evolution.js';
import { classifyGroup, normalize } from './groups.js';
import { getMode, getList, sendToSuggestionGroup, truncate, registrarAdmin } from './util.js';

const ICONES = { moradores: '👥', sindico: '🧑‍💼', conselho: '📊' };

const AJUDA = `🤖 *Comandos* (só neste grupo)

*Começo*
!sincronizar — importa os nomes de todos os seus grupos
!condominios [nome] — lista condomínios encontrados
!teste — mostra o modo e os condomínios em teste
!teste incluir Nome — coloca um condomínio no teste
!teste remover Nome — tira do teste
!modo teste | !modo producao

*Dia a dia*
!pendentes — o que está sem resposta
!ok N — marca a pendência N como resolvida (!ok todos)
!status — resumo do sistema

*Ajustes*
!outros [nome] — grupos que não seguiram o padrão de nome
!vincular N moradores|sindico|conselho Nome — classifica um grupo de !outros
!ignorar Nome / !ativar Nome — para ou volta a monitorar um condomínio`;

let ultimaListaPendentes = [];
let ultimaListaOutros = [];

export async function handleCommand(msg, suggestionGroup) {
  const texto = msg.text.trim();
  const [rawCmd, ...args] = texto.split(/\s+/);
  const cmd = normalize(rawCmd.replace('!', ''));
  const resto = args.join(' ');

  if (cmd === 'aqui') {
    if (!msg.isGroup) return false;
    if (!msg.fromMe) await registrarAdmin(msg); // quem envia o !aqui vira administrador
    await setSetting('suggestion_group', msg.chatJid);
    const modo = await getMode();
    await sendToSuggestionGroup(
      '✅ Este grupo agora recebe as análises e sugestões.\n' +
      (modo === 'teste' ? '🧪 Modo teste: nada é analisado até você incluir condomínios.\n' : '') +
      '\nPróximo passo: envie *!sincronizar*\n\n' + AJUDA
    );
    return true;
  }

  // Os demais comandos só funcionam dentro do grupo de sugestões
  if (!suggestionGroup || msg.chatJid !== suggestionGroup) return false;
  const reply = (t) => sendToSuggestionGroup(t);

  switch (cmd) {
    case 'ajuda':
    case 'help':
      await reply(AJUDA);
      return true;

    case 'sincronizar': {
      await reply('🔄 Lendo seus grupos…');
      const grupos = await fetchAllGroups();
      const cont = { moradores: 0, sindico: 0, conselho: 0, outro: 0 };
      for (const g of grupos) {
        if (g.jid === suggestionGroup) continue;
        const atual = await getChat(g.jid);
        // não sobrescreve um grupo que você vinculou à mão
        const cls = atual?.manual
          ? { kind: atual.kind, condo_key: atual.condo_key, condo_name: atual.condo_name }
          : classifyGroup(g.name);
        await upsertChat({ jid: g.jid, name: g.name, ...cls });
        cont[cls.kind] = (cont[cls.kind] || 0) + 1;
      }
      const condos = await listCondos();
      await reply(
        `✅ ${grupos.length} grupos lidos\n` +
        `👥 Moradores: ${cont.moradores}\n🧑‍💼 Síndico: ${cont.sindico}\n📊 Conselho: ${cont.conselho}\n` +
        `❔ Fora do padrão: ${cont.outro} (veja com !outros)\n\n` +
        `🏢 ${condos.length} condomínios identificados.\n` +
        `Próximo passo: *!condominios nome* para achar um e *!teste incluir nome* para testar.`
      );
      return true;
    }

    case 'condominios':
    case 'condominio': {
      const filtro = normalize(resto);
      const condos = (await listCondos()).filter((c) => !filtro || c.condo_key.includes(filtro));
      if (!condos.length) { await reply(filtro ? `Nenhum condomínio com "${resto}".` : 'Nenhum condomínio ainda. Envie !sincronizar.'); return true; }
      const teste = await getList('test_condos');
      const ign = await getList('ignored_condos');
      const linhas = condos.slice(0, 60).map((c) =>
        `• ${c.condo_name} ${c.kinds.map((k) => ICONES[k] || '').join('')}` +
        (teste.includes(c.condo_key) ? ' 🧪' : '') + (ign.includes(c.condo_key) ? ' 🔕' : ''));
      await reply(`🏢 *Condomínios (${condos.length})*\n${linhas.join('\n')}` + (condos.length > 60 ? '\n…use um filtro para ver mais' : ''));
      return true;
    }

    case 'teste': {
      let lista = await getList('test_condos');
      const sub = normalize(args[0] || '');
      if (sub === 'incluir' || sub === 'remover') {
        const nome = args.slice(1).join(' ');
        const r = await acharCondo(nome);
        if (r.erro) { await reply(r.erro); return true; }
        lista = sub === 'incluir' ? [...new Set([...lista, r.condo.condo_key])] : lista.filter((k) => k !== r.condo.condo_key);
        await setSetting('test_condos', JSON.stringify(lista));
        await reply(`${sub === 'incluir' ? '🧪 Incluído' : '➖ Removido'}: ${r.condo.condo_name}`);
      }
      const modo = await getMode();
      const condos = await listCondos();
      const linhas = lista.map((k) => {
        const c = condos.find((x) => x.condo_key === k);
        return c ? `• ${c.condo_name} ${c.kinds.map((t) => ICONES[t] || '').join('')}` : `• ${k}`;
      });
      await reply(
        `${modo === 'teste' ? '🧪 *Modo teste*' : '🚀 *Modo produção* (todos os condomínios; a lista abaixo não está em uso)'}\n\n` +
        (linhas.length ? `Condomínios em teste:\n${linhas.join('\n')}` : 'Nenhum condomínio em teste. Use !teste incluir Nome.')
      );
      return true;
    }

    case 'modo': {
      const m = normalize(args[0] || '');
      if (!['teste', 'producao'].includes(m)) { await reply(`Modo atual: *${await getMode()}*. Use !modo teste ou !modo producao.`); return true; }
      await setSetting('mode', m);
      await reply(m === 'teste' ? '🧪 Modo teste: só os condomínios da lista.' : '🚀 Modo produção: todos os condomínios (exceto os ignorados).');
      return true;
    }

    case 'pendentes': {
      const rows = await listPending(config.pendingHours);
      // agrupa por conversa (várias mensagens seguidas viram uma pendência)
      const vistos = new Map();
      for (const r of rows) {
        const chave = `${r.chat_jid}|${r.summary || r.id}`;
        if (!vistos.has(chave)) vistos.set(chave, { ...r, ids: [r.id] });
        else vistos.get(chave).ids.push(r.id);
      }
      ultimaListaPendentes = [...vistos.values()];
      if (!ultimaListaPendentes.length) { await reply(`✅ Nenhuma pendência nas últimas ${config.pendingHours}h.`); return true; }
      let out = `📋 *Pendentes (${ultimaListaPendentes.length})*\n`;
      let ultimo = null;
      ultimaListaPendentes.forEach((r, i) => {
        const condo = r.condo_name || r.chat_name || '';
        if (condo !== ultimo) { out += `\n*${condo}*\n`; ultimo = condo; }
        const hora = new Date(r.ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const onde = r.chat_kind === 'privado' ? '💬' : ICONES[r.chat_kind] || '';
        out += `${i + 1}. ${onde} ${hora} ${r.author_name || ''}: ${r.summary || truncate(r.text, 80)}\n`;
      });
      await reply(out + '\nPara fechar: !ok N');
      return true;
    }

    case 'ok': {
      const alvo = normalize(args[0] || '');
      const itens = alvo === 'todos' ? ultimaListaPendentes : [ultimaListaPendentes[Number(alvo) - 1]].filter(Boolean);
      if (!itens.length) { await reply('Use !pendentes primeiro e depois !ok N (ou !ok todos).'); return true; }
      for (const it of itens) for (const id of it.ids) await resolveById(id);
      await reply(`✅ ${itens.length} pendência(s) marcada(s) como resolvida(s).`);
      return true;
    }

    case 'status': {
      const s = await stats();
      const teste = await getList('test_condos');
      await reply(
        `📊 *Status*\nModo: ${await getMode()}${(await getMode()) === 'teste' ? ` (${teste.length} condomínios)` : ''}\n` +
        `Grupos conhecidos: ${s.grupos}\nMensagens nas últimas 24h: ${s.msgs_24h}\nPendências abertas: ${s.pendentes}`
      );
      return true;
    }

    case 'outros': {
      const filtro = normalize(resto);
      const r = await pool.query(`SELECT jid, name FROM chats WHERE kind = 'outro' ORDER BY name`);
      ultimaListaOutros = r.rows.filter((g) => !filtro || normalize(g.name).includes(filtro));
      if (!ultimaListaOutros.length) { await reply('Nenhum grupo fora do padrão' + (filtro ? ` com "${resto}".` : '.')); return true; }
      const linhas = ultimaListaOutros.slice(0, 80).map((g, i) => `${i + 1}. ${g.name || g.jid}`);
      await reply(`❔ *Grupos fora do padrão*\n${linhas.join('\n')}\n\nPara classificar: !vincular N moradores Nome do condomínio`);
      return true;
    }

    case 'vincular': {
      const g = ultimaListaOutros[Number(args[0]) - 1];
      const tipo = normalize(args[1] || '');
      const nome = args.slice(2).join(' ').trim();
      if (!g || !['moradores', 'sindico', 'conselho'].includes(tipo) || !nome) {
        await reply('Use: !vincular N moradores|sindico|conselho Nome do condomínio\n(N vem da lista do !outros)');
        return true;
      }
      // usa a chave de um condomínio existente se o nome bater
      const r = await acharCondo(nome);
      const condo_key = r.condo?.condo_key || classifyGroup(`Condominio ${nome}`).condo_key;
      const condo_name = r.condo?.condo_name || nome;
      await pool.query(`UPDATE chats SET kind = $2, condo_key = $3, condo_name = $4, manual = TRUE WHERE jid = $1`, [g.jid, tipo, condo_key, condo_name]);
      await reply(`🔗 "${g.name}" agora é ${ICONES[tipo]} ${tipo} de *${condo_name}*`);
      return true;
    }

    case 'ignorar':
    case 'ativar': {
      const r = await acharCondo(resto);
      if (r.erro) { await reply(r.erro); return true; }
      let ign = await getList('ignored_condos');
      ign = cmd === 'ignorar' ? [...new Set([...ign, r.condo.condo_key])] : ign.filter((k) => k !== r.condo.condo_key);
      await setSetting('ignored_condos', JSON.stringify(ign));
      await reply(`${cmd === 'ignorar' ? '🔕 Ignorando' : '✅ Monitorando'}: ${r.condo.condo_name}`);
      return true;
    }

    default:
      await reply(`Comando não reconhecido. Envie *!ajuda*.`);
      return true;
  }
}

async function acharCondo(nome) {
  const termo = normalize(nome);
  if (!termo) return { erro: 'Faltou o nome do condomínio.' };
  const condos = await listCondos();
  const exato = condos.find((c) => c.condo_key === termo || normalize(c.condo_name) === termo);
  if (exato) return { condo: exato };
  const parciais = condos.filter((c) => c.condo_key.includes(termo));
  if (parciais.length === 1) return { condo: parciais[0] };
  if (parciais.length > 1) {
    return { erro: `Encontrei mais de um:\n${parciais.slice(0, 15).map((c) => `• ${c.condo_name}`).join('\n')}\n\nEscreva o nome mais completo.` };
  }
  return { erro: `Não encontrei "${nome}". Confira com !condominios ou rode !sincronizar.` };
}
