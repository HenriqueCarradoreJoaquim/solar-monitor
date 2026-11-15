import cron from 'node-cron';
import { db } from './db.js';
import { config, dateInTz, localNow } from './config.js';
import {
  resolveStationId, stationRealTime, stationDailyHistory, listDevices, deviceCurrentData, deviceHistory,
} from './solarman.js';
import { runAlerts } from './alerts.js';

const insertReading = db.prepare('INSERT INTO readings(ts, station_id, power_w, raw) VALUES (?, ?, ?, ?)');
const insertDevice = db.prepare(
  'INSERT INTO device_readings(ts, station_id, device_sn, device_type, power_w, daily_kwh, status, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
const rawRecent = db.prepare('SELECT 1 AS x FROM device_readings WHERE device_sn = ? AND raw IS NOT NULL AND ts > ? LIMIT 1');
const upsertDaily = db.prepare(`
  INSERT INTO daily(date, station_id, kwh, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(date, station_id) DO UPDATE SET kwh = excluded.kwh, updated_at = excluded.updated_at
`);
const hasDeviceDay = db.prepare('SELECT 1 AS x FROM device_daily WHERE date = ? LIMIT 1');
const upsertDevDayReplace = db.prepare(`
  INSERT INTO device_daily(date, device_sn, device_type, kwh, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(date, device_sn) DO UPDATE SET kwh = excluded.kwh, device_type = excluded.device_type, updated_at = excluded.updated_at
`);
const upsertDevDayMax = db.prepare(`
  INSERT INTO device_daily(date, device_sn, device_type, kwh, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(date, device_sn) DO UPDATE SET kwh = MAX(device_daily.kwh, excluded.kwh), updated_at = excluded.updated_at
`);
// O total do dia é a SOMA dos equipamentos (a API da usina, no seu caso, só soma o microinversor)
const recomputeDaily = db.prepare(`
  INSERT INTO daily(date, station_id, kwh, updated_at)
  SELECT date, ?, SUM(kwh), ? FROM device_daily WHERE date = ? GROUP BY date
  ON CONFLICT(date, station_id) DO UPDATE SET kwh = excluded.kwh, updated_at = excluded.updated_at
`);

const LABEL = { INVERTER: 'inversor', MICRO_INVERTER: 'microinversor' };
const num = (v) => {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Divide [start, end] em blocos de até 28 dias (a API aceita menos de 30 dias por consulta). */
export function dateChunks(start, end, maxDays = 28) {
  const out = [];
  for (let s = start; s <= end; ) {
    const e = addDays(s, maxDays - 1) < end ? addDays(s, maxDays - 1) : end;
    out.push([s, e]);
    s = addDays(e, 1);
  }
  return out;
}

// ---------- Total diário da USINA (a API só soma parte dos equipamentos; serve de reserva) ----------

/** Grava os totais diários da usina, exceto nos dias em que já temos a soma dos equipamentos. */
export function saveDailyItems(stationId, items) {
  let saved = 0;
  for (const it of items) {
    if (it.year && it.month && it.day && it.generationValue != null) {
      const date = `${it.year}-${String(it.month).padStart(2, '0')}-${String(it.day).padStart(2, '0')}`;
      if (hasDeviceDay.get(date)) continue;
      upsertDaily.run(date, stationId, Number(it.generationValue), Date.now());
      saved++;
    }
  }
  return saved;
}

/** Histórico diário da usina dos últimos N meses (em blocos de 28 dias). */
export async function backfillMonths(months = 3) {
  const stationId = await resolveStationId();
  const today = dateInTz(0);
  let total = 0;
  for (const [start, end] of dateChunks(addDays(today, -(months * 30) + 1), today)) {
    const items = await stationDailyHistory(stationId, start, end);
    total += saveDailyItems(stationId, items);
    console.log(`[histórico] usina ${start} → ${end}: ${items.length} dias recebidos`);
  }
  return total;
}

// ---------- Equipamentos (inversor e microinversor) ----------

/** Produção do dia (kWh) a partir da lista de dados de um equipamento. */
export function dailyKwhFromDataList(dataList = []) {
  const it =
    dataList.find((i) => i.key === 'generation') ??
    dataList.find((i) => i.key === 'Etdy_ge1') ??
    dataList.find((i) => /^(daily )?(production|generation)/i.test(i.name || '') && !/cumulative|total/i.test(i.name || ''));
  return it ? num(it.value) : null;
}

/** Extrai potência (W), produção do dia (kWh) e status da lista de dados de um equipamento. */
export function extractDevice(dataList = []) {
  const find = (keys, re) => dataList.find((i) => keys.includes(i.key)) ?? dataList.find((i) => re.test(i.name || ''));

  let p = find(['APo_t1'], /total ac output power|ac output power/i);
  p ??= dataList.find((i) => /^k?w$/i.test(i.unit || '') && /power/i.test(i.name || '') && !/rated|dc|pv|grid|consum/i.test(i.name || ''));
  let power = p ? num(p.value) : null;
  if (power != null && /^kw$/i.test(p.unit || '')) power *= 1000;

  const d = find(['Etdy_ge1'], /daily production/i);
  const s = find(['INV_ST1'], /inverter status|^status$/i);
  return { power, daily: d ? num(d.value) : null, status: s ? String(s.value).trim() : null };
}

let deviceCache = { at: 0, list: [] };
async function getDevices(stationId) {
  if (!deviceCache.list.length || Date.now() - deviceCache.at > 6 * 3600 * 1000) {
    const all = await listDevices(stationId);
    deviceCache = { at: Date.now(), list: all.filter((d) => ['INVERTER', 'MICRO_INVERTER'].includes(d.deviceType)) };
  }
  return deviceCache.list;
}

/** Grava a produção diária de um equipamento vinda do histórico e recalcula o total do dia. */
export function saveDeviceDaily(stationId, dev, items) {
  let saved = 0;
  for (const it of items) {
    const date = String(it.collectTime || '').slice(0, 10);
    const kwh = dailyKwhFromDataList(it.dataList);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && kwh != null) {
      upsertDevDayReplace.run(date, dev.deviceSn, dev.deviceType, kwh, Date.now());
      recomputeDaily.run(stationId, Date.now(), date);
      saved++;
    }
  }
  return saved;
}

/** Histórico diário de cada equipamento (inversor + microinversor) dos últimos N dias. */
export async function backfillDevices(days = 90) {
  const stationId = await resolveStationId();
  const today = dateInTz(0);
  let total = 0;
  for (const dev of await getDevices(stationId)) {
    try {
      for (const [start, end] of dateChunks(addDays(today, -(days - 1)), today)) {
        const items = await deviceHistory(dev.deviceSn, start, end);
        const n = saveDeviceDaily(stationId, dev, items);
        total += n;
        const keys = (items[0]?.dataList ?? []).map((i) => i.key).slice(0, 6).join(',');
        console.log(`[histórico] ${LABEL[dev.deviceType]} ${dev.deviceSn} ${start} → ${end}: ${n}/${items.length} dias (chaves: ${keys || '-'})`);
      }
    } catch (e) {
      console.error(`[histórico] ${LABEL[dev.deviceType]} ${dev.deviceSn}:`, e.message);
    }
  }
  return total;
}

async function pollDevices(stationId, at) {
  const now = localNow(config.timezone, at);
  if (now.hour < 5 || now.hour > 20) return { n: 0, powerW: null }; // à noite estão desligados
  let n = 0;
  let powerW = null;
  try {
    for (const d of await getDevices(stationId)) {
      try {
        const cur = await deviceCurrentData(d.deviceSn);
        const x = extractDevice(cur.dataList ?? []);

        // Produção do dia: da leitura atual; se o equipamento não informar, usa o histórico de hoje
        let daily = x.daily;
        if (daily == null) {
          const h = await deviceHistory(d.deviceSn, now.date, now.date).catch(() => []);
          daily = dailyKwhFromDataList(h.at(-1)?.dataList);
        }

        const keepRaw = !rawRecent.get(d.deviceSn, at.getTime() - 6 * 3600 * 1000);
        insertDevice.run(at.getTime(), stationId, d.deviceSn, d.deviceType, x.power, daily, x.status, keepRaw ? JSON.stringify(cur) : null);
        if (daily != null) {
          upsertDevDayMax.run(now.date, d.deviceSn, d.deviceType, daily, Date.now());
          recomputeDaily.run(stationId, Date.now(), now.date);
        }
        if (x.power != null) powerW = (powerW ?? 0) + x.power;
        n++;
      } catch (e) {
        console.error(`[coletor] equipamento ${d.deviceSn}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[coletor] lista de equipamentos:', e.message);
  }
  return { n, powerW };
}

/** Uma rodada de coleta: equipamentos + usina + totais diários. */
export async function collectOnce({ at = new Date() } = {}) {
  const stationId = await resolveStationId();

  // 1) Equipamentos (durante o dia): potência total = soma de inversor + microinversor
  const dev = await pollDevices(stationId, at);

  // 2) Leitura da usina (guarda o JSON bruto; a potência é a soma dos equipamentos quando disponível)
  const rt = await stationRealTime(stationId);
  const powerW = dev.n > 0 && dev.powerW != null ? dev.powerW : (rt.generationPower ?? null);
  insertReading.run(Date.now(), stationId, powerW, JSON.stringify(rt));

  // 3) Total diário da usina (reserva para dias sem dados por equipamento)
  const items = await stationDailyHistory(stationId, dateInTz(-1), dateInTz(0));
  saveDailyItems(stationId, items);
  return { stationId, powerW, days: items.length, devices: dev.n };
}

export function startCollector() {
  const run = async () => {
    try {
      const r = await collectOnce();
      console.log(`[coletor] ok usina=${r.stationId} potência=${r.powerW}W equipamentos=${r.devices} dias=${r.days}`);
    } catch (e) {
      console.error('[coletor] erro:', e.message);
    }
    await runAlerts().catch((e) => console.error('[alertas] erro:', e.message));
  };

  const stationRows = db.prepare('SELECT COUNT(*) AS n FROM daily').get().n;
  const deviceDays = db.prepare('SELECT COUNT(DISTINCT date) AS n FROM device_daily').get().n;
  (async () => {
    if (stationRows < 14) await backfillMonths(2).catch((e) => console.error('[histórico] usina:', e.message));
    if (deviceDays < 14) await backfillDevices(90).catch((e) => console.error('[histórico] equipamentos:', e.message));
    run();
  })();
  cron.schedule(config.collectCron, run, { timezone: config.timezone });
  // Fecha o dia: reconcilia os últimos 3 dias com o histórico oficial de cada equipamento
  cron.schedule('30 21 * * *', () => backfillDevices(3).catch((e) => console.error('[histórico]', e.message)), { timezone: config.timezone });
  console.log(`[coletor] agendado: "${config.collectCron}" (${config.timezone})`);
}
