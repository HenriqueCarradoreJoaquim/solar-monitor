import { getWeather, expectedForDate } from './weather.js';
import { dateInTz } from './config.js';

const nf = (n, d = 1) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const brDate = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);

export async function buildForecast() {
  const wx = await getWeather();
  const lines = ['🌤️ Previsão de geração', ''];
  for (const [label, off] of [['Hoje', 0], ['Amanhã', 1], ['Depois de amanhã', 2]]) {
    const date = dateInTz(off);
    const e = expectedForDate(wx, date);
    if (!e) { lines.push(`${label}: sem previsão`); continue; }
    const cloud = e.cloud != null ? ` · nuvens ${e.cloud}%` : '';
    lines.push(
      e.kwh == null
        ? `${label} (${brDate(date)}): radiação ${nf(e.rad)} kWh/m²${cloud} (sem histórico para calibrar)`
        : `${label} (${brDate(date)}): ~${nf(e.kwh)} kWh (faixa ${nf(e.low)}–${nf(e.high)})${cloud}`
    );
  }
  lines.push('', 'Estimativa a partir da previsão de radiação solar e do seu histórico de geração; costuma errar para mais ou para menos.');
  return lines.join('\n');
}
