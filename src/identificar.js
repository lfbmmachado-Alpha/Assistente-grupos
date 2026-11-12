// Identificação de grupos fora do padrão: a IA adivinha (planilha + nome do grupo) e pergunta.
// Você responde a mensagem dela com "sim", com o nome certo ("torino síndico") ou "não é condomínio".
import { pool, getSetting, setSetting, listCondos } from './db.js';
import { gerarJSON } from './gemini.js';
import { normalize, classifyGroup } from './groups.js';
import { sendToSuggestionGroup } from './util.js';

const q = (sql, params) => pool.query(sql, params);
const ICONE = { moradores: '👥', sindico: '🧑‍💼', conselho: '📊' };
const NOME_TIPO = { moradores: 'moradores', sindico: 'síndico', conselho: 'conselho' };

async function getPerguntas() {
  try { return JSON.parse(await getSetting('identificar', '{}')); } catch { return {}; }
}

// Todos os nomes conhecidos: condomínios dos grupos + planilha de vistorias
async function nomesConhecidos() {
  const mapa = new Map();
  for (const c of await listCondos()) mapa.set(c.condo_key, c.condo_name);
  const cart = (await q(`SELECT condo_nome, condo_key FROM carteira WHERE ativo`).catch(() => ({ rows: [] }))).rows;
  for (const c of cart) if (c.condo_key && !mapa.has(c.condo_key)) mapa.set(c.condo_key, c.condo_nome);
  return [...mapa].map(([condo_key, condo_name]) => ({ condo_key, condo_name }));
}

function tipoPelasPalavras(nome) {
  const n = normalize(nome);
  if (/\bsind/.test(n) || /\bgestao\b|\badm\b|\binterno\b/.test(n)) return 'sindico';
  if (/\bconselh/.test(n)) return 'conselho';
  return 'moradores';
}

// 1º tenta pela planilha/nomes conhecidos (palavras do condomínio aparecem no nome do grupo); depois pergunta ao Gemini
async function adivinhar(nomeGrupo, conhecidos) {
  const palavras = new Set(normalize(nomeGrupo).split(' '));
  const achados = conhecidos.filter((c) => {
    const p = c.condo_key.split(' ').filter(Boolean);
    return p.length && p.join('').length >= 3 && p.every((x) => palavras.has(x));
  });
  // prefere o nome mais completo ("Minas das Esmeraldas" em vez de "Minas")
  achados.sort((a, b) => b.condo_key.length - a.condo_key.length);
  if (achados.length) return { ...achados[0], kind: tipoPelasPalavras(nomeGrupo), fonte: 'nome' };

  try {
    const r = await gerarJSON(
      `Você identifica grupos de WhatsApp de uma administradora de condomínios. Dado o nome do grupo e a lista de condomínios,
diga a qual condomínio ele pertence e o tipo: "moradores" (grupo geral do condomínio), "sindico" (grupo interno com o síndico/gestão)
ou "conselho". Se claramente não for de condomínio (família, amigos, fornecedor, equipe interna), use condominio "".
Responda SOMENTE JSON: {"condominio": "nome exatamente como na lista, ou vazio", "tipo": "moradores|sindico|conselho"}`,
      `GRUPO: ${nomeGrupo}\n\nCONDOMÍNIOS:\n${conhecidos.map((c) => c.condo_name).join('\n')}`
    );
    const c = conhecidos.find((x) => normalize(x.condo_name) === normalize(r?.condominio || ''));
    if (c) return { ...c, kind: ['moradores', 'sindico', 'conselho'].includes(r.tipo) ? r.tipo : tipoPelasPalavras(nomeGrupo), fonte: 'ia' };
  } catch (e) {
    console.error('[identificar]', e.message);
  }
  return null;
}

