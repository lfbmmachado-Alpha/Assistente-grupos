import { config } from './config.js';
import { pool, setSetting, upsertChat, listCondos, listPending, resolveById, stats, getChat } from './db.js';
import { fetchAllGroups, getMediaBase64 } from './evolution.js';
import { lerDocumento } from './gemini.js';
import {
  aprender, fatosDo, adicionarFato, removerFato, docsDo, salvarDocumento, removerDocumento, listarDocumentos, contarExemplos,
} from './knowledge.js';
import { classifyGroup, normalize, unificar } from './groups.js';
import { getMode, getList, sendToSuggestionGroup, truncate, registrarAdmin, getAssinaturas } from './util.js';

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
!assinatura — quem assina as sugestões de cada condomínio

*Conhecimento*
!base Nome — o que a IA já sabe do condomínio
!fato Nome: texto — ensina um fato à mão
!esquecer N — apaga o fato N da última !base
!aprender — atualiza a base agora (roda sozinho a cada 3h)
!doc Nome Título — na legenda de um PDF (regimento, convenção…)
!docs — documentos cadastrados (!doc remover N)
!exemplos — respostas da equipe já aprendidas

*Ajustes*
!outros [nome] — grupos que não seguiram o padrão de nome
!vincular N moradores|sindico|conselho Nome — classifica um grupo de !outros
!ignorar Nome / !ativar Nome — para ou volta a monitorar um condomínio`;

let ultimaListaPendentes = [];
let ultimaListaOutros = [];
let ultimaListaFatos = [];
let ultimaListaDocs = [];

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
      const grupos = (await fetchAllGroups()).filter((g) => g.jid !== suggestionGroup);
      const cont = { moradores: 0, sindico: 0, conselho: 0, outro: 0 };
      const trocas = new Map(); // chave antiga -> chave nova

      // 1º moradores (eles dão o nome do condomínio), depois síndico/conselho se ligam a eles
      const itens = [];
      for (const g of grupos) {
        const atual = await getChat(g.jid);
        const cls = atual?.manual
          ? { kind: atual.kind, condo_key: atual.condo_key, condo_name: atual.condo_name }
          : classifyGroup(g.name);
        itens.push({ g, atual, cls });
      }
      const ordem = { moradores: 0, sindico: 1, conselho: 1, outro: 2 };
      itens.sort((a, b) => ordem[a.cls.kind] - ordem[b.cls.kind]);

      const conhecidos = [];
      for (const { g, atual, cls: base } of itens) {
        const cls = atual?.manual ? base : unificar(base, conhecidos);
        if (cls.condo_key && !conhecidos.some((c) => c.condo_key === cls.condo_key)) conhecidos.push(cls);
        if (atual?.condo_key && cls.condo_key && atual.condo_key !== cls.condo_key) trocas.set(atual.condo_key, cls.condo_key);
        await upsertChat({ jid: g.jid, name: g.name, ...cls });
        if (cls.condo_name) await pool.query('UPDATE chats SET condo_name = $2 WHERE jid = $1', [g.jid, cls.condo_name]);
        cont[cls.kind] = (cont[cls.kind] || 0) + 1;
      }

      // Mantém a lista de teste e de ignorados quando a chave de um condomínio muda
      for (const chave of ['test_condos', 'ignored_condos']) {
        const lista = await getList(chave);
        const nova = [...new Set(lista.map((k) => trocas.get(k) || k))];
        if (JSON.stringify(nova) !== JSON.stringify(lista)) await setSetting(chave, JSON.stringify(nova));
      }
      // Privados já ligados a uma chave antiga
      for (const [de, para] of trocas) {
        await pool.query('UPDATE contacts SET condo_key = $2 WHERE condo_key = $1', [de, para]);
        await pool.query(`UPDATE chats SET condo_key = $2 WHERE condo_key = $1 AND kind = 'privado'`, [de, para]);
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

    case 'assinatura':
    case 'assinaturas': {
      const ass = await getAssinaturas();
      const alvo = normalize(args[0] || '');
      const nome = args.slice(1).join(' ').trim();
      if (alvo && nome) {
        if (alvo === 'padrao') {
          ass.padrao = nome;
          await setSetting('assinaturas', JSON.stringify(ass));
          await reply(`✍️ Assinatura padrão: *${nome}*`);
          return true;
        }
        const r = await acharCondo(args[0]);
        if (r.erro) { await reply(r.erro + '\n\nUse: !assinatura NomeDoCondominio NomeDaPessoa'); return true; }
        if (normalize(nome) === 'remover') delete ass[r.condo.condo_key];
        else ass[r.condo.condo_key] = nome;
        await setSetting('assinaturas', JSON.stringify(ass));
        await reply(normalize(nome) === 'remover' ? `➖ ${r.condo.condo_name} volta a usar a assinatura padrão` : `✍️ ${r.condo.condo_name}: *${nome}*`);
        return true;
      }
      const condos = await listCondos();
      const linhas = condos.map((c) => `• ${c.condo_name}: ${ass[c.condo_key] || `_${ass.padrao || 'sem nome'}_ (padrão)`}`);
      await reply(
        `✍️ *Assinaturas*\nPadrão: ${ass.padrao || '(nenhuma, sai só "Alpha Administradora")'}\n\n${linhas.join('\n')}\n\n` +
        `Para mudar:\n!assinatura padrao Luiz\n!assinatura cristiana Ygor\n!assinatura cristiana remover`
      );
      return true;
    }

    case 'base': {
      if (!resto) { await reply('Use: !base NomeDoCondominio'); return true; }
      const r = await acharCondo(resto);
      if (r.erro) { await reply(r.erro); return true; }
      ultimaListaFatos = await fatosDo(r.condo.condo_key);
      const docs = await docsDo(r.condo.condo_key);
      if (!ultimaListaFatos.length && !docs.length) {
        await reply(`🧠 *${r.condo.condo_name}*\nAinda não aprendi nada. A base cresce sozinha com as conversas (a cada 3h) ou com !fato ${r.condo.condo_key}: texto`);
        return true;
      }
      const linhas = ultimaListaFatos.map((f, i) => `${i + 1}. ${f.fato}${f.fonte === 'manual' ? ' ✍️' : ''}`);
      await reply(
        `🧠 *${r.condo.condo_name}* (${ultimaListaFatos.length} fatos)\n\n${linhas.join('\n')}` +
        (docs.length ? `\n\n📄 Documentos: ${docs.map((d) => d.titulo).join(', ')}` : '') +
        `\n\nPara apagar: !esquecer N · ✍️ = cadastrado à mão`
      );
      return true;
    }

    case 'fato': {
      const [nome, ...textoParts] = resto.split(':');
      const texto = textoParts.join(':').trim();
      if (!nome || !texto) { await reply('Use: !fato NomeDoCondominio: texto do fato\nEx.: !fato cristiana: A dedetização é feita toda primeira quinta do mês.'); return true; }
      const r = await acharCondo(nome);
      if (r.erro) { await reply(r.erro); return true; }
      await adicionarFato(r.condo.condo_key, texto, 'manual');
      await reply(`✍️ Anotado em *${r.condo.condo_name}*: ${texto}`);
      return true;
    }

    case 'esquecer': {
      const f = ultimaListaFatos[Number(args[0]) - 1];
      if (!f) { await reply('Use !base Nome primeiro e depois !esquecer N.'); return true; }
      await removerFato(f.id);
      await reply(`🗑️ Esquecido: ${f.fato}`);
      return true;
    }

    case 'aprender': {
      await reply('🧠 Lendo as conversas novas…');
      const r = await aprender({ forcar: true });
      if (r.ocupado) { await reply('Já estou aprendendo neste momento. Tente em alguns minutos.'); return true; }
      await reply(`🧠 Pronto: ${r.condominios} condomínio(s) revisado(s)\n➕ ${r.novos} fatos novos · ✏️ ${r.atualizados} atualizados · 🗑️ ${r.removidos} removidos\n\nVeja com !base Nome`);
      return true;
    }

    case 'doc': {
      if (normalize(args[0] || '') === 'remover') {
        const d = ultimaListaDocs[Number(args[1]) - 1];
        if (!d) { await reply('Use !docs primeiro e depois !doc remover N.'); return true; }
        await removerDocumento(d.id);
        await reply(`🗑️ Documento removido: ${d.titulo}`);
        return true;
      }
      if (!msg.documento) {
        await reply('Envie o PDF aqui no grupo e escreva na *legenda*: !doc NomeDoCondominio Título\nEx.: !doc cristiana Regimento Interno');
        return true;
      }
      // nome do condomínio = primeira palavra; título = o resto (ou o nome do arquivo)
      const r = await acharCondo(args[0] || '');
      if (r.erro) { await reply(r.erro + '\n\nNa legenda: !doc NomeDoCondominio Título'); return true; }
      const titulo = args.slice(1).join(' ').trim() || msg.documento.nome || 'Documento';
      await reply(`📄 Lendo "${titulo}" de ${r.condo.condo_name}… pode levar 1 ou 2 minutos.`);
      try {
        const midia = await getMediaBase64(msg.key);
        if (!midia?.base64) throw new Error('não consegui baixar o arquivo');
        const texto = await lerDocumento(midia.base64, midia.mimetype || msg.documento.mimetype);
        if (!texto || texto.length < 200) throw new Error('não consegui extrair o texto (o PDF pode ser uma imagem de baixa qualidade)');
        await salvarDocumento(r.condo.condo_key, titulo, texto);
        await reply(`✅ "${titulo}" salvo em *${r.condo.condo_name}* (${texto.length >= 1000 ? `${Math.round(texto.length / 1000)} mil` : texto.length} caracteres).\nAs próximas sugestões desse condomínio vão consultar o documento.`);
      } catch (e) {
        console.error('[documento]', e.message);
        await reply(`❌ Não consegui ler o documento: ${e.message}`);
      }
      return true;
    }

    case 'docs': {
      ultimaListaDocs = await listarDocumentos();
      if (!ultimaListaDocs.length) { await reply('Nenhum documento ainda. Envie um PDF com a legenda: !doc NomeDoCondominio Título'); return true; }
      const condos = await listCondos();
      const nomeDe = (k) => condos.find((c) => c.condo_key === k)?.condo_name || k;
      await reply(`📄 *Documentos*\n${ultimaListaDocs.map((d, i) => `${i + 1}. ${nomeDe(d.condo_key)}: ${d.titulo} (${d.tamanho >= 1000 ? `${Math.round(d.tamanho / 1000)} mil` : d.tamanho} car.)`).join('\n')}\n\nPara remover: !doc remover N`);
      return true;
    }

    case 'exemplos': {
      const c = await contarExemplos();
      const condos = await listCondos();
      const nomeDe = (k) => condos.find((x) => x.condo_key === k)?.condo_name || k || '?';
      const total = c.reduce((s, x) => s + x.n, 0);
      await reply(total
        ? `🎓 *Respostas da equipe aprendidas: ${total}*\n${c.map((x) => `• ${nomeDe(x.condo_key)}: ${x.n}`).join('\n')}\n\nCada vez que a equipe responde um pedido (de preferência citando a mensagem), vira exemplo.`
        : '🎓 Nenhuma resposta aprendida ainda. Quando a equipe responder um pedido nos grupos (de preferência citando a mensagem), ela vira exemplo.');
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
