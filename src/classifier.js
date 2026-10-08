/**
 * Identifica o condomínio e o tipo do grupo a partir do nome.
 *   "Condomínio Belinha Ferrari"   → moradores · Belinha Ferrari
 *   "Sindico-Belinha ferrari"      → sindico   · Belinha ferrari
 *   "Sind-Serra do capivari"       → sindico   · Serra do capivari
 *   "Conselho-Serra do Capivari"   → conselho  · Serra do Capivari
 *   "Conselho fiscal"              → conselho  · (sem condomínio → vincular com !vincular)
 * A chave (condoKey) ignora acentos, maiúsculas, pontuação e prefixos, para casar os grupos entre si.
 */

const ROLE = /^\s*(s[ií]ndic[oa]|sind\.?|conselho(?:\s+fiscal)?)(?=[\s\-–—:|]|$)\s*[-–—:|]?\s*/i;
const PREFIX = /^(condom[ií]nio|cond\.?|edif[ií]cio|ed\.?|residencial|res\.?)(\s+d[oae]s?)?\s+/i;

export const KINDS = ['moradores', 'sindico', 'conselho', 'privado', 'outro'];

export const KIND_LABEL = {
  moradores: '👥 Moradores',
  sindico: '🧑‍💼 Síndico',
  conselho: '📊 Conselho',
  privado: '💬 Privado',
  outro: '🗂️ Outro',
};

export function normalize(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function condoFromName(name) {
  let rest = String(name || '').trim();
  let prev;
  do { prev = rest; rest = rest.replace(PREFIX, '').trim(); } while (rest !== prev);
  const key = normalize(rest);
  return { condoName: rest || null, condoKey: key || null };
}

export function classifyGroupName(name) {
  const original = String(name || '').trim();
  let kind = 'moradores';
  let rest = original;
  const m = original.match(ROLE);
  if (m) {
    kind = /^conselho/i.test(m[1]) ? 'conselho' : 'sindico';
    rest = original.slice(m[0].length);
  }
  return { kind, ...condoFromName(rest) };
}
