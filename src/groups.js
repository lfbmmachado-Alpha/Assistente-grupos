// Classifica um grupo pelo nome, seguindo o padrão da Alpha:
//   moradores: "Condominio Belinha Ferrari", "Cond. Ametista", "Edifício X"
//   síndico:   "Sindico-Belinha Ferrari", "Sind-Ametista", "Síndico Ametista"
//   conselho:  "Conselho-Belinha Ferrari", "Conselho fiscal Belinha"
// O condomínio é o que sobra depois do prefixo, normalizado (sem acento, minúsculo).

export function normalize(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const REGRAS = [
  { kind: 'sindico',   re: /^\s*s[ií]nd(ico)?\.?(?=[\s\-–:_|])\s*[-–:_|]?\s*/i },
  { kind: 'conselho',  re: /^\s*conselho(\s+fiscal|\s+consultivo)?\s*[-–:_|]?\s*/i },
  { kind: 'moradores', re: /^\s*(cond(om[ií]nio)?|ed(if[ií]cio)?|residencial)\.?(?=[\s\-–:_|])\s*((do|da|de)\s+)?(ed(if[ií]cio)?\.?\s*)?[-–:_|]?\s*/i },
];

// Palavras que não ajudam a identificar o condomínio
const RUIDO = /\b(do|da|de|dos|das|edificio|ed|condominio|cond|residencial|moradores|oficial|grupo)\b/g;

export function classifyGroup(name) {
  for (const { kind, re } of REGRAS) {
    if (re.test(name)) {
      const resto = name.replace(re, '');
      const condo_name = resto.trim().replace(/\s+/g, ' ');
      const condo_key = normalize(condo_name).replace(RUIDO, ' ').replace(/\s+/g, ' ').trim();
      if (condo_key.length >= 3) return { kind, condo_key, condo_name };
    }
  }
  return { kind: 'outro', condo_key: null, condo_name: null };
}
