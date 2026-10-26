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
const PALAVRAS_RUIDO = 'do|da|de|dos|das|edificio|ed|condominio|cond|residencial|moradores|morador|oficial|grupo|importante|avisos|aviso|comunicados|comunicado|informativo|informativos|informacoes|geral|adm|admin';
const RUIDO = new RegExp(`\\b(${PALAVRAS_RUIDO})\\b`, 'g');
// Remove do nome exibido as palavras de ruído no final ("Cristiana - Importante" → "Cristiana")
const RUIDO_FINAL = /[\s\-–:_|.()]*\b(importante|avisos?|comunicados?|informativos?|oficial|geral|moradores?)\b[\s\-–:_|.()]*$/i;

export function classifyGroup(name) {
  for (const { kind, re } of REGRAS) {
    if (re.test(name)) {
      const resto = name.replace(re, '');
      let condo_name = resto.trim().replace(/\s+/g, ' ');
      for (let i = 0; i < 3 && RUIDO_FINAL.test(condo_name); i++) condo_name = condo_name.replace(RUIDO_FINAL, '');
      condo_name = condo_name.replace(/[\s\-–:_|.]+$/, '');
      const condo_key = normalize(condo_name).replace(RUIDO, ' ').replace(/\s+/g, ' ').trim();
      if (condo_key.length >= 3) return { kind, condo_key, condo_name };
    }
  }
  return { kind: 'outro', condo_key: null, condo_name: null };
}

// Liga grupos de nomes um pouco diferentes ao mesmo condomínio:
// "Sind-Cristiana" e "Condominio Cristiana Importante" → mesma chave, se as palavras de um contêm as do outro.
export function unificar(cls, existentes) {
  if (!cls.condo_key) return cls;
  if (existentes.some((c) => c.condo_key === cls.condo_key)) return cls;
  const meu = cls.condo_key.split(' ');
  const candidatos = existentes.filter((c) => {
    const outro = c.condo_key.split(' ');
    const [menor, maior] = meu.length <= outro.length ? [meu, outro] : [outro, meu];
    return menor.join('').length >= 3 && menor.every((p) => maior.includes(p));
  });
  if (candidatos.length !== 1) return cls;
  return { ...cls, condo_key: candidatos[0].condo_key, condo_name: candidatos[0].condo_name };
}
