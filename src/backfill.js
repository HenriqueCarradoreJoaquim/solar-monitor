// Importa o histórico: npm run backfill [meses]
// 1) total da usina (reserva)  2) produção diária de cada equipamento (a soma vira o total do dia)
import { backfillMonths, backfillDevices } from './collector.js';
const months = Number(process.argv[2]) || 3;
const station = await backfillMonths(months);
const devices = await backfillDevices(months * 30);
console.log(`Pronto: ${station} dias da usina e ${devices} dias de equipamentos gravados.`);
