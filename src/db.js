import { DatabaseSync } from 'node:sqlite'; // SQLite nativo do Node (sem dependência nativa para compilar)
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Leituras instantâneas (uma por coleta)
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,            -- epoch ms da coleta
    station_id INTEGER NOT NULL,
    power_w REAL,                   -- potência atual em W
    raw TEXT                        -- JSON bruto da resposta (para ajustar campos depois)
  );
  CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);

  -- Leituras por equipamento (inversor, microinversor), só durante o dia
  CREATE TABLE IF NOT EXISTS device_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    station_id INTEGER NOT NULL,
    device_sn TEXT NOT NULL,
    device_type TEXT,
    power_w REAL,
    daily_kwh REAL,
    status TEXT,
    raw TEXT                        -- JSON bruto, guardado só de tempos em tempos
  );
  CREATE INDEX IF NOT EXISTS idx_device_readings ON device_readings(device_sn, ts);

  -- Produção diária de cada equipamento (kWh); a soma vira o total do dia na tabela daily
  CREATE TABLE IF NOT EXISTS device_daily (
    date TEXT NOT NULL,
    device_sn TEXT NOT NULL,
    device_type TEXT,
    kwh REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (date, device_sn)
  );

  -- Total gerado por dia (kWh) = soma dos equipamentos (ou valor da usina, se não houver dados por equipamento)
  CREATE TABLE IF NOT EXISTS daily (
    date TEXT NOT NULL,             -- YYYY-MM-DD
    station_id INTEGER NOT NULL,
    kwh REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (date, station_id)
  );
`);

export const kvGet = (key) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
export const kvSet = (key, value) =>
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
