// Todas as configurações vêm das variáveis de ambiente (Railway → Variables).
function req(nome) {
  const v = process.env[nome];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${nome}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: req('DATABASE_URL'),

  // Evolution API
  evolutionUrl: req('EVOLUTION_API_URL').replace(/\/$/, ''),
  evolutionKey: req('EVOLUTION_API_KEY'),
  instance: req('EVOLUTION_INSTANCE'),

  // Segurança do webhook: a URL fica /webhook/<token>
  webhookToken: req('WEBHOOK_TOKEN'),

  // Gemini
  geminiKey: req('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  // Comportamento
  defaultMode: process.env.DEFAULT_MODE || 'teste',          // teste | producao
  debounceSeconds: Number(process.env.DEBOUNCE_SECONDS || 90), // espera a pessoa terminar de escrever
  pendingHours: Number(process.env.PENDING_HOURS || 48),
  retentionDays: Number(process.env.RETENTION_DAYS || 90),     // LGPD: apaga mensagens antigas
  contextMessages: Number(process.env.CONTEXT_MESSAGES || 100),        // histórico do próprio grupo
  internalDays: Number(process.env.INTERNAL_CONTEXT_DAYS || 15),         // grupos de síndico/conselho: quantos dias
  internalMessages: Number(process.env.INTERNAL_CONTEXT_MESSAGES || 100), // e no máximo quantas mensagens

  // Números (ou LIDs) da equipe Alpha. Respostas deles fecham pendências e eles podem usar comandos.
  // Quem envia o primeiro !aqui é cadastrado automaticamente, não precisa estar aqui.
  equipe: (process.env.EQUIPE_NUMEROS || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),
};
