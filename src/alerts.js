import { db, kvGet, kvSet } from './db.js';
import { config, localNow } from './config.js';
import { sendMessage } from './telegram.js';
import { getWeather, currentRadiation, expectedForDate } from './weather.js';

const nf = (n, d = 1) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const LABEL = { INVERTER: 'Inversor', MICRO_INVERTER: 'Microinversor' };
const STATUS_OK = /grid.?connected|normal|on.?grid|running|connected|generating/i;

async function notify(text) {
  console.log('[alerta]', text.split('\n')[0]);
  if (!config.telegram.token || !config.telegram.chatId) return;
  await sendMessage(text).catch((e) => console.error('[alerta] envio falhou:', e.message));
}

/** Só avisa quando o estado muda (problema apareceu / foi resolvido), para não repetir a cada 10 min. */
async function transition(key, active, textOn, textOff) {
  const prev = kvGet(`alert:${key}`) === '1';
  if (active === prev) return;
  kvSet(`alert:${key}`, active ? '1' : '0');
  const text = active ? textOn : textOff;
  if (text) await notify(text);
}

export async function runAlerts({ at = new Date() } = {}) {
  if (!config.alertsEnabled) return;
  const now = localNow(config.timezone, at);
  const nowMs = at.getTime();

  let wx = null;
  let rad = null;
  try {
    wx = await getWeather();
    rad = currentRadiation(wx, now);
  } catch (e) {
    console.error('[clima] indisponível:', e.message);
  }

  // 1) Dados da usina parados em pleno horário de sol
  if (now.hour >= 9 && now.hour <= 16) {
    const last = db.prepare('SELECT raw FROM readings ORDER BY ts DESC LIMIT 1').get();
    let lut = NaN;
    try { lut = Number(JSON.parse(last?.raw || '{}').lastUpdateTime); } catch { /* raw inválido */ }
    if (Number.isFinite(lut)) {
      const age = Math.round((nowMs / 1000 - lut) / 60);
      await transition(
        'stale',
        age > 60,
        `⚠️ A usina está sem enviar dados há ${age} min, em pleno horário de sol.\nPode ser o Wi-Fi/logger ou o inversor desligado.`,
        '✅ Os dados da usina voltaram a chegar.'
      );
    }
  }

  // 2) e 3) Equipamentos: sem produção com sol forte / status anormal
  if (now.hour >= 10 && now.hour <= 15 && rad != null && rad >= 300) {
    const devs = db
      .prepare('SELECT device_sn, device_type, power_w, status, MAX(ts) AS ts FROM device_readings GROUP BY device_sn')
      .all();
    for (const d of devs) {
      if (nowMs - d.ts > 25 * 60 * 1000) continue; // leitura velha: não opina
      const name = `${LABEL[d.device_type] ?? d.device_type} (${d.device_sn})`;

      if (d.power_w != null && rad >= 500) {
        await transition(
          `zero:${d.device_sn}`,
          d.power_w <= 5,
          `⚠️ ${name} sem produzir (${nf(d.power_w, 0)} W) com sol forte (~${nf(rad, 0)} W/m²).`,
          `✅ ${name} voltou a produzir (${nf(d.power_w / 1000, 2)} kW).`
        );
      }
      if (d.status) {
        await transition(
          `status:${d.device_sn}`,
          !STATUS_OK.test(d.status),
          `⚠️ ${name} com status "${d.status}" em horário de sol.`,
          `✅ ${name} com status normal ("${d.status}").`
        );
      }
    }
  }

  // 4) Fim do dia: geração muito abaixo do esperado para a radiação que houve
  if (wx && now.hour >= 19.5 && now.hour < 23 && kvGet('low_checked') !== now.date) {
    const row = db.prepare('SELECT kwh FROM daily WHERE date = ?').get(now.date);
    if (row) {
      kvSet('low_checked', now.date);
      const e = expectedForDate(wx, now.date);
      if (e?.kwh != null && e.kwh >= 3 && row.kwh < 0.6 * e.kwh) {
        await notify(
          `⚠️ Geração abaixo do esperado hoje: ${nf(row.kwh)} kWh, contra ~${nf(e.kwh)} kWh esperados para a radiação do dia (faixa ${nf(e.low)}–${nf(e.high)}).\n` +
          'Se isso se repetir em dias de sol, vale checar sujeira, sombra ou o inversor.'
        );
      }
    }
  }
}
