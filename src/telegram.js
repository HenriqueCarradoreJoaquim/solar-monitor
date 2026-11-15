import cron from 'node-cron';
import { config } from './config.js';
import { buildReport, weekSummary, buildStatus } from './report.js';
import { buildForecast } from './forecast.js';

const { token, chatId, apiBase } = config.telegram;

async function api(method, body = {}, timeoutMs = 15000) {
  const res = await fetch(`${apiBase}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description || `HTTP ${res.status}`}`);
  return json.result;
}

export const sendMessage = (text, to = chatId) => api('sendMessage', { chat_id: to, text });

export async function sendDailyReport() {
  if (!token || !chatId) throw new Error('Defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no .env');
  return sendMessage(await buildReport());
}

async function handle(msg) {
  if (!msg?.text) return;
  const cmd = msg.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  const from = String(msg.chat.id);

  // /id e /start funcionam para qualquer um: só devolvem o ID do próprio chat
  if (cmd === '/id' || cmd === '/start') {
    return sendMessage(`Seu chat ID: ${from}\nColoque em TELEGRAM_CHAT_ID no .env e reinicie o servidor.`, from);
  }
  if (!chatId) return sendMessage('Defina TELEGRAM_CHAT_ID no .env primeiro (use /id).', from);
  if (from !== String(chatId)) return; // ignora qualquer outra pessoa

  if (cmd === '/hoje' || cmd === '/relatorio') return sendMessage(await buildReport(), from);
  if (cmd === '/semana') return sendMessage(weekSummary(), from);
  if (cmd === '/status') return sendMessage(buildStatus(), from);
  if (cmd === '/previsao' || cmd === '/previsão') {
    return sendMessage(await buildForecast().catch((e) => `Não consegui buscar a previsão: ${e.message}`), from);
  }
  return sendMessage('Comandos: /hoje, /semana, /previsao, /status, /id', from);
}

/** Bot por long polling (não precisa de IP público nem de webhook) + relatório diário agendado. */
export function startBot() {
  if (!token) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN não definido — bot desativado');
    return;
  }

  (async () => {
    let offset = 0;
    for (;;) {
      try {
        const updates = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] }, 40000);
        for (const u of updates) {
          offset = u.update_id + 1;
          await handle(u.message).catch((e) => console.error('[telegram] comando falhou:', e.message));
        }
      } catch (e) {
        console.error('[telegram] erro:', e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
  console.log('[telegram] bot ativo (comandos: /hoje, /semana, /previsao, /status, /id)');

  if (chatId) {
    cron.schedule(
      config.reportCron,
      () =>
        sendDailyReport()
          .then(() => console.log('[telegram] relatório diário enviado'))
          .catch((e) => console.error('[telegram] falha ao enviar relatório:', e.message)),
      { timezone: config.timezone }
    );
    console.log(`[telegram] relatório diário agendado: "${config.reportCron}"`);
    cron.schedule(
      config.forecastCron,
      () =>
        buildForecast()
          .then((txt) => sendMessage(txt))
          .then(() => console.log('[telegram] previsão enviada'))
          .catch((e) => console.error('[telegram] falha na previsão:', e.message)),
      { timezone: config.timezone }
    );
    console.log(`[telegram] previsão de geração agendada: "${config.forecastCron}"`);
  } else {
    console.log('[telegram] TELEGRAM_CHAT_ID vazio — mande /id ao bot para descobrir');
  }
}
