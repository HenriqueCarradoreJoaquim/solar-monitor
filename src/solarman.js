import { config } from './config.js';
import { kvGet, kvSet } from './db.js';

const { solarman: cfg } = config;
const RENEW_MARGIN_MS = 24 * 3600 * 1000; // renova 1 dia antes de expirar

async function post(path, { query = {}, body = {}, token } = {}) {
  const url = new URL(path, cfg.baseUrl);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok || json.success === false) {
    throw new Error(`SOLARMAN ${path} falhou (HTTP ${res.status}): ${json.msg || text.slice(0, 300)}`);
  }
  return json;
}

/** Faz login e guarda o token no banco. */
async function login() {
  const json = await post('/account/v1.0/token', {
    query: { appId: cfg.appId(), language: 'en' },
    body: {
      appSecret: cfg.appSecret(),
      email: cfg.email(),
      password: cfg.passwordSha256(),
    },
  });
  const expiresMs = Date.now() + Number(json.expires_in) * 1000;
  kvSet('access_token', json.access_token);
  kvSet('token_expires_at', expiresMs);
  return json.access_token;
}

/** Retorna um token válido (reaproveita o salvo; refaz login perto de expirar). */
export async function getToken() {
  const token = kvGet('access_token');
  const exp = Number(kvGet('token_expires_at') || 0);
  if (token && exp - Date.now() > RENEW_MARGIN_MS) return token;
  return login();
}

async function authed(path, body = {}) {
  const token = await getToken();
  return post(path, { query: { language: 'en' }, body, token });
}

export async function listStations() {
  const json = await authed('/station/v1.0/list', { pageNum: 1, pageSize: 20 });
  return json.stationList ?? [];
}

export async function listDevices(stationId) {
  const json = await authed('/station/v1.0/device', { stationId, pageNum: 1, pageSize: 20 });
  return json.deviceListItems ?? [];
}

/** Dados em tempo real da usina (potência atual etc.). */
export const stationRealTime = (stationId) => authed('/station/v1.0/realTime', { stationId });

/** Dados em tempo real de um inversor (lista de {key,name,value,unit}). */
export const deviceCurrentData = (deviceSn) => authed('/device/v1.0/currentData', { deviceSn });

/** Histórico de um equipamento. timeType 2 = estatística diária (a API limita a menos de 30 dias por chamada). */
export async function deviceHistory(deviceSn, startTime, endTime, timeType = 2) {
  const json = await authed('/device/v1.0/historical', { deviceSn, startTime, endTime, timeType });
  return json.paramDataList ?? [];
}

/** Histórico diário da usina entre duas datas (YYYY-MM-DD). timeType 2 = por dia. */
export async function stationDailyHistory(stationId, startDate, endDate) {
  const json = await authed('/station/v1.0/history', { stationId, timeType: 2, startTime: startDate, endTime: endDate });
  return json.stationDataItems ?? [];
}

/** ID da usina: do .env ou a primeira da conta. */
export async function resolveStationId() {
  if (cfg.stationId) return cfg.stationId;
  const cached = kvGet('station_id');
  if (cached) return Number(cached);
  const stations = await listStations();
  if (!stations.length) throw new Error('Nenhuma usina encontrada nesta conta.');
  kvSet('station_id', stations[0].id);
  return stations[0].id;
}
