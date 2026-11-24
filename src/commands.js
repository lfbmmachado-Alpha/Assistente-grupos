import { config } from './config.js';
import { pool, setSetting, getSetting, upsertChat, listCondos, listPending, resolveById, stats, getChat } from './db.js';
import { fetchAllGroups, getMediaBase64 } from './evolution.js';
import { lerDocumento } from './gemini.js';
import {
  relatorio, historico, linhaVisita, removerVisita, lancarManual, listarCarteira, importarCarteira,
  enviarPlanilha, semana, dataHoraBR, definirApelido, reprocessarSemana, diagnostico, verificarSemana, semGrupo,
  removerDaCarteira, incluirNaCarteira, buscarNaCarteira, registrarSaida, compararLista, apagarVisitas, consolidarDuplicadas, recalcularSaidasEstimadas, listarEnvios, salvarEnvio, removerEnvio, enviarRelatorioVistoriador,
} from './visitas.js';
import { getVistoriadores } from './util.js';
import { perguntar, limparConversa } from './consulta.js';
import { saudeIA, usoHoje, custoEstimado } from './gemini.js';
import { perguntarNaoIdentificados, listarVinculos, corrigirVinculos, modelos } from './identificar.js';
import { revisarTudo, contarAssuntos } from './pendencias.js';
import { iniciarEstudo, importarHistorico, aprenderTudo, listarEstudos, liberar, alterarDias, resumoCondo } from './estudo.js';
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

*Estudo (condomínio novo aprende antes de sugerir)*
!estudar Nome [dias] — inclui, lê o que já foi conversado e estuda (padrão 7 dias)
!estudar novos — estuda todos os condomínios encontrados que ainda não estão no teste
!estudo — quem está estudando e o que já aprendeu
!estudo liberar Nome — encerra o estudo e libera as sugestões

*Conversar com a IA*
Escreva normalmente aqui, sem "!" — ex.: _qual condomínio está mais delicado?_
Citando um condomínio, ela foca nele — ex.: _como está o clima no Floresta?_
!nova conversa — esquece o assunto anterior

!perguntar Nome: sua pergunta — ex.: !perguntar torino: o que está pendente?
!resumo Nome — o que está acontecendo no condomínio (últimos 7 dias)

*Dia a dia*
!pendentes — o que está sem resposta
!ok N — marca a pendência N como resolvida (!ok todos)
!revisar — a IA revê todas as pendências e fecha as já respondidas
!status — resumo do sistema
!assinatura — quem assina as sugestões de cada condomínio

*Vistorias*
!vistorias — situação da semana ✅ ❌ ⚠️
!vistorias pendentes — só o que falta
!vistorias passada — semana anterior
!vistorias Nome — visitas de um condomínio
!vistorias exportar [mm/aaaa] — planilha Excel
!planilha — link para a planilha Google com todas as idas ([novo] troca o link)
!custos [ontem] — consumo do Gemini por tarefa (tokens e estimativa em US$)
!leituras — controle das leituras mensais (!leituras ajuda para os comandos)
!pendencias — fichas de pendências por responsável (!pendencias ajuda)
!enviar leituras Nathan [próxima semana|semana|hoje] — manda o alerta de leituras no grupo do responsável
!vistorias reler — relê as mensagens da semana (visita que não apareceu)
!vistorias diagnostico Nome — mostra por que um condomínio está sem vistoria
!vistorias sem grupo — condomínios do quadro sem grupo da IA e grupos fora do quadro
!vistorias comparar + lista colada — compara a lista da equipe com o que está registrado
!vistorias apagar Nome [dd/mm] — apaga ida registrada por engano (não volta na verificação)
!vistorias limpar — junta registros repetidos da mesma ida
!vistorias saidas — recalcula as saídas sem aviso (última mensagem + 10 min)
!vistorias lancar + lista colada — compara e lança o que faltar
!vistorias verificar [passada] — verificação geral: a IA lê todas as mensagens da semana e acha idas que passaram
!visita Nome dd/mm hh:mm-hh:mm Vistoriador [extra motivo] — lança à mão
!visita remover N — apaga a visita N de !vistorias Nome
!saida Nome hh:mm — registra a saída (ex.: !saida ipe amarelo 11:30; sem hora = agora)
!vistoriadores — quem está cadastrado
!envio Kesse = Condominios Kesse 19h — relatório diário do vistoriador num grupo
!envios — envios programados (!envio testar N · !envio remover N)
!carteira remover Nome, Nome — tira condomínios do quadro
!carteira incluir Nome = Vistoriador — inclui ou troca o responsável
!apelido nome no quadro = nome do grupo — liga um condomínio do quadro ao grupo (ex.: !apelido helena perez = helena borja)
Planilha com legenda *!vistorias importar* — condomínios e vistoriadores

*Conhecimento*
!base Nome — o que a IA já sabe do condomínio
!fato Nome: texto — ensina um fato à mão
!regra texto — ensina uma regra de atendimento para todos os condomínios (!regras lista, !regra remover N)
!esquecer N — apaga o fato N da última !base
!aprender — atualiza a base agora (roda sozinho a cada 3h)
!doc Nome Título — na legenda de um PDF (regimento, convenção…)
!docs — documentos cadastrados (!doc remover N)
!exemplos — respostas da equipe já aprendidas

*Ajustes*
!vinculos — grupos sem vínculo, com a resposta pronta para corrigir
!vinculos todos — todos os grupos e seus condomínios
!modelos — modelos de comando e nomes de condomínio válidos
!vinculo N nome tipo — corrige um grupo (ex.: !vinculo 5 torino síndico · !vinculo 7 não)
!identificar — pergunta de novo sobre os grupos não identificados
   (responda a pergunta com *sim*, o nome certo ex. _torino síndico_, ou *não*)
