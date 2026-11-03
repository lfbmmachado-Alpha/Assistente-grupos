// Perguntas do Luiz sobre um condomínio: responde com base nas conversas, na base de conhecimento e nos documentos.
import { pool } from './db.js';
import { gerarJSON } from './gemini.js';
import { fatosDo, docsDo } from './knowledge.js';

const q = (sql, params) => pool.query(sql, params);

const INSTR = `Você é o assistente interno de Luiz Felipe, da Alpha Condomínios. Ele vai te fazer perguntas sobre um condomínio
para saber o que está acontecendo. Responda com base SOMENTE no material fornecido (conversas dos grupos, base de conhecimento e documentos).
- Seja direto e organizado, em português do Brasil, formatado para WhatsApp (use *negrito* e listas com •, sem tabelas).
- Cite datas e quem disse quando for relevante ("em 28/10 o síndico pediu...").
- Aponte pendências, cobranças sem resposta, reclamações repetidas e o clima do grupo quando fizer sentido.
- Se a informação não estiver no material, diga claramente que ainda não sabe e o que seria preciso para saber.
- Pode incluir dados internos (é só para o Luiz).
Responda SOMENTE com JSON: {"resposta": "..."}`;

const ORIGEM = { moradores: 'moradores', sindico: 'síndico', conselho: 'conselho', privado: 'privado' };

export async function perguntar(condo, pergunta, dias = 30) {
  const msgs = (await q(
    `SELECT m.*, c.kind AS chat_kind FROM messages m JOIN chats c ON c.jid = m.chat_jid
     WHERE c.condo_key = $1 AND m.ts > now() - ($2 || ' days')::interval ORDER BY m.ts DESC LIMIT 1500`,
    [condo.condo_key, String(dias)]
  )).rows.reverse();
  const fatos = await fatosDo(condo.condo_key);
  const docs = await docsDo(condo.condo_key);
  const linhas = msgs.map((m) => {
    const quando = new Date(m.ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const quem = m.from_me ? `EQUIPE ALPHA (${m.author_name || ''})` : m.author_name || 'Participante';
    return `[${quando}] (${ORIGEM[m.chat_kind] || m.chat_kind}) ${quem}: ${m.text}`;
  });
  const hoje = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const entrada =
    `HOJE: ${hoje}\nCONDOMÍNIO: ${condo.condo_name}\n\nPERGUNTA DO LUIZ: ${pergunta}\n\n` +
    `BASE DE CONHECIMENTO:\n${fatos.map((f) => `- ${f.fato}`).join('\n') || '(vazia)'}\n\n` +
    (docs.length ? `DOCUMENTOS:\n${docs.map((d) => `=== ${d.titulo} ===\n${d.texto.slice(0, 60000)}`).join('\n\n')}\n\n` : '') +
    `CONVERSAS DOS ÚLTIMOS ${dias} DIAS (${msgs.length} mensagens):\n${linhas.join('\n') || '(nenhuma)'}`;
  const r = await gerarJSON(INSTR, entrada);
  return { resposta: r?.resposta || 'Não consegui montar a resposta.', mensagens: msgs.length };
}
