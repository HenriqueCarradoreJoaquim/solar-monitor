// Rode UMA vez após preencher o .env: `npm run discover`
// Mostra usinas, inversores e as chaves reais devolvidas pela API da sua conta.
import { listStations, listDevices, stationRealTime, deviceCurrentData } from './solarman.js';

const stations = await listStations();
console.log('\n=== USINAS ===');
console.log(stations.map((s) => ({ id: s.id, name: s.name, generationPower: s.generationPower })));

for (const s of stations) {
  console.log(`\n=== REALTIME usina ${s.id} ===`);
  console.log(await stationRealTime(s.id));

  const devices = await listDevices(s.id);
  console.log(`\n=== DISPOSITIVOS usina ${s.id} ===`);
  console.log(devices.map((d) => ({ deviceSn: d.deviceSn, type: d.deviceType, ...d })));

  for (const d of devices.filter((d) => ['INVERTER', 'MICRO_INVERTER'].includes(d.deviceType))) {
    const cur = await deviceCurrentData(d.deviceSn);
    console.log(`\n=== DADOS ATUAIS inversor ${d.deviceSn} (key | nome | valor) ===`);
    const { dataList, ...meta } = cur;
    console.log(meta);
    for (const it of dataList ?? []) console.log(`${it.key} | ${it.name} | ${it.value} ${it.unit ?? ''}`);
  }
}