!ignorar Nome / !ativar Nome — para ou volta a monitorar um condomínio`;

let ultimaListaPendentes = [];
let ultimaListaOutros = [];
let ultimaListaFatos = [];
let ultimaListaDocs = [];
let ultimaListaVisitas = [];

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
      // Grupos de onde a IA saiu deixam de contar (o histórico fica guardado)
      const presentes = grupos.map((g) => g.jid);
      const saiu = await pool.query(
        `UPDATE chats SET ativo = FALSE WHERE kind <> 'privado' AND COALESCE(ativo, TRUE) AND NOT (jid = ANY($1)) RETURNING name`,
        [[...presentes, suggestionGroup]]
      );
      await pool.query(`UPDATE chats SET ativo = TRUE WHERE jid = ANY($1)`, [presentes]);
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
        `❔ Não identificados: ${cont.outro || 0}${cont.outro ? ' (vou perguntar logo abaixo)' : ''}\n` +
        (saiu.rowCount ? `🚪 Saí de ${saiu.rowCount} grupo(s): ${saiu.rows.map((r) => r.name).join(', ')}\n` : '') + '\n' +
        `🏢 ${condos.length} condomínios identificados.\n` +
        `Próximo passo: confira com *!condominios* e depois envie *!estudar novos*.`
      );
      await perguntarNaoIdentificados({ reperguntar: true });
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
        if (sub === 'incluir' && !lista.includes(r.condo.condo_key)) {
          await estudarCondo(r.condo, undefined, reply);
          lista = await getList('test_condos');
        } else if (sub === 'remover') {
          lista = lista.filter((k) => k !== r.condo.condo_key);
          await setSetting('test_condos', JSON.stringify(lista));
          await reply(`➖ Removido: ${r.condo.condo_name}`);
        }
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

    case 'pendencia':
    case 'pendencias': {
      const D = await import('./demandas.js');
      const sub = normalize(args[0] || '');
      const num = Number(String(args[1] || '').replace('#', ''));
      if (sub === 'ajuda') {
        await reply('📌 *Pendências — comandos*\n!pendencias — visão geral\n!pendencias Nathan — de um responsável\n!pendencia 12 — detalhe e histórico\n' +
          '!pendencia concluir 12 [nota] · !pendencia descartar 12 · !pendencia reabrir 12\n!pendencia prazo 12 28/11 [14:00]\n' +
          '!pendencias analisar — lê os grupos agora\n!pendencias enviar [Nome] — manda o relatório nos grupos COND.\n' +
          '!pendencias piloto Nathan, Carlos (ou: todos) — quem entra no controle\n!pendencias lideranca Carlos = Kesse');
        return true;
      }
      if (/^\d+$/.test(sub.replace('#', ''))) { await reply(await D.detalhe(Number(sub.replace('#', '')))); return true; }
      if (['concluir', 'concluida', 'resolvida', 'descartar', 'reabrir'].includes(sub)) {
        if (!num) { await reply(`Use: !pendencia ${sub} 12`); return true; }
        const st = sub === 'descartar' ? 'descartada' : sub === 'reabrir' ? 'aberta' : 'concluida';
        const d = await D.mudarStatus(num, st, args.slice(2).join(' '));
        await reply(d ? `✅ #${num} ${d.condo_nome} — ${d.titulo}: *${st}*.` : `Não achei a pendência #${num}.`);
        return true;
      }
      if (sub === 'prazo') {
        const q2 = num ? await D.mudarPrazo(num, args.slice(2).join(' ')) : null;
        await reply(q2 ? `📅 Prazo da #${num} agora é ${q2.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.` : 'Use: !pendencia prazo 12 28/11 14:00');
        return true;
      }
      if (sub === 'analisar' || sub === 'atualizar') {
        await reply('🔎 Lendo os grupos dos condomínios do piloto…');
        const r = await D.analisarPendencias();
        await reply(`📌 ${r.condos} condomínio(s) lidos: ${r.novas} pendência(s) nova(s), ${r.atualizadas} atualizada(s). Veja: !pendencias`);
        return true;
      }
      if (sub === 'enviar') {
        const n = await D.enviarRelatorios({ so: args.slice(1).join(' ') || null });
        await reply(n ? `📤 Relatório de pendências enviado para ${n} grupo(s).` : 'Nenhum grupo COND. encontrado para os responsáveis do piloto (ex.: COND. NATHAN com a IA dentro).');
        return true;
      }
      if (sub === 'piloto') {
        const lista = args.slice(1).join(' ').split(/[,;]| e /).map((x) => x.trim()).filter(Boolean);
        if (lista.length) await D.definirPiloto(lista);
        await reply(`📌 Controle de pendências ativo para: *${(await D.piloto()).join(', ')}*${lista.length ? '' : '\nPara mudar: !pendencias piloto Nathan, Carlos  (ou: todos)'}`);
        return true;
      }
      if (sub === 'lideranca') {
        const [p2, l2] = texto.split('\n')[0].replace(/^!\S+\s+\S+\s*/, '').split('=').map((x) => (x || '').trim());
        if (!p2 || !l2) { await reply('Use: !pendencias lideranca Carlos = Kesse'); return true; }
        await D.definirLider(p2, l2);
        await reply(`✅ Atrasadas de ${p2} também vão para ${l2}.`);
        return true;
      }
      for (const m of await D.visaoGeral(resto)) await reply(m);
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

    case 'regra':
    case 'regras': {
      // Regras de atendimento que valem para TODOS os condomínios (treinamento das sugestões)
      const regras = await getList('regras_atendimento');
      const sub = normalize(args[0] || '');
      if (cmd === 'regras' || !resto.trim()) {
        await reply(regras.length
          ? `📚 *Regras de atendimento* (valem para todos os condomínios)\n\n${regras.map((r, i) => `${i + 1}. ${r}`).join('\n\n')}\n\nNova: *!regra texto* · Tirar: *!regra remover N*`
          : 'Nenhuma regra ensinada ainda (o roteiro padrão de triagem já vale).\nEx.: *!regra Em problema de portão, sempre perguntar se testou outro controle e se outro morador consegue abrir.*');
        return true;
      }
      if (sub === 'remover' || sub === 'apagar' || sub === 'tirar') {
        const n = Number(args[1]);
        if (!n || !regras[n - 1]) { await reply('Use: !regra remover N (veja os números em *!regras*)'); return true; }
        const [tirada] = regras.splice(n - 1, 1);
        await setSetting('regras_atendimento', JSON.stringify(regras));
        await reply(`🗑️ Regra removida: ${tirada}`);
        return true;
      }
      regras.push(resto.trim());
      await setSetting('regras_atendimento', JSON.stringify(regras));
      await reply(`📚 Aprendido. Vale para as próximas sugestões de todos os condomínios:\n_${resto.trim()}_\n\nVer todas: *!regras*`);
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

    case 'vistorias':
    case 'vistoria': {
      const sub = normalize(args[0] || '');
      if (!sub || sub === 'pendentes' || sub === 'passada' || sub === 'semana') {
        const msgs = await relatorio(sub === 'passada' ? -1 : 0, { apenasPendentes: sub === 'pendentes' });
        for (const m of msgs) await reply(m);
        return true;
      }
      if (sub === 'diagnostico' || sub === 'porque' || sub === 'por') {
        const nome = args.slice(sub === 'por' ? 2 : 1).join(' ');
        if (!nome) { await reply('Use: !vistorias diagnostico toscana'); return true; }
        await reply(await diagnostico(nome));
        return true;
      }
      if (sub === 'saidas' || sub === 'saida') {
        const n = await recalcularSaidasEstimadas({ forcar: true });
        await reply(`⏱️ Saídas recalculadas: ${n} visita(s) sem aviso de saída agora têm saída = última mensagem do vistoriador + 10 min (marcadas com *).`);
        return true;
      }
      if (sub === 'limpar' || sub === 'juntar' || sub === 'duplicadas') {
        const n = await consolidarDuplicadas();
        await reply(n ? `🧹 Juntei ${n} registro(s) repetido(s) da mesma ida.` : '✅ Nenhuma ida repetida.');
        return true;
      }
      if (sub === 'apagar' || sub === 'remover' || sub === 'excluir') {
        let resto = args.slice(1).join(' ');
        const md = resto.match(/\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*$/);
        if (md) resto = resto.slice(0, md.index);
        if (!resto.trim()) { await reply('Use: *!vistorias apagar Antares* (todas da semana) ou *!vistorias apagar Antares 17/11* (só aquele dia)'); return true; }
        await reply(await apagarVisitas(resto.trim(), md?.[1]));
        return true;
      }
      if (sub === 'comparar' || sub === 'lancar' || sub === 'lista') {
        const corpo = texto.split('\n').slice(1).join('\n');
        if (!corpo.trim()) { await reply('Mande na mesma mensagem: na 1ª linha *!vistorias comparar* (ou *!vistorias lancar*) e, abaixo, a lista colada da planilha:\nNOME  dd/mm/aaaa  QUEM'); return true; }
        for (const m of await compararLista(corpo, { lancar: sub === 'lancar' })) await reply(m);
        return true;
      }
      if (sub === 'semgrupo' || sub === 'sem' || sub === 'vinculo' || sub === 'vinculos') {
        for (const m of await semGrupo()) await reply(m);
        return true;
      }
      if (sub === 'verificar' || sub === 'verificacao' || sub === 'conferir') {
        const passada = normalize(args[1] || '') === 'passada';
        await reply(`🔎 Verificação geral ${passada ? 'da semana passada' : 'desta semana'}: vou ler todas as mensagens de todos os condomínios. Leva alguns minutos…`);
        // 0) grupos que estavam fora do teste: busca na Evolution as mensagens que não foram guardadas
        const teste = await getList('test_condos');
        const foraTeste = (await listCondos()).filter((c) => !teste.includes(c.condo_key));
        let importadas = 0;
        for (const c of foraTeste) {
          try { importadas += (await importarHistorico(c.condo_key)).novas; } catch (e) { console.error('[verificar] histórico', c.condo_name, e.message); }
        }
        if (importadas) await reply(`📥 ${importadas} mensagem(ns) recuperada(s) de ${foraTeste.length} grupo(s) que não estavam sendo guardados.`);
        const rel = await reprocessarSemana(passada ? -1 : 0);
        const r = await verificarSemana(passada ? -1 : 0, { aoProgresso: reply });
        const linhas = r.achados.map(({ it, v, tipo }) =>
          `• *${it.nome}* (${it.vistoriador})\n   ${v.data} ${v.entrada}${v.saida ? `–${v.saida}` : ''} · ${v.quem || 'equipe'} · ${tipo === 'ordinaria' ? 'vistoria' : 'extra'}${v.motivo ? ` · ${v.motivo}` : ''}\n   _"${String(v.evidencia || '').slice(0, 80)}"_`);
        await reply(
          `✅ *Verificação concluída*\n\n` +
          `🔁 Regras de detecção: ${rel.novas} visita(s) nova(s)\n` +
          `🔎 Leitura completa: ${r.conferidos} condomínio(s) conferidos · ${r.achados.length} ida(s) encontrada(s)` +
          (r.semMsgs ? `\n💤 ${r.semMsgs} sem nenhuma mensagem na semana (nada a conferir)` : '') +
          (linhas.length ? `\n\n*Encontradas pela leitura:*\n\n${linhas.join('\n\n')}\n\nSe alguma estiver errada: !vistorias Nome → !visita remover N` : '') +
          `\n\nVeja o resultado com *!vistorias*`
        );
        return true;
      }
      if (sub === 'reprocessar' || sub === 'reler') {
        await reply('🔄 Relendo as mensagens da semana…');
        const r = await reprocessarSemana(normalize(args[1] || '') === 'passada' ? -1 : 0);
        await reply(`✅ ${r.lidas} mensagem(ns) da equipe relidas · ${r.novas} visita(s) nova(s) registrada(s).\nVeja com !vistorias`);
        return true;
      }
      if (sub === 'importar') {
        if (!msg.documento) {
          await reply('Envie a planilha (Excel ou CSV) aqui no grupo com a *legenda*: !vistorias importar\nColunas: Condomínio | Vistoriador | Telefone');
          return true;
        }
        await reply('📥 Lendo a planilha…');
        try {
          const midia = await getMediaBase64(msg.key);
          if (!midia?.base64) throw new Error('não consegui baixar o arquivo');
          const r = await importarCarteira(Buffer.from(midia.base64, 'base64'));
          await reply(
            `✅ Planilha importada: *${r.total} condomínios*, ${r.vistoriadores.length} vistoriadores (${r.vistoriadores.join(', ') || '-'})` +
            (r.semTelefone.length ? `\n\n📵 Sem telefone (não vou reconhecer as mensagens deles): ${r.semTelefone.join(', ')}` : '') +
            (r.semGrupo.length ? `\n\n⚠️ *${r.semGrupo.length} sem grupo da IA* (adicione o número nos grupos e rode !sincronizar):\n${r.semGrupo.slice(0, 60).map((n) => `• ${n}`).join('\n')}${r.semGrupo.length > 60 ? '\n…' : ''}` : '\n\n🎉 Todos os condomínios têm grupo com a IA.')
          );
        } catch (e) {
          console.error('[carteira]', e.message);
          await reply(`❌ Não consegui importar: ${e.message}`);
        }
        return true;
      }
      if (sub === 'exportar') {
        let inicio, fim, titulo;
        const mes = (args[1] || '').match(/^(\d{1,2})\/(\d{4})$/);
        if (mes) {
          const m = Number(mes[1]), a = Number(mes[2]);
          inicio = dataHoraBR(`01/${m}/${a}`, '00:00');
          fim = dataHoraBR(`01/${m === 12 ? 1 : m + 1}/${m === 12 ? a + 1 : a}`, '00:00');
          titulo = `${String(m).padStart(2, '0')}-${a}`;
        } else {
          const hoje = new Date(Date.now() - 3 * 3600 * 1000);
          const m = hoje.getUTCMonth() + 1, a = hoje.getUTCFullYear();
          inicio = dataHoraBR(`01/${m}/${a}`, '00:00');
          fim = semana(1).inicio;
          titulo = `${String(m).padStart(2, '0')}-${a}`;
        }
        try {
          const n = await enviarPlanilha(msg.chatJid, inicio, fim, titulo);
          if (!n) await reply('Planilha enviada, mas ainda não há visitas registradas no período.');
        } catch (e) {
          console.error('[exportar]', e.message);
          await reply(`❌ Não consegui gerar a planilha: ${e.message}`);
        }
        return true;
      }
      // histórico de um condomínio
      const r = await acharCondo(resto);
      if (r.erro) { await reply(r.erro); return true; }
      ultimaListaVisitas = await historico(r.condo.condo_key);
      await reply(ultimaListaVisitas.length
        ? `🏢 *${r.condo.condo_name}*: últimas visitas\n\n${ultimaListaVisitas.map(linhaVisita).join('\n')}\n\n* = saída estimada · ✍️ = lançada à mão · 🔎 = achada na verificação geral\nPara apagar: !visita remover N`
        : `🏢 *${r.condo.condo_name}*: nenhuma visita registrada ainda.`);
      return true;
    }

    case 'visita': {
      if (normalize(args[0] || '') === 'remover') {
        const v = ultimaListaVisitas[Number(args[1]) - 1];
        if (!v) { await reply('Use !vistorias Nome primeiro e depois !visita remover N.'); return true; }
        await removerVisita(v.id);
        await reply(`🗑️ Visita removida: ${v.condo_nome} ${linhaVisita(v, 0).slice(3)}`);
        return true;
      }
      // !visita Nome dd/mm hh:mm-hh:mm Vistoriador [extra motivo]
      const iData = args.findIndex((a) => /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(a));
      const faixaH = args[iData + 1] || '';
      const mh = faixaH.match(/^(\d{1,2}[:h]\d{2})(?:-(\d{1,2}[:h]\d{2}))?$/);
      if (iData < 1 || !mh || !args[iData + 2]) {
        await reply('Use: !visita Nome dd/mm hh:mm-hh:mm Vistoriador [extra motivo]\nEx.: !visita mirante 28/10 09:10-10:30 Kesse\nEx.: !visita ipe 28/10 14:00-14:40 Kesse extra vazamento');
        return true;
      }
      const r = await acharCondo(args.slice(0, iData).join(' '));
      if (r.erro) { await reply(r.erro); return true; }
      const vistoriador = args[iData + 2];
      const resto2 = args.slice(iData + 3);
      const extra = /^extra/i.test(resto2[0] || '');
      const motivo = (extra ? resto2.slice(1) : resto2).join(' ');
      const entrada = dataHoraBR(args[iData], mh[1]);
      const saida = mh[2] ? dataHoraBR(args[iData], mh[2]) : null;
      await lancarManual({ condo_key: r.condo.condo_key, condo_nome: r.condo.condo_name, vistoriador, tipo: extra ? 'extraordinaria' : 'ordinaria', motivo, entrada, saida });
      await reply(`✍️ Visita lançada: *${r.condo.condo_name}* ${args[iData]} ${mh[1]}${mh[2] ? `–${mh[2]}` : ''} · ${vistoriador} · ${extra ? 'extraordinária' : 'ordinária'}${motivo ? ` (${motivo})` : ''}`);
      return true;
    }

    case 'envio':
    case 'envios': {
      // !envio Kesse = Condominios Kesse 19h  ·  !envios  ·  !envio remover N  ·  !envio testar N
      const sub = normalize(args[0] || '');
      const lista = await listarEnvios();
      const DIAS_N = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
      const descr = (e, i) => `${i + 1}. *${e.vistoriador}* → ${e.nome} · todo dia${e.dias ? ` (${e.dias.map((d) => DIAS_N[d]).join(', ')})` : ''} às ${e.hora}`;
      if (sub === 'remover' || sub === 'testar') {
        const e = lista[Number(args[1]) - 1];
        if (!e) { await reply('Número inválido. Veja a lista com !envios'); return true; }
        if (sub === 'remover') { await removerEnvio(Number(args[1]) - 1); await reply(`➖ Envio removido: ${e.vistoriador} → ${e.nome}`); return true; }
        await enviarRelatorioVistoriador(e);
        await reply(`📤 Relatório de ${e.vistoriador} enviado agora para ${e.nome}.`);
        return true;
      }
      if (!resto.includes('=')) {
        await reply(lista.length
          ? `📤 *Envios programados*\n${lista.map(descr).join('\n')}\n\n!envio testar N — envia agora · !envio remover N`
          : '📤 Nenhum envio programado.\n\nUse: !envio Kesse = Condominios Kesse 19h\n(adicione a IA no grupo e mande !sincronizar antes)');
        return true;
      }
      // "Kesse = Condominios Kesse 19h [seg-sab]"
      const [vist, dir] = resto.split('=').map((x) => x.trim());
      const mh = dir.match(/(\d{1,2})(?:[:h](\d{2}))?\s*h?\b(?!.*\d{1,2}[:h])/i);
      const hora = mh ? `${mh[1].padStart(2, '0')}:${mh[2] || '00'}` : '19:00';
      const semFds = /seg.{0,3}(sab|sex)/i.test(dir) ? (/sex/i.test(dir) ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6]) : null;
      const nomeGrupo = dir.replace(/\b\d{1,2}([:h]\d{2})?\s*h?\b/gi, '').replace(/seg.{0,3}(sab|sex)\w*/i, '').trim();
      const grupos = (await pool.query(`SELECT jid, name FROM chats WHERE jid LIKE '%@g.us'`)).rows;
      const alvo = normalize(nomeGrupo);
      const g = grupos.find((x) => normalize(x.name || '') === alvo) || grupos.filter((x) => normalize(x.name || '').includes(alvo))[0];
      if (!g) { await reply(`Não achei o grupo "${nomeGrupo}". Adicione a IA no grupo, mande !sincronizar e tente de novo.`); return true; }
      // o grupo é interno: não entra como condomínio nem é analisado
      await pool.query(`UPDATE chats SET kind = 'interno', condo_key = NULL, condo_name = NULL, manual = TRUE WHERE jid = $1`, [g.jid]);
      const e = { jid: g.jid, nome: g.name, vistoriador: vist, hora, dias: semFds };
      await salvarEnvio(e);
      await reply(`✅ Programado: relatório de *${vist}* no grupo *${g.name}* todo dia${semFds ? ' (sem fim de semana)' : ''} às *${hora}*.\nPara ver agora como fica: !envio testar ${(await listarEnvios()).length}`);
      return true;
    }

    case 'enviar': {
      // !enviar leituras Nathan [próxima semana | semana | hoje]
      if (!/^leituras?$/.test(normalize(args[0] || ''))) { await reply('Use: !enviar leituras Nathan próxima semana  (ou: semana · hoje)'); return true; }
      const L = await import('./leituras.js');
      const t = normalize(args.slice(1).join(' '));
      const proxima = /proxima/.test(t);
      const tipo = proxima || /semana/.test(t) ? 'semana' : 'dia';
      const nome = args.slice(1).join(' ').replace(/(^|\s)(pr[oó]xima|semana|hoje|da|de|na)(?=\s|$)/gi, ' ').replace(/\s+/g, ' ').trim();
      if (!nome) { await reply('Diga para quem: !enviar leituras Nathan próxima semana'); return true; }
      const grupos = await L.gruposConfigurados();
      const g = grupos.find((x) => normalize(x.lider) === normalize(nome));
      if (!g) { await reply(`${nome} ainda não tem grupo de leituras (crie o grupo "COND. ${nome.toUpperCase()}" com a IA dentro). Com grupo: ${grupos.map((x) => x.lider).join(', ') || 'nenhum'}`); return true; }
      await L.enviarAvisos(tipo, { so: g.lider, ref: proxima ? L.proximaSegunda() : null });
      await reply(`📤 Alerta de leituras de *${g.lider}* (${proxima ? 'próxima semana' : tipo === 'semana' ? 'esta semana' : 'hoje'}) enviado em *${g.nome}*.`);
      return true;
    }

    case 'leitura':
    case 'leituras': {
      const L = await import('./leituras.js');
      const sub = normalize(args[0] || '');
      const primeira = texto.split('\n')[0];
      const resto1 = primeira.replace(/^!\S+\s*\S*\s*/, '').trim(); // depois do subcomando
      const acharGrupo = async (nome) => {
        const grupos = (await pool.query(`SELECT jid, name FROM chats WHERE jid LIKE '%@g.us'`)).rows;
        const alvo = normalize(nome);
        return grupos.find((x) => normalize(x.name || '') === alvo) || grupos.filter((x) => normalize(x.name || '').includes(alvo))[0];
      };
      const interno = (jid) => pool.query(`UPDATE chats SET kind = 'interno', condo_key = NULL, condo_name = NULL, manual = TRUE WHERE jid = $1`, [jid]);
      const AJUDA = '📏 *Leituras — comandos*\n' +
        '!leituras — situação da semana (todos os líderes)\n!leituras Janaina — só de um líder\n' +
        '!leituras controle = Nome do grupo — grupo onde a equipe manda a lista de leituras feitas\n' +
        '!leituras grupo Carlos = COND. CARLOS — onde avisar cada responsável\n!leituras grupos — ver configuração\n!leituras responsaveis — quem cuida de cada condomínio\n!leituras responsavel Antares = Carlos — troca um\n' +
        '!leituras enviar [semana|dia] [Líder] — manda os avisos agora\n!leituras importar + lista colada abaixo\n' +
        '!leitura feita Nome dd/mm (Quem)\n!leituras apelido nome da lista = nome do controle\n' +
        '!leituras antecipar Leste [próxima semana] — puxa uma leitura para a semana\n!leituras incluir Nome = Líder · !leituras remover Nome\n!leituras horario semana 07:30 · !leituras horario dia 17:30';

      if (cmd === 'leitura' && sub === 'feita') {
        const m = primeira.match(/feita\s+(.+?)\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*(?:\((.+)\))?\s*$/i);
        if (!m) { await reply('Use: !leitura feita Antares 19/11 (Carlos)'); return true; }
        const c = await L.leituraManual(m[1], m[2], m[3]);
        await reply(c ? `✅ Leitura registrada: *${c.nome}* em ${m[2]}${m[3] ? ` (${m[3]})` : ''}` : `Não achei "${m[1]}" no controle de leituras.`);
        return true;
      }
      if (sub === 'ajuda' || sub === 'comandos') { await reply(AJUDA); return true; }
      if (sub === 'controle') {
        const nome = primeira.split('=')[1]?.trim();
        if (!nome) { await reply('Use: !leituras controle = Nome do grupo de controle de leituras'); return true; }
        const g = await acharGrupo(nome);
        if (!g) { await reply(`Não achei o grupo "${nome}". Adicione a IA no grupo, mande !sincronizar e tente de novo.`); return true; }
        await interno(g.jid);
        await setSetting('leituras_grupo_controle', g.jid);
        await setSetting('leituras_grupo_controle_nome', g.name);
        await reply(`✅ *${g.name}* é o grupo de controle de leituras. A IA só lê as listas que a equipe manda ali (não escreve nada no grupo).\n\nPara já carregar a lista deste mês, cole-a aqui: *!leituras importar* na 1ª linha e a lista abaixo.`);
        return true;
      }
      if (sub === 'grupo') {
        if (normalize(args[1] || '') === 'remover') {
          await L.removerGrupoLider(args.slice(2).join(' '));
          await reply(`➖ Avisos de leitura de ${args.slice(2).join(' ')} desligados.`);
          return true;
        }
        const [lider, nome] = resto1.split('=').map((x) => (x || '').trim());
        if (!lider || !nome) { await reply('Use: !leituras grupo Janaina = COND. JANAINA'); return true; }
        const ls = await L.lideres();
        const lid = ls.find((x) => normalize(x) === normalize(lider));
        if (!lid) { await reply(`"${lider}" não é responsável por nenhum condomínio nas leituras. Responsáveis: ${ls.join(', ')}\nVer quem cuida de cada um: !leituras responsaveis`); return true; }
        const g = await acharGrupo(nome);
        if (!g) { await reply(`Não achei o grupo "${nome}". Adicione a IA no grupo, mande !sincronizar e tente de novo.`); return true; }
        await interno(g.jid);
        await L.definirGrupoLider(lid, g);
        await reply(`✅ Leituras de *${lid}* serão avisadas em *${g.name}*: segunda 07:30 (semana) e de seg a sáb 17:30 (feitas e a fazer).\nPara ver como fica: *!leituras enviar semana ${lid}*`);
        return true;
      }
      if (sub === 'responsavel' || sub === 'responsaveis') {
        if (sub === 'responsaveis' || !resto1.includes('=')) {
          const m = await L.porResponsavel();
          const tit = (x) => String(x).trim().toLowerCase().replace(/(^|\s)\S/g, (y) => y.toUpperCase()).replace(/ (Da|Das|De|Do|Dos|E) /g, (y) => y.toLowerCase());
          await reply(`👤 *Leituras por responsável* (vem do quadro de vistorias de cada condomínio)\n\n` +
            [...m.entries()].sort().map(([p, l]) => `*${p}* (${l.length})\n${l.map((i) => tit(i.nome)).join(' · ')}`).join('\n\n') +
            `\n\nPara trocar um: *!leituras responsavel Antares = Carlos*`);
          return true;
        }
        const [nome, pessoa] = resto1.split('=').map((x) => (x || '').trim());
        const c = nome && pessoa ? await L.definirResponsavel(nome, pessoa) : null;
        await reply(c ? `✅ Leitura do *${c.nome}* fica com *${pessoa}*.` : 'Use: !leituras responsavel Antares = Carlos');
        return true;
      }
      if (sub === 'grupos') {
        const g = await L.listarGrupos();
        const ls = await L.lideres();
        await reply(`📏 *Leituras — configuração*\nGrupo de controle: ${g.controle || '— (use !leituras controle = Nome)'}\n\n` +
          ls.map((l) => { const x = g.lideres.find((y) => normalize(y.lider) === normalize(l)); return `• ${l} → ${x ? x.nome : '— (use !leituras grupo ' + l + ' = Nome do grupo)'}`; }).join('\n'));
        return true;
      }
      if (sub === 'enviar' || sub === 'testar') {
        const tipo = normalize(args[1] || '') === 'semana' ? 'semana' : 'dia';
        const so = args.slice(normalize(args[1] || '') === 'semana' || normalize(args[1] || '') === 'dia' ? 2 : 1).join(' ') || null;
        const n = await L.enviarAvisos(tipo, { so });
        await reply(n ? `📤 Aviso de leituras (${tipo === 'semana' ? 'da semana' : 'do dia'}) enviado para ${n} grupo(s).` : 'Nenhum grupo de líder configurado ainda: !leituras grupo Janaina = COND. JANAINA');
        return true;
      }
      if (sub === 'importar' || sub === 'lista') {
        const corpo = texto.split('\n').slice(1).join('\n');
        if (!corpo.trim()) { await reply('Mande na mesma mensagem: *!leituras importar* na 1ª linha e a lista abaixo, como a equipe manda no grupo de controle.'); return true; }
        const r = await L.registrarLista(corpo, { origem: 'lista' });
        await reply(`📏 Lista lida: ${r.linhas} linha(s) · *${r.novas} leitura(s) nova(s)* registrada(s)${r.naoAchei.length ? ` · ${r.naoAchei.length} não reconhecida(s) (mandei acima)` : ''}.`);
        return true;
      }
      if (sub === 'apelido') {
        const [de, para] = resto1.split('=').map((x) => (x || '').trim());
        const c = de && para ? await L.salvarApelido(de, para) : null;
        await reply(c ? `✅ "${de}" agora é *${c.nome}* nas listas de leitura.` : 'Use: !leituras apelido nome da lista = nome do controle');
        return true;
      }
      if (sub === 'incluir') {
        const [nome, lider] = resto1.split('=').map((x) => (x || '').trim());
        if (!nome || !lider) { await reply('Use: !leituras incluir Nome do condomínio = Líder'); return true; }
        await L.incluirCondominio(nome, lider);
        await reply(`➕ *${nome}* incluído no controle de leituras (líder: ${lider}). Para calcular a data, registre a última leitura: !leitura feita ${nome} dd/mm`);
        return true;
      }
      if (sub === 'remover' || sub === 'tirar') {
        const c = await L.removerCondominio(resto1);
        await reply(c ? `➖ *${c.nome}* saiu do controle de leituras.` : `Não achei "${resto1}" no controle.`);
        return true;
      }
      if (sub === 'antecipar') {
        const prox = /pr[oó]xima/i.test(resto1);
        const nome = resto1.replace(/pr[oó]xima( semana)?|esta semana|semana/gi, '').trim();
        const sem = prox ? L.proximaSegunda() : L.semanaDe(L.hojeBR()).ini;
        const c = nome ? await L.antecipar(nome, sem) : null;
        await reply(c ? `✅ *${c.nome}* entra nas leituras da semana de ${sem.slice(8, 10)}/${sem.slice(5, 7)}. Para avisar agora: !enviar leituras (responsável) semana`
          : 'Use: !leituras antecipar Leste  (ou: !leituras antecipar Leste próxima semana)');
        return true;
      }
      if (sub === 'horario') {
        const qual = normalize(args[1] || '');
        const h = (args[2] || '').match(/^(\d{1,2})[:h]?(\d{2})?$/);
        if (!['semana', 'dia'].includes(qual) || !h) { await reply('Use: !leituras horario semana 07:30  ou  !leituras horario dia 17:30'); return true; }
        const hora = `${h[1].padStart(2, '0')}:${h[2] || '00'}`;
        await setSetting(qual === 'semana' ? 'leituras_hora_semana' : 'leituras_hora_dia', hora);
        await reply(`✅ ${qual === 'semana' ? 'Aviso da semana (segunda)' : 'Resumo diário (seg a sáb)'} às *${hora}*.`);
        return true;
      }
      for (const m of await L.relatorioLeituras(resto)) await reply(m);
      return true;
    }

    case 'saida':
    case 'saiu': {
      // !saida ipe amarelo 11:30   (sem hora = agora)
      const mh = resto.match(/(\d{1,2})[:h](\d{2})\s*$/);
      const nome = (mh ? resto.slice(0, mh.index) : resto).trim();
      if (!nome) { await reply('Use: !saida Nome do condomínio hh:mm\nEx.: !saida ipe amarelo 11:30 (sem hora = agora)'); return true; }
      const r = await acharCondo(nome);
      if (r.erro) { await reply(r.erro); return true; }
      const agoraBR = new Date(Date.now() - 3 * 3600 * 1000);
      const dd = `${agoraBR.getUTCDate()}/${agoraBR.getUTCMonth() + 1}`;
      const quando = mh ? dataHoraBR(dd, `${mh[1]}:${mh[2]}`) : new Date();
      const v = await registrarSaida(r.condo.condo_key, quando);
      await reply(v ? `🏁 Saída registrada: *${r.condo.condo_name}* · ${v.vistoriador} · ${quando.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}`
        : `Não achei visita aberta em ${r.condo.condo_name} antes desse horário.`);
      return true;
    }

    case 'carteira': {
      // !carteira remover Nome  ·  !carteira incluir Nome = Vistoriador  ·  !carteira (resumo)
      const sub = normalize(args[0] || '');
      const corpo = args.slice(1).join(' ');
      if (sub === 'remover' || sub === 'tirar' || sub === 'excluir') {
        const nomes = corpo.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
        const saida = [];
        for (const n of nomes) {
          const r = await removerDaCarteira(n);
          saida.push(r.length ? `➖ ${r[0]}` : `❓ "${n}" não está no quadro (confira o nome com !vistoriadores)`);
        }
        await reply(saida.join('\n') || 'Use: !carteira remover Nome (vários separados por vírgula)');
        return true;
      }
      if (sub === 'incluir' || sub === 'trocar' || sub === 'mover') {
        const [nome, vist] = corpo.split('=').map((x) => (x || '').trim());
        if (!nome || !vist) { await reply('Use: !carteira incluir Nome do condomínio = Vistoriador\nEx.: !carteira incluir Viena C = Kesse'); return true; }
        const r = await incluirNaCarteira(nome, vist);
        await reply(r === 'trocado' ? `🔁 ${nome} agora é do(a) *${vist}*` : `➕ ${nome} incluído no quadro, com *${vist}*`);
        return true;
      }
      await reply('*Quadro de vistorias*\n!vistoriadores — quantos condomínios cada um tem\n!carteira remover Nome, Nome — tira do quadro\n!carteira incluir Nome = Vistoriador — inclui ou troca o responsável');
      return true;
    }

    case 'apelido': {
      const [a, b] = resto.split('=').map((x) => (x || '').trim());
      if (!a || !b) { await reply('Use: !apelido nome no quadro = nome do grupo\nEx.: !apelido helena perez = helena borja'); return true; }
      const r = await acharCondo(b);
      if (r.erro) { await reply(r.erro); return true; }
      await definirApelido(a, r.condo.condo_key);
      await reply(`🔗 "${a}" (quadro de vistorias) = *${r.condo.condo_name}* (grupo)`);
      return true;
    }

    case 'vistoriadores': {
      const cart = await listarCarteira();
      const vist = await getVistoriadores();
      if (!cart.length) { await reply('Nenhuma planilha importada ainda. Envie a planilha com a legenda: !vistorias importar'); return true; }
      const cont = new Map();
      for (const c of cart) cont.set(c.vistoriador || 'Sem vistoriador', (cont.get(c.vistoriador || 'Sem vistoriador') || 0) + 1);
      const comTel = new Set(Object.values(vist));
      await reply(`👷 *Vistoriadores*\n${[...cont].map(([n, q]) => `• ${n}: ${q} condomínios${n !== 'Sem vistoriador' && !comTel.has(n) ? ' 📵 sem telefone' : ''}`).join('\n')}`);
      return true;
    }

    case 'estudar': {
      if (normalize(args[0] || '') === 'novos') {
        const teste = await getList('test_condos');
        const novos = (await listCondos()).filter((c) => !teste.includes(c.condo_key));
        if (!novos.length) { await reply('Nenhum condomínio novo. Adicione a IA nos grupos e rode !sincronizar.'); return true; }
        await reply(`🎓 Vou estudar ${novos.length} condomínio(s): ${novos.map((c) => c.condo_name).join(', ')}\nIsso pode levar alguns minutos.`);
        for (const c of novos) await estudarCondo(c, undefined, null);
        for (const m of await mensagensEstudo()) await reply(m);
        return true;
      }
      const dias = /^\d+$/.test(args[args.length - 1] || '') ? Number(args[args.length - 1]) : undefined;
      const nome = (dias !== undefined ? args.slice(0, -1) : args).join(' ');
      const r = await acharCondo(nome);
      if (r.erro) { await reply(r.erro + '\n\nUse: !estudar Nome [dias]'); return true; }
      await estudarCondo(r.condo, dias, reply);
      return true;
    }

    case 'perguntar':
    case 'pergunta':
    case 'p':
    case 'resumo': {
      let nome, pergunta, dias = 30;
      if (cmd === 'resumo') {
        nome = resto;
        dias = 7;
        pergunta = 'Faça um resumo do que está acontecendo no condomínio: assuntos principais, pendências e cobranças sem resposta da equipe, reclamações, decisões, andamento de obras/orçamentos, e o clima geral dos moradores e do síndico.';
      } else {
        const i = resto.indexOf(':');
        nome = i >= 0 ? resto.slice(0, i) : '';
        pergunta = i >= 0 ? resto.slice(i + 1).trim() : '';
      }
      if (!nome.trim() || !pergunta) {
        await reply('Use: !perguntar NomeDoCondominio: sua pergunta\nEx.: !perguntar torino: o síndico está satisfeito com a limpeza?\nOu: !resumo torino');
        return true;
      }
      const r = await acharCondo(nome.trim());
      if (r.erro) { await reply(r.erro); return true; }
      await reply(`🔎 Consultando *${r.condo.condo_name}*…`);
      try {
        const out = await perguntar(r.condo, pergunta, dias);
        await reply(`🤖 *${r.condo.condo_name}*\n\n${out.resposta}\n\n_Base: ${out.mensagens} mensagens dos últimos ${dias} dias, base de conhecimento e documentos._`);
      } catch (e) {
        console.error('[perguntar]', e.message);
        await reply(`❌ Não consegui consultar agora: ${e.message}`);
      }
      return true;
    }

    case 'vinculos':
    case 'vinculacoes':
    case 'vinculo': {
      if (cmd === 'vinculo' || /^\d/.test(resto)) {
        // a numeração continua a da última lista enviada, até um novo !vinculos
        await corrigirVinculos(texto);
        return true;
      }
      for (const m of await listarVinculos({ todos: normalize(resto) === 'todos' })) await reply(m);
      return true;
    }

    case 'modelos':
    case 'modelo':
    case 'nomes': {
      for (const m of await modelos()) await reply(m);
      return true;
    }

    case 'revisar': {
      await reply('🔄 Revisando as pendências de todos os grupos…');
      const r = await revisarTudo({ forcar: true });
      if (!r) { await reply('Já estou revisando. Tente em alguns minutos.'); return true; }
      await reply(`✅ Revisão concluída: ${r.fechadas} assunto(s) fechado(s) em ${r.chats} grupo(s).\nPendências abertas agora: ${await contarAssuntos()} assunto(s).`);
      return true;
    }

    case 'nova':
    case 'limpar': {
      await limparConversa();
      await reply('🧹 Ok, começando uma conversa nova.');
      return true;
    }

    case 'estudo': {
      const sub = normalize(args[0] || '');
      if (sub === 'liberar') {
        const r = await acharCondo(args.slice(1).join(' '));
        if (r.erro) { await reply(r.erro); return true; }
        await liberar(r.condo.condo_key);
        const s = await resumoCondo(r.condo.condo_key);
        await reply(`✅ *${r.condo.condo_name}* liberado: a partir de agora envio sugestões.\n🧠 ${s.fatos} fatos · 🎓 ${s.exemplos} exemplos · 📨 ${s.msgs} mensagens`);
        return true;
      }
      if (sub === 'dias') {
        const dias = Number(args[args.length - 1]);
        const r = await acharCondo(args.slice(1, -1).join(' '));
        if (r.erro || !dias) { await reply('Use: !estudo dias Nome N'); return true; }
        await alterarDias(r.condo.condo_key, dias);
        await reply(`📅 *${r.condo.condo_name}*: estudo de ${dias} dia(s) contados do início.`);
        return true;
      }
      for (const m of await mensagensEstudo()) await reply(m);
      return true;
    }

    case 'planilha': {
      // Link que o Apps Script da planilha Google usa para buscar todas as idas
      let tok = await getSetting('planilha_token');
      if (!tok || normalize(args[0] || '') === 'novo') {
        tok = (await import('crypto')).randomBytes(18).toString('base64url');
        await setSetting('planilha_token', tok);
      }
      const dom = process.env.RAILWAY_PUBLIC_DOMAIN || 'assistente-grupos-production-f2a1.up.railway.app';
      await reply(`📊 *Planilha Google de idas*\n\nCole este link na 1ª linha do script da planilha (URL_IDAS):\n\nhttps://${dom}/api/idas/${tok}\n\n` +
        `Não compartilhe o link: quem tiver acesso vê todas as idas. Para trocar (o antigo para de funcionar): *!planilha novo*`);
      return true;
    }
    case 'custos':
    case 'custo':
    case 'consumo': {
      // Consumo do Gemini por tarefa (tokens contados pela própria resposta do Google)
      const ontem = normalize(args[0] || '') === 'ontem';
      const dia = new Date(Date.now() - 3 * 3600 * 1000 - (ontem ? 86400000 : 0)).toISOString().slice(0, 10);
      let tarefas = {};
      if (!ontem && usoHoje.dia === dia) tarefas = usoHoje.tarefas;
      else { try { tarefas = JSON.parse((await getSetting(`uso_${dia}`)) || '{}'); } catch {} }
      const linhas = Object.entries(tarefas).map(([k, t]) => {
        const [tarefa, modelo] = k.split('|');
        return { tarefa, modelo, ...t, tokens: t.entrada + t.saida + t.pensamento, us: custoEstimado(modelo, t) };
      }).sort((a, b) => (b.us ?? 0) - (a.us ?? 0) || b.tokens - a.tokens);
      if (!linhas.length) { await reply(`📊 Sem consumo registrado em ${dia.split('-').reverse().join('/')}. (A contagem começou nesta versão.)`); return true; }
      const totTok = linhas.reduce((s, l) => s + l.tokens, 0);
      const totUs = linhas.reduce((s, l) => s + (l.us || 0), 0);
      const mil = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)} mi` : `${Math.round(n / 1000)} mil`;
      await reply(`📊 *Consumo do Gemini ${ontem ? 'ontem' : 'hoje'}* (${dia.split('-').reverse().join('/')})\n` +
        `${mil(totTok)} tokens${totUs ? ` · ≈ US$ ${totUs.toFixed(2)}` : ''}\n\n` +
        linhas.map((l) => `• *${l.tarefa}* — ${l.chamadas} chamadas · ${mil(l.tokens)} tokens (${Math.round((l.tokens / totTok) * 100)}%)` +
          `${l.us != null ? ` · ≈ US$ ${l.us.toFixed(2)}` : ''}\n   _${l.modelo}: entrada ${mil(l.entrada)}, resposta ${mil(l.saida)}${l.pensamento ? `, pensamento ${mil(l.pensamento)}` : ''}_`).join('\n') +
        `\n\n_Estimativa pela tabela de preços do Google; o valor oficial está em aistudio.google.com → Billing._`);
      return true;
    }
    case 'status': {
      const s = await stats();
      const teste = await getList('test_condos');
      await reply(
        `📊 *Status* (versão ${process.env.RAILWAY_GIT_COMMIT_SHA ? process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7) : 'local'})\nModo: ${await getMode()}${(await getMode()) === 'teste' ? ` (${teste.length} condomínios)` : ''}\n` +
        `Grupos conhecidos: ${s.grupos}\nMensagens nas últimas 24h: ${s.msgs_24h}\nPendências abertas: ${await contarAssuntos()} assunto(s)\n\n` +
        `🧠 *IA (Gemini)* desde ${saudeIA.desde.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}\n` +
        `Chave em uso: termina em *${String(config.geminiKey || '').slice(-5)}* · modelos: ${config.geminiModel} / ${config.geminiModelLeve}\n` +
        `✅ ${saudeIA.ok} chamadas ok · ❌ ${saudeIA.erros} erros` + (saudeIA.limite ? ` (${saudeIA.limite} por limite de uso)` : '') +
        (saudeIA.ultimoErro ? `\nÚltimo erro: ${saudeIA.ultimoErro} em ${saudeIA.ultimoErroEm.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '') +
        (saudeIA.limite ? `\n⚠️ A chave do Gemini está batendo no limite de uso: parte das análises e vistorias pode estar se perdendo.` : '') +
        (saudeIA.semCredito ? `\n🚨 *Créditos do Gemini esgotados* (desde ${saudeIA.semCredito.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}). Recarregue no AI Studio → Billing.` : '')
      );
      return true;
    }

    case 'identificar':
    case 'outros': {
      if (!resto) {
        const n = await perguntarNaoIdentificados({ reperguntar: true });
        if (!n) await reply('🎉 Todos os grupos estão identificados.');
        return true;
      }
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

async function estudarCondo(condo, dias, reply) {
  const lista = await getList('test_condos');
  if (!lista.includes(condo.condo_key)) await setSetting('test_condos', JSON.stringify([...lista, condo.condo_key]));
  const d = dias ?? Number(process.env.ESTUDO_DIAS || 7);
  await iniciarEstudo(condo.condo_key, d);
  if (reply) await reply(`🎓 *${condo.condo_name}*: estudando por ${d} dia(s). Lendo o que já foi conversado nos grupos…`);
  const h = await importarHistorico(condo.condo_key);
  const a = await aprenderTudo(condo.condo_key);
  const s = await resumoCondo(condo.condo_key);
  if (reply) {
    await reply(
      `📚 *${condo.condo_name}*\n📨 ${h.novas} mensagens anteriores importadas (${h.grupos} grupo(s))\n` +
      `🧠 ${s.fatos} fatos na base (+${a.novos})\n🎓 ${s.exemplos} respostas da equipe aprendidas\n\n` +
      `Durante o estudo não envio sugestões deste condomínio. Ao final aviso aqui.\nPara liberar antes: !estudo liberar ${condo.condo_name}`
    );
  }
}

async function mensagensEstudo() {
  const l = await listarEstudos();
  if (!l.length) return ['🎓 Nenhum condomínio em estudo. Todos os condomínios do teste já estão enviando sugestões.'];
  const linhas = l.map((e) => {
    const fim = e.fim.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `• *${e.nome}* até ${fim}\n   📨 ${e.msgs} msgs · 🧠 ${e.fatos} fatos · 🎓 ${e.exemplos} exemplos`;
  });
  return [`🎓 *Em estudo (${l.length})*\n\n${linhas.join('\n')}\n\nPara liberar antes: !estudo liberar Nome`];
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