// Pergunta sobre cada grupo fora do padrão que ainda não foi perguntado (ou todos, se reperguntar)
export async function perguntarNaoIdentificados({ reperguntar = false } = {}) {
  const grupos = (await q(`SELECT jid, name FROM chats WHERE kind = 'outro' AND COALESCE(ativo, TRUE) ORDER BY name`)).rows;
  const perg = await getPerguntas();
  const jaPerguntados = new Set(Object.values(perg).map((p) => p.jid));
  const pendentes = grupos.filter((g) => reperguntar || !jaPerguntados.has(g.jid));
  if (!pendentes.length) return 0;

  if (reperguntar) for (const id of Object.keys(perg)) delete perg[id]; // recomeça a numeração do 1
  const conhecidos = await nomesConhecidos();
  let numero = Math.max(0, ...Object.values(perg).map((p) => p.n || 0));
  const linhas = [];
  for (const g of pendentes) {
    numero++;
    const palpite = await adivinhar(g.name || '', conhecidos);
    perg[`n${numero}`] = { jid: g.jid, nome: g.name, palpite, n: numero };
    linhas.push(
      `*${numero}.* ${g.name || g.jid}\n` +
      (palpite ? `     → ${ICONE[palpite.kind]} ${NOME_TIPO[palpite.kind]} do *${palpite.condo_name}*?` : `     → ❓ não sei`)
    );
  }
  const cab = `❔ *${pendentes.length} grupo(s) para identificar*\n\n`;
  const rod =
    `\n\n*Responda numa mensagem só*, uma linha por grupo:\n` +
    `_1 sim_ → meu palpite está certo\n_2 torino síndico_ → nome e tipo certos\n_3 não_ → não é condomínio`;
  // uma mensagem só (divide apenas se for enorme)
  const blocos = [];
  let atual = cab;
  for (const l of linhas) {
    if ((atual + l).length > 3300) { blocos.push(atual); atual = ''; }
    atual += (atual && atual !== cab ? '\n\n' : '') + l;
  }
  blocos.push(atual + rod);
  for (const b of blocos) await sendToSuggestionGroup(b);
  await setSetting('identificar', JSON.stringify(perg));
  return pendentes.length;
}

// Resposta do Luiz: "1 sim" / "2 torino síndico" / "3 não" (uma ou várias linhas), ou citando a pergunta.
export async function tratarResposta(msg) {
  const perg = await getPerguntas();
  if (!Object.keys(perg).length) return false;
  if (msg.quotedId && perg[msg.quotedId] && !/^\s*\d+\s/.test(msg.text)) {
    await responderUma(msg.quotedId, msg.text);
    return true;
  }
  const linhas = msg.text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const itens = linhas.map((l) => l.match(/^(\d+)[\s.)\-:]+(.+)$/)).filter(Boolean);
  // Só um grupo pendente: aceita a resposta sem número ("sim", "não", "torino síndico")
  const ids = Object.keys(perg);
  if (!itens.length && ids.length === 1 && linhas.length === 1 && linhas[0].length <= 40 && !linhas[0].includes('?') &&
      /^(sim|s|ok|certo|nao|não|n)\b|\b(s[ií]ndico|moradores?|conselho)\b/i.test(linhas[0])) {
    await responderUma(ids[0], linhas[0]);
    return true;
  }
  if (!itens.length) return false;
  for (const [, num, resposta] of itens) {
    const id = Object.keys(perg).find((k) => perg[k].n === Number(num));
    if (!id) { await sendToSuggestionGroup(`Não achei a pergunta *${num}*. Envie !identificar para ver a lista atual.`); continue; }
    await responderUma(id, resposta);
  }
  return true;
}

