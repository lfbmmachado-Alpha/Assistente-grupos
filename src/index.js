import express from 'express';
import { config } from './config.js';
import { initDb, purgeOld } from './db.js';
import { handleWebhook } from './handler.js';
import { initKnowledge, aprender } from './knowledge.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/', (_req, res) => res.send('assistente-grupos ok'));

// Aceita /webhook/<token> e /webhook/<token>/<evento> (caso "Webhook by events" esteja ligado)
app.post(['/webhook/:token', '/webhook/:token/:event'], (req, res) => {
  if (req.params.token !== config.webhookToken) return res.sendStatus(401);
  res.sendStatus(200); // responde na hora para a Evolution não reenviar
  const body = req.body || {};
  if (req.params.event && !body.event) body.event = req.params.event;
  handleWebhook(body).catch((err) => console.error('[webhook]', err));
});

await initDb();
await initKnowledge();

// LGPD: apaga mensagens mais antigas que RETENTION_DAYS, uma vez por dia
purgeOld(config.retentionDays).catch(() => {});
setInterval(() => purgeOld(config.retentionDays).catch((e) => console.error('[limpeza]', e.message)), 24 * 3600 * 1000);

// Aprendizado: extrai fatos novos das conversas a cada 3 horas (primeira rodada 10 min após iniciar)
const rodarAprendizado = () => aprender().catch((e) => console.error('[aprendizado]', e.message));
setTimeout(rodarAprendizado, 10 * 60 * 1000);
setInterval(rodarAprendizado, 3 * 3600 * 1000);

app.listen(config.port, () => console.log(`assistente-grupos ouvindo na porta ${config.port}`));
