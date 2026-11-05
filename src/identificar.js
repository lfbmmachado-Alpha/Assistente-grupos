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
  const grupos = (await q(`SELECT jid, name FROM chats WHERE kind = 'outro' ORDER BY name`)).rows;
  const perg = await getPerguntas();
  const jaPerguntados = new Set(Object.values(perg).map((p) => p.jid));
  const pendentes = grupos.filter((g) => reperguntar || !jaPerguntados.has(g.jid));
  if (!pendentes.length) return 0;

  if (reperguntar) for (const [id, p] of Object.entries(perg)) if (pendentes.some((g) => g.jid === p.jid)) delete perg[id];
  const conhecidos = await nomesConhecidos();
  await sendToSuggestionGroup(
    `❔ *${pendentes.length} grupo(s) não identificado(s)*\n\nVou mandar um por um. *Responda cada mensagem* (arraste para o lado e escreva):\n` +
    `✅ *sim* — se o meu palpite estiver certo\n✏️ *o nome e o tipo* — ex.: _torino síndico_, _cristiana moradores_\n🚫 *não* — se não for grupo de condomínio`
  );
  for (const g of pendentes) {
    const palpite = await adivinhar(g.name || '', conhecidos);
    const texto =
      `❔ *${g.name || g.jid}*\n\n` +
      (palpite
        ? `Acho que é: ${ICONE[palpite.kind]} *${NOME_TIPO[palpite.kind]}* do *${palpite.condo_name}*\n\nResponda *sim*, o nome certo ou *não*.`
        : `Não sei de qual condomínio é.\n\nResponda com o nome e o tipo (ex.: _torino síndico_) ou *não*.`);
    const enviado = await sendToSuggestionGroup(texto);
    const id = enviado?.key?.id;
    if (id) perg[id] = { jid: g.jid, nome: g.name, palpite };
  }
  await setSetting('identificar', JSON.stringify(perg));
  return pendentes.length;
}

// Resposta do Luiz citando uma pergunta. Devolve true se tratou.
export async function tratarResposta(msg) {
  if (!msg.quotedId) return false;
  const perg = await getPerguntas();
  const p = perg[msg.quotedId];
  if (!p) return false;

  const t = normalize(msg.text);
  let kind, condo_key, condo_name;
  if (/^(nao|n|ignorar|ignora|nao e condominio|nenhum)\b/.test(t)) {
    await q(`UPDATE chats SET kind = 'ignorado', manual = TRUE WHERE jid = $1`, [p.jid]);
    delete perg[msg.quotedId];
    await setSetting('identificar', JSON.stringify(perg));
    await sendToSuggestionGroup(`🚫 Ok, vou ignorar o grupo *${p.nome}*.`);
    return true;
  }
  if (/^(sim|s|ok|isso|certo|correto|confirmo|exato|yes)\b/.test(t)) {
    if (!p.palpite) {
      await sendToSuggestionGroup(`Para o grupo *${p.nome}* eu não tinha palpite. Responda com o nome e o tipo, ex.: _torino síndico_.`);
      return true;
    }
    ({ kind, condo_key, condo_name } = p.palpite);
  } else {
    // "torino síndico" / "síndico do torino" / "torino"
    kind = /\bsind/.test(t) ? 'sindico' : /\bconselh/.test(t) ? 'conselho' : /\bmorador/.test(t) ? 'moradores' : p.palpite?.kind || 'moradores';
    const nome = t.replace(/\b(sindicos?|sindico|conselho( fiscal)?|moradores?|grupo|do|da|de|e|o|a|tipo)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!nome) {
      if (!p.palpite) { await sendToSuggestionGroup('Faltou o nome do condomínio. Ex.: _torino síndico_.'); return true; }
      ({ condo_key, condo_name } = p.palpite);
    } else {
      const conhecidos = await nomesConhecidos();
      const chave = classifyGroup(`Condominio ${nome}`).condo_key || nome;
      const exato = conhecidos.find((c) => c.condo_key === chave);
      const parciais = conhecidos.filter((c) => c.condo_key.includes(chave) || chave.includes(c.condo_key));
      const achado = exato || (parciais.length === 1 ? parciais[0] : null);
      if (!achado && parciais.length > 1) {
        await sendToSuggestionGroup(`Encontrei mais de um: ${parciais.slice(0, 10).map((c) => c.condo_name).join(', ')}.\nResponda de novo a pergunta com o nome mais completo.`);
        return true;
      }
      condo_key = achado?.condo_key || chave;
      condo_name = achado?.condo_name || msg.text.replace(/\b(s[ií]ndicos?|conselho( fiscal)?|moradores?)\b/gi, '').trim();
    }
  }

  await q(`UPDATE chats SET kind = $2, condo_key = $3, condo_name = $4, manual = TRUE WHERE jid = $1`, [p.jid, kind, condo_key, condo_name]);
  delete perg[msg.quotedId];
  await setSetting('identificar', JSON.stringify(perg));
  const faltam = Object.keys(perg).length;
  await sendToSuggestionGroup(`✅ *${p.nome}* → ${ICONE[kind]} ${NOME_TIPO[kind]} do *${condo_name}*` + (faltam ? `\n\nFaltam ${faltam}.` : '\n\n🎉 Todos os grupos identificados.'));
  return true;
}