async function responderUma(perguntaId, texto) {
  const perg = await getPerguntas();
  const p = perg[perguntaId];
  if (!p) return;
  const msg = { text: texto, quotedId: perguntaId };

  const t = normalize(msg.text);
  let kind, condo_key, condo_name;
  if (/^(nao|n|ignorar|ignora|nao e condominio|nenhum)\b/.test(t)) {
    await q(`UPDATE chats SET kind = 'ignorado', manual = TRUE WHERE jid = $1`, [p.jid]);
    delete perg[msg.quotedId];
    await setSetting('identificar', JSON.stringify(perg));
    await sendToSuggestionGroup(`🚫 ${p.n}. Ok, vou ignorar o grupo *${p.nome}*.`);
    return;
  }
  if (/^(sim|s|ok|isso|certo|correto|confirmo|exato|yes)\b/.test(t)) {
    if (!p.palpite) {
      await sendToSuggestionGroup(`${p.n}. Para o grupo *${p.nome}* eu não tinha palpite. Responda com o nome e o tipo, ex.: _${p.n} torino síndico_.`);
      return;
    }
    ({ kind, condo_key, condo_name } = p.palpite);
  } else {
    // "torino síndico" / "síndico do torino" / "torino"
    kind = /\bsind/.test(t) ? 'sindico' : /\bconselh/.test(t) ? 'conselho' : /\bmorador/.test(t) ? 'moradores' : p.palpite?.kind || 'moradores';
    const nome = t.replace(/\b(sindicos?|sindico|conselho( fiscal)?|moradores?|grupo|do|da|de|e|o|a|tipo)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!nome) {
      if (!p.palpite) { await sendToSuggestionGroup(`${p.n}. Faltou o nome do condomínio. Ex.: _${p.n} torino síndico_.`); return; }
      ({ condo_key, condo_name } = p.palpite);
    } else {
      const conhecidos = await nomesConhecidos();
      const chave = classifyGroup(`Condominio ${nome}`).condo_key || nome;
      const exato = conhecidos.find((c) => c.condo_key === chave);
      const parciais = conhecidos.filter((c) => c.condo_key.includes(chave) || chave.includes(c.condo_key));
      const achado = exato || (parciais.length === 1 ? parciais[0] : null);
      if (!achado && parciais.length > 1) {
        await sendToSuggestionGroup(`${p.n}. Encontrei mais de um: ${parciais.slice(0, 10).map((c) => c.condo_name).join(', ')}.\nResponda de novo com o nome mais completo, ex.: _${p.n} ${parciais[0].condo_name.toLowerCase()} moradores_.`);
        return;
      }
      condo_key = achado?.condo_key || chave;
      condo_name = achado?.condo_name || msg.text.replace(/\b(s[ií]ndicos?|conselho( fiscal)?|moradores?)\b/gi, '').trim();
    }
  }

  await q(`UPDATE chats SET kind = $2, condo_key = $3, condo_name = $4, manual = TRUE WHERE jid = $1`, [p.jid, kind, condo_key, condo_name]);
  delete perg[msg.quotedId];
  await setSetting('identificar', JSON.stringify(perg));
  const faltam = Object.keys(perg).length;
  if (p.corrigir) {
    await sendToSuggestionGroup(`✅ ${p.n}. *${p.nome}* → ${ICONE[kind]} ${NOME_TIPO[kind]} do *${condo_name}*`);
    return;
  }
  await sendToSuggestionGroup(`✅ ${p.n}. *${p.nome}* → ${ICONE[kind]} ${NOME_TIPO[kind]} do *${condo_name}*` + (faltam ? `  (faltam ${faltam})` : '\n\n🎉 Todos os grupos identificados.'));
}

// ---------- lista de vinculações e correção direta ----------
let ultimaLista = [];
let ultimaListaTs = 0;

// todos=false: só os sem vínculo, com a resposta pronta para copiar, editar e devolver
export async function listarVinculos({ todos = false } = {}) {
  const todosGrupos = (await q(
    `SELECT jid, name, kind, condo_key, condo_name FROM chats
     WHERE kind <> 'privado' AND COALESCE(ativo, TRUE)
     ORDER BY CASE WHEN kind IN ('moradores','sindico','conselho') THEN 0 WHEN kind = 'outro' THEN 1 ELSE 2 END,
              condo_name NULLS LAST, kind, name`
  )).rows;
  const vinc = todosGrupos.filter((g) => ICONE[g.kind]).length;
  const sem = todosGrupos.filter((g) => g.kind === 'outro');
  const ign = todosGrupos.filter((g) => g.kind === 'ignorado').length;
  const resumo = `✅ ${vinc} vinculados · ❔ ${sem.length} sem vínculo · 🚫 ${ign} ignorados`;

  ultimaListaTs = Date.now();
  if (!todos) {
    ultimaLista = sem;
    await setSetting('identificar', '{}'); // as perguntas antigas viram esta lista
    if (!sem.length) return [`🔗 *Vinculações*\n${resumo}\n\n🎉 Nenhum grupo sem vínculo.\n\nPara ver todos: *!vinculos todos*`];
    const conhecidos = await nomesConhecidos();
    const linhas = [];
    const pronta = [];
    for (let i = 0; i < sem.length; i++) {
      const g = sem[i];
      const p = await adivinhar(g.name || '', conhecidos);
      linhas.push(`*${i + 1}.* ${g.name || g.jid}\n     → ${p ? `${ICONE[p.kind]} ${NOME_TIPO[p.kind]} do *${p.condo_name}*?` : '❓ não sei'}`);
      pronta.push(`${i + 1} ${p ? `${p.condo_name.toLowerCase()} ${NOME_TIPO[p.kind]}` : 'NOME tipo'}`);
    }
    return [
      `🔗 *Grupos sem vínculo (${sem.length})*\n${resumo}\n\n${linhas.join('\n')}\n\n` +
      `👇 Na próxima mensagem vai a resposta pronta. *Copie, corrija o que estiver errado e me envie de volta.*\n` +
      `Tipos: *moradores*, *síndico*, *conselho* ou *não* (não é condomínio). Nomes certos: *!modelos*`,
      `✏️ Resposta pronta (copie, corrija e envie):\n${pronta.join('\n')}`,
    ];
  }

  ultimaLista = todosGrupos;
  const linhas = todosGrupos.map((g, i) => {
    const n = i + 1;
    if (ICONE[g.kind]) return `*${n}.* ${g.name || g.jid}\n     → ${ICONE[g.kind]} ${NOME_TIPO[g.kind]} do *${g.condo_name}*`;
    if (g.kind === 'ignorado') return `*${n}.* ${g.name || g.jid}\n     → 🚫 ignorado (não é condomínio)`;
    return `*${n}.* ${g.name || g.jid}\n     → ❔ não identificado`;
  });
  const cab = `🔗 *Todas as vinculações (${todosGrupos.length} grupos)*\n${resumo}\n\n`;
  const rod = `\n\n*Para corrigir*, mande o número e o certo (uma linha por grupo):\n_!vinculo 5 torino síndico_ · _!vinculo 7 não_`;
  const blocos = [];
  let atual = cab;
  for (const l of linhas) {
    if ((atual + l).length > 3300) { blocos.push(atual); atual = ''; }
    atual += (atual && atual !== cab ? '\n' : '') + l;
  }
  blocos.push(atual + rod);
  return blocos;
}

