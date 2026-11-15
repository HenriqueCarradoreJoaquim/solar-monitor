// Variáveis do .env são carregadas pelo Node (--env-file-if-exists), sem dotenv.
import crypto from 'node:crypto';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente ausente: ${name} (veja .env.example)`);
  return v;
}

const passwordSha256 =
  process.env.SOLARMAN_PASSWORD_SHA256 ||
  (process.env.SOLARMAN_PASSWORD
    ? crypto.createHash('sha256').update(process.env.SOLARMAN_PASSWORD).digest('hex')
    : null);

export const config = {
  solarman: {
    baseUrl: process.env.SOLARMAN_BASE_URL || 'https://globalapi.solarmanpv.com',
    appId: () => required('SOLARMAN_APP_ID'),
    appSecret: () => required('SOLARMAN_APP_SECRET'),
    email: () => required('SOLARMAN_EMAIL'),
    passwordSha256: () => {
      if (!passwordSha256) throw new Error('Defina SOLARMAN_PASSWORD_SHA256 ou SOLARMAN_PASSWORD');
      return passwordSha256;
    },
    stationId: process.env.SOLARMAN_STATION_ID ? Number(process.env.SOLARMAN_STATION_ID) : null,
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    apiBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',
  },
  reportCron: process.env.REPORT_CRON || '0 20 * * *',
  // Opcional: comentário escrito por IA no relatório (API da Anthropic é paga, centavos por mês)
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  },
  // Local da usina (padrão: Criciúma-SC). Ajuste para o endereço da instalação.
  location: {
    lat: Number(process.env.LATITUDE || -28.677),
    lon: Number(process.env.LONGITUDE || -49.37),
  },
  weatherBaseUrl: process.env.OPEN_METEO_URL || 'https://api.open-meteo.com',
  forecastCron: process.env.FORECAST_CRON || '0 7 * * *',
  alertsEnabled: (process.env.ALERTS_ENABLED || 'true') !== 'false',
  collectCron: process.env.COLLECT_CRON || '*/10 * * * *',
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  apiToken: process.env.API_TOKEN || '',
  dbPath: process.env.DB_PATH || './data/solar.db',
  timezone: process.env.TZ || 'America/Sao_Paulo',
};

/** Data "YYYY-MM-DD" no fuso configurado (offsetDays: 0 = hoje, -1 = ontem). */
export function dateInTz(offsetDays = 0, tz = config.timezone) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Data (YYYY-MM-DD) e hora decimal (ex.: 13.5 = 13:30) no fuso configurado. */
export function localNow(tz = config.timezone, at = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) + Number(p.minute) / 60 };
}
