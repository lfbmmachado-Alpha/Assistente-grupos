// Casa o nome de um condomínio da planilha com o nome que ele tem nos grupos,
// tolerando abreviações (D. → Dona, SL → Solar, Jd → Jardim), nomes cortados (Jabutic → Jabuticabeiras),
// erros de digitação (Jeferson → Jefferson) e espaços (Green Ville → Greenville).
import { normalize } from './groups.js';

const RUIDO = new Set(['do', 'da', 'de', 'dos', 'das', 'e', 'ed', 'edificio', 'cond', 'condominio', 'residencial', 'res',
  'moradores', 'morador', 'oficial', 'grupo', 'importante', 'avisos', 'aviso', 'comunicados', 'alpha', 'bhmg', 'if', 'jd', 'jardim']);

export function tokens(nome) {
  return normalize(nome).split(' ').filter((t) => t && !RUIDO.has(t));
}

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// "sl" ~ "solar", "d" ~ "dona": abreviação = mesma inicial e letras na ordem
function abrev(curto, longo) {
  if (curto.length > 3 || curto.length >= longo.length || curto[0] !== longo[0]) return false;
  let i = 0;
  for (const ch of longo) if (ch === curto[i]) i++;
  return i === curto.length;
}

function parecido(a, b) {
  if (a === b) return 3;
  if (/^\d+$|^[ivx]+$/.test(a) || /^\d+$|^[ivx]+$/.test(b)) return 0; // números/romanos só exatos (Viena B ≠ Viena C, Augustus I ≠ II)
  if (a.length === 1 || b.length === 1) return a.length === 1 && b.length === 1 ? 0 : (abrev(a, b) || abrev(b, a) ? 1 : 0);
  const [c, l] = a.length <= b.length ? [a, b] : [b, a];
  if (c.length >= 5 && l.startsWith(c)) return 2;       // nome cortado
  if (abrev(c, l)) return 1;
  const tol = l.length >= 9 ? 2 : l.length >= 7 ? 1 : 0; // palavras curtas só exatas (Leste ≠ Teste)
  return lev(a, b) <= tol ? 2 : 0;
}

// Pontua o quanto o nome A e o nome B são o mesmo condomínio (0 = não é)
export function pontuar(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const ja = ta.join(''), jb = tb.join('');
  if (ja === jb) return 100;
  if (ja.length >= 6 && lev(ja, jb) <= (Math.max(ja.length, jb.length) >= 10 ? 2 : 1)) return 90; // Green Ville ~ Greenville, Montmarte ~ Mont Martre
  // o lado com menos palavras precisa ter todas casadas no outro
  const [menor, maior] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  let soma = 0;
  const usados = new Set();
  for (const t of menor) {
    let melhor = 0, idx = -1;
    maior.forEach((u, i) => { if (!usados.has(i)) { const p = parecido(t, u); if (p > melhor) { melhor = p; idx = i; } } });
    if (!melhor) return 0;
    usados.add(idx);
    soma += melhor;
  }
  if (menor.join('').length < 3) return 0;
  return 40 + soma * 5 - (maior.length - menor.length) * 3;
}

// Melhor candidato único. lista: [{condo_key, condo_name}]. Devolve o item ou null.
export function melhorCasamento(nome, lista, concorrentes = []) {
  const notas = lista.map((c) => ({ c, n: pontuar(nome, c.condo_name || c.condo_key) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  // descarta grupos que outro nome da planilha casa melhor ("Minas" x "Minas das Esmeraldas")
  const livres = notas.filter((x) => !concorrentes.some((o) => o !== nome && pontuar(o, x.c.condo_name || x.c.condo_key) > x.n));
  if (!livres.length) return null;
  if (livres.length > 1 && livres[0].n === livres[1].n) return null; // empate: não arrisca
  return livres[0].c;
}
