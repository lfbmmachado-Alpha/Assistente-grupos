import express from 'express';
import { config } from './config.js';
import { initDb, purgeOld } from './db.js';
import { handleWebhook } from './handler.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/', (_req, res) => res.send('assistente-grupos ok'));

// Aceita /webhook/<token> e /webhook/<token>/<evento> (caso o "byEvents" esteja ligado)
app.post(['/webhook/:token', '/webhook/:token/:event'], (req, res) => {
  if (req.params.token !== config.webhookToken) return res.sendStatus(401);
  res.sendStatus(200); // responde rápido para a Evolution não reenviar
  handleWebhook(req.body).catch((err) => console.error('[webhook]', err));
});

await initDb();

// Limpeza diária de mensagens antigas (LGPD: guardar só o necessário)
setInterval(() => {
  purgeOld(config.retentionDays).catch((err) => console.error('[limpeza]', err.message));
}, 24 * 60 * 60 * 1000);

app.listen(config.port, () => console.log(`assistente-grupos ouvindo na porta ${config.port}`));
