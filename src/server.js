import Fastify from 'fastify';
import fs from 'node:fs';
import { db } from './db.js';
import { config, dateInTz } from './config.js';
import { isDayComplete } from './completeness.js';

export function buildServer() {
  const app = Fastify({ logger: false });

  // Autenticação simples por Bearer token (pule em /health)
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path === '/' || path === '/health' || !config.apiToken) return; // a página em si é pública; os dados exigem token
    if (req.headers.authorization !== `Bearer ${config.apiToken}`) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // Painel web (arquivo único, sem dependências)
  app.get('/', async (req, reply) => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(html);
  });

  app.get('/health', async () => ({ ok: true }));

  // Resumo de hoje: kWh do dia, potência atual, comparação com a média dos 7 dias anteriores
  app.get('/api/today', async () => {
    const today = dateInTz(0);
    const daily = db.prepare('SELECT kwh FROM daily WHERE date = ?').get(today);
    const last = db.prepare('SELECT ts, power_w FROM readings ORDER BY ts DESC LIMIT 1').get();
    const avg7 = db
      .prepare('SELECT AVG(kwh) AS avg FROM (SELECT kwh FROM daily WHERE date < ? ORDER BY date DESC LIMIT 7)')
      .get(today)?.avg ?? null;
    const kwh = daily?.kwh ?? null;
    const devices = db
      .prepare('SELECT device_type AS type, device_sn AS sn, kwh FROM device_daily WHERE date = ? ORDER BY kwh DESC')
      .all(today);
    return {
      date: today,
      kwh,
      devices,
      incomplete: isDayComplete(today) === false,
      currentPowerW: last?.power_w ?? null,
      lastReadingAt: last?.ts ?? null,
      avg7dKwh: avg7,
      vsAvg7dPercent: kwh != null && avg7 ? Math.round(((kwh - avg7) / avg7) * 1000) / 10 : null,
    };
  });

  // Últimos N dias (para o gráfico de barras do app)
  app.get('/api/days', async (req) => {
    const limit = Math.min(Number(req.query.limit) || 30, 366);
    const rows = db.prepare('SELECT date, kwh FROM daily ORDER BY date DESC LIMIT ?').all(limit);
    return rows.reverse();
  });

  // Curva de potência de um dia (padrão: hoje) — para o gráfico intradiário
  app.get('/api/power', async (req) => {
    const date = req.query.date || dateInTz(0);
    const rows = db
      .prepare(`SELECT ts, power_w FROM readings
                WHERE date(ts / 1000, 'unixepoch', 'localtime') = ? ORDER BY ts`)
      .all(date);
    return rows;
  });

  return app;
}
