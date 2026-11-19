import { db } from './db.js';

const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * O total do dia está completo? Compara os equipamentos que já produziram nos últimos 14 dias
 * com os que têm produção registrada na data. Retorna true/false, ou null se ainda não há
 * nenhum histórico por equipamento (não dá para saber).
 */
export function isDayComplete(date) {
  const known = db
    .prepare('SELECT DISTINCT device_sn FROM device_daily WHERE date >= ? AND date < ?')
    .all(addDays(date, -14), date)
    .map((r) => r.device_sn);
  if (!known.length) return null;
  const have = new Set(db.prepare('SELECT device_sn FROM device_daily WHERE date = ?').all(date).map((r) => r.device_sn));
  return known.every((sn) => have.has(sn));
}
