// Envia o relatório agora (teste): npm run report
import { sendDailyReport } from './telegram.js';
await sendDailyReport();
console.log('Relatório enviado.');
