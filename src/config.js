import 'dotenv/config';

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Variável de ambiente ${key} não definida`);
  return value;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  webhookToken: required('WEBHOOK_TOKEN'),
  databaseUrl: required('DATABASE_URL'),
  pgSsl: process.env.PGSSL === 'true',
  evolution: {
    url: required('EVOLUTION_URL').replace(/\/$/, ''),
    apiKey: required('EVOLUTION_API_KEY'),
    instance: required('EVOLUTION_INSTANCE'),
  },
  gemini: {
    apiKey: required('GEMINI_API_KEY'),
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  ownerName: process.env.OWNER_NAME || 'Administração',
  contextSize: Number(process.env.CONTEXT_SIZE || 15),
  minChars: Number(process.env.MIN_CHARS || 4),
  pendingHours: Number(process.env.PENDING_HOURS || 48),
  retentionDays: Number(process.env.RETENTION_DAYS || 90),
  maxConcurrent: Number(process.env.MAX_CONCURRENT || 3),
  defaultMode: process.env.DEFAULT_MODE === 'producao' ? 'producao' : 'teste',
  crossContextSize: Number(process.env.CROSS_CONTEXT_SIZE || 10),
};
