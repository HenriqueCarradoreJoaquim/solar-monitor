import { db } from './db.js';
import { config, dateInTz } from './config.js';
import { getWeather, expectedForDate } from './weather.js';
import { isDayComplete } from './completeness.js';

const nf = (n, d = 1) =>
  n == null ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (a, b) => (a != null && b ? Math.round(((a - b) / b) * 100) : null);
const withPct = (p) => (p == null ? '' : ` (${p >= 0 ? '+' : ''}${p}%)`);
const brDate = (iso) => iso.split('-').reverse().join('/');

function shiftDate(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function getReportData(date = dateInTz(0)) {
  const dayKwh = (d) => db.prepare('SELECT kwh FROM daily WHERE date = ?').get(d)?.kwh ?? null;
  const kwh = dayKwh(date);
  const devices = db.prepare('SELECT device_type AS type, kwh FROM device_daily WHERE date = ? ORDER BY kwh DESC').all(date);
  const yesterday = dayKwh(shiftDate(date, -1));
  const avg7 =
    db.prepare('SELECT AVG(kwh) AS avg FROM (SELECT kwh FROM daily WHERE date < ? ORDER BY date DESC LIMIT 7)').get(date)?.avg ??
    null;
  const best = db
    .prepare('SELECT date, kwh FROM daily WHERE date LIKE ? ORDER BY kwh DESC LIMIT 1')
    .get(`${date.slice(0, 7)}-%`);
  const peak = db
    .prepare(
      `SELECT ts, power_w FROM readings
       WHERE date(ts / 1000, 'unixepoch', 'localtime') = ? AND power_w IS NOT NULL
       ORDER BY power_w DESC LIMIT 1`
    )
    .get(date);
  const peakTime = peak
    ? new Date(peak.ts).toLocaleTimeString('pt-BR', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' })
    : null;

  return {
    date,
    kwh,
    devices,
    incomplete: isDayComplete(date) === false,
    yesterday,
    avg7,
    vsYesterday: pct(kwh, yesterday),
    vsAvg7: pct(kwh, avg7),
    bestDay: best ? { date: best.date, kwh: best.kwh } : null,
    peakKw: peak ? peak.power_w / 1000 : null,
    peakTime,
  };
}

export function formatReport(d) {
  if (d.kwh == null) {
    return `☀️ Relatório solar — ${brDate(d.date)}\n\nAinda não há dados de geração para hoje.`;
  }
  const lines = [
    `☀️ Relatório solar — ${brDate(d.date)}`,
    '',
    `⚡ Geração hoje: ${nf(d.kwh)} kWh`,
  ];
  if (d.incomplete) lines.push('     ⚠️ total possivelmente incompleto: faltam dados de algum equipamento');
  if (d.devices?.length > 1) {
    const name = { INVERTER: 'Inversor', MICRO_INVERTER: 'Micro' };
    lines.push(`     ${d.devices.map((x) => `${name[x.type] ?? x.type} ${nf(x.kwh)}`).join(' · ')}`);
  }
  if (d.yesterday != null) lines.push(`📅 Ontem: ${nf(d.yesterday)} kWh${withPct(d.vsYesterday)}`);
  if (d.avg7 != null) lines.push(`📊 Média dos 7 dias anteriores: ${nf(d.avg7)} kWh${withPct(d.vsAvg7)}`);
  if (d.bestDay) lines.push(`🏆 Melhor dia do mês: ${nf(d.bestDay.kwh)} kWh (${brDate(d.bestDay.date).slice(0, 5)})`);
  if (d.peakKw != null && d.peakKw > 0) lines.push(`🔆 Pico de potência: ${nf(d.peakKw, 2)} kW às ${d.peakTime}`);
  return lines.join('\n');
}

/** Frase opcional escrita por IA. Só usa os números fornecidos; se falhar, o relatório sai sem ela. */
async function aiComment(d) {
  const { apiKey, model } = config.anthropic;
  if (!apiKey || d.kwh == null) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system:
          'Você escreve 1 ou 2 frases curtas, em português do Brasil, comentando a geração solar do dia para o dono da casa. ' +
          'Use SOMENTE os números fornecidos; não invente causas, clima ou números. Se a variação for pequena, diga que foi um dia normal. ' +
          'Sem emojis, sem saudação.',
        messages: [{ role: 'user', content: JSON.stringify(d) }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json();
    return json.content?.find((b) => b.type === 'text')?.text?.trim() || null;
  } catch (e) {
    console.error('[ia] sem comentário:', e.message);
    return null;
  }
}

async function tomorrowLine() {
  try {
    const e = expectedForDate(await getWeather(), dateInTz(1));
    if (!e || e.kwh == null) return null;
    return `🌤️ Amanhã: ~${nf(e.kwh)} kWh esperados (${nf(e.low)}–${nf(e.high)})`;
  } catch {
    return null;
  }
}

export async function buildReport(date) {
  const data = getReportData(date);
  let text = formatReport(data);
  const tomorrow = date ? null : await tomorrowLine();
  if (tomorrow) text += `\n${tomorrow}`;
  const comment = await aiComment(data);
  return comment ? `${text}\n\n💬 ${comment}` : text;
}

/** Últimos 7 dias, um por linha. */
export function weekSummary() {
  const rows = db.prepare('SELECT date, kwh FROM daily ORDER BY date DESC LIMIT 7').all().reverse();
  if (!rows.length) return 'Ainda não há dados diários.';
  const total = rows.reduce((s, r) => s + r.kwh, 0);
  return [
    '📈 Últimos 7 dias',
    '',
    ...rows.map((r) => `${brDate(r.date).slice(0, 5)}  ${nf(r.kwh)} kWh`),
    '',
    `Total: ${nf(total)} kWh`,
  ].join('\n');
}

/** Última leitura de cada equipamento (inversor, microinversor). */
export function buildStatus() {
  const rows = db
    .prepare('SELECT device_sn, device_type, power_w, daily_kwh, status, MAX(ts) AS ts FROM device_readings GROUP BY device_sn')
    .all();
  if (!rows.length) return 'Ainda sem leituras dos equipamentos (a coleta por equipamento acontece entre 5h e 20h).';
  const label = { INVERTER: 'Inversor', MICRO_INVERTER: 'Microinversor' };
  const lines = ['🔌 Status dos equipamentos', ''];
  for (const r of rows) {
    const mins = Math.round((Date.now() - r.ts) / 60000);
    const age = mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.floor(mins / 60)} h` : `${Math.floor(mins / 1440)} d`;
    lines.push(`${label[r.device_type] ?? r.device_type} (${r.device_sn})`);
    lines.push(
      `  ${r.power_w == null ? 'potência n/d' : nf(r.power_w / 1000, 2) + ' kW'}` +
        `${r.daily_kwh != null ? ` · dia: ${nf(r.daily_kwh)} kWh` : ''}${r.status ? ` · ${r.status}` : ''}`
    );
    lines.push(`  leitura há ${age}`);
  }
  return lines.join('\n');
}
