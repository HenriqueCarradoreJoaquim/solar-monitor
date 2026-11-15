// Mostra o que a API devolve no histórico diário de cada equipamento (últimos 3 dias): npm run history
import { resolveStationId, listDevices, deviceHistory } from './solarman.js';
import { dateInTz } from './config.js';

const stationId = await resolveStationId();
for (const d of (await listDevices(stationId)).filter((d) => ['INVERTER', 'MICRO_INVERTER'].includes(d.deviceType))) {
  console.log(`\n=== ${d.deviceType} ${d.deviceSn} — histórico diário ===`);
  const items = await deviceHistory(d.deviceSn, dateInTz(-2), dateInTz(0));
  for (const it of items) {
    const shown = (it.dataList ?? []).filter((i) => /generation|production|Etdy|Et_ge/i.test(`${i.key} ${i.name}`));
    console.log(it.collectTime, shown.map((i) => `${i.key}=${i.value}${i.unit ? ' ' + i.unit : ''} (${i.name})`).join(' | ') || '(sem campos de produção)');
  }
}