// Guia: modelos de comando, tipos aceitos e os nomes de condomínio válidos
export async function modelos() {
  const nomes = (await nomesConhecidos()).map((c) => c.condo_name).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const guia =
    `📘 *Modelos para vincular grupos*\n\n` +
    `*1.* Veja o que falta: *!vinculos*\n` +
    `*2.* Copie a resposta pronta que eu mando, corrija e envie de volta.\n\n` +
    `*Formato:* !vinculo NÚMERO NOME TIPO\n` +
    `• _!vinculo 1 torino moradores_\n• _!vinculo 2 torino síndico_\n• _!vinculo 3 floresta conselho_\n• _!vinculo 4 não_  (não é condomínio)\n\n` +
    `*Tipos:*\n👥 *moradores* — grupo geral do condomínio\n🧑‍💼 *síndico* — grupo interno com o síndico\n📊 *conselho* — grupo do conselho\n🚫 *não* — não é de condomínio\n\n` +
    `*Nome:* pode ser parte do nome, sem acento (ex.: _helena_, _jabuticabeiras_). Os nomes válidos vão na próxima mensagem.\n\n` +
    `*Ver tudo:* !vinculos todos`;
  const lista = `🏢 *Nomes de condomínio (${nomes.length})*\n${nomes.join('\n')}`;
  return [guia, lista.slice(0, 3900)];
}

// Resposta à lista (sem "!"): linhas "1 torino moradores". Vale por 2 horas depois do !vinculos.
export async function respostaVinculos(texto) {
  if (!ultimaLista.length || Date.now() - ultimaListaTs > 2 * 3600 * 1000) return false;
  const linhas = texto.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (!linhas.some((l) => /^\d+[\s.)\-:]+\S/.test(l))) return false;
  await corrigirVinculos(texto, { silencioso: true });
  return true;
}

// "!vinculo 5 torino síndico" ou "5 torino síndico" (aceita várias linhas)
export async function corrigirVinculos(texto, { silencioso = false } = {}) {
  if (!ultimaLista.length) await listarVinculos({ todos: true }); // garante a numeração
  const linhas = texto.split(/\n+/).map((l) => l.replace(/^!v[ií]nculos?\s*/i, '').trim()).filter(Boolean);
  let feitos = 0;
  for (const l of linhas) {
    const m = l.match(/^(\d+)[\s.)\-:]+(.+)$/);
    if (!m) { if (!silencioso) await sendToSuggestionGroup(`Não entendi "${l}". Use: _!vinculo 5 torino síndico_`); continue; }
    if (/^nome tipo$/i.test(m[2].trim())) { await sendToSuggestionGroup(`${m[1]}. Faltou trocar "NOME tipo" pelo condomínio, ex.: _${m[1]} torino moradores_.`); continue; }
    const g = ultimaLista[Number(m[1]) - 1];
    if (!g) { await sendToSuggestionGroup(`Não existe o número ${m[1]}. Mande !vinculos para ver a lista.`); continue; }
    const perg = await getPerguntas();
    const id = `v${m[1]}`;
    perg[id] = { jid: g.jid, nome: g.name, palpite: null, n: Number(m[1]), corrigir: true };
    await setSetting('identificar', JSON.stringify(perg));
    await responderUma(id, m[2]);
    const depois = await getPerguntas();
    if (depois[id]) { delete depois[id]; await setSetting('identificar', JSON.stringify(depois)); }
    feitos++;
  }
  return feitos;
}
