// Previsão/histórico de radiação solar via Open-Meteo (gratuito, sem chave) e
// estimativa de geração calibrada com o SEU histórico (kWh gerados por kWh/m² de radiação).
import { config, dateInTz } from './config.js';
import { db } from './db.js';

let cache = { at: 0, data: null };

function percentile(sorted, p) {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Relação kWh gerado / kWh/m² de radiação, usando os últimos dias com dados. */
function calibrate(byDay) {
  const today = dateInTz(0);
  const rows = db.prepare('SELECT date, kwh FROM daily WHERE date < ? ORDER BY date DESC LIMIT 45').all(today);
  const ratios = [];
  for (const r of rows) {
    const w = byDay[r.date];
    if (w && w.rad >= 1.5 && r.kwh > 0) ratios.push(r.kwh / w.rad);
  }
  const recent = ratios.slice(0, 30).sort((a, b) => a - b);
  if (recent.length < 7) return null;
  return { k: percentile(recent, 0.5), low: percentile(recent, 0.25), high: percentile(recent, 0.75), n: recent.length };
}

export async function getWeather(maxAgeMs = 30 * 60 * 1000) {
  if (cache.data && Date.now() - cache.at < maxAgeMs) return cache.data;

  const url = new URL('/v1/forecast', config.weatherBaseUrl);
  url.search = new URLSearchParams({
    latitude: String(config.location.lat),
    longitude: String(config.location.lon),
    hourly: 'shortwave_radiation,cloud_cover',
    timezone: config.timezone,
    past_days: '45',
    forecast_days: '3',
  }).toString();

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const j = await res.json();

  const byDay = {};
  j.hourly.time.forEach((t, i) => {
    const [date, hhmm] = t.split('T');
    const h = Number(hhmm.slice(0, 2));
    const day = (byDay[date] ??= { hourly: Array(24).fill(0), cloudSum: 0, cloudN: 0 });
    const rad = Number(j.hourly.shortwave_radiation[i]) || 0;
    day.hourly[h] = rad;
    const cl = j.hourly.cloud_cover?.[i];
    if (rad > 0 && cl != null) { day.cloudSum += cl; day.cloudN++; }
  });
  for (const d of Object.values(byDay)) {
    d.rad = d.hourly.reduce((a, b) => a + b, 0) / 1000; // kWh/m² no dia
    d.cloud = d.cloudN ? Math.round(d.cloudSum / d.cloudN) : null;
  }

  cache = { at: Date.now(), data: { byDay, calib: calibrate(byDay) } };
  return cache.data;
}

/** Geração esperada para uma data (kWh), com faixa; kwh = null se ainda não há histórico para calibrar. */
export function expectedForDate(wx, date) {
  const d = wx.byDay[date];
  if (!d) return null;
  const c = wx.calib;
  return {
    rad: d.rad,
    cloud: d.cloud,
    kwh: c ? d.rad * c.k : null,
    low: c ? d.rad * c.low : null,
    high: c ? d.rad * c.high : null,
    n: c?.n ?? 0,
  };
}

/** Radiação (W/m²) da hora atual, segundo o modelo. */
export function currentRadiation(wx, now) {
  const d = wx.byDay[now.date];
  return d ? d.hourly[Math.floor(now.hour)] : null;
}
