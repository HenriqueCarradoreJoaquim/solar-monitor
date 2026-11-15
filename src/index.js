import { buildServer } from './server.js';
import { startCollector } from './collector.js';
import { startBot } from './telegram.js';
import { config } from './config.js';

const app = buildServer();
await app.listen({ port: config.port, host: config.host });
console.log(`[api] http://${config.host}:${config.port}`);
startCollector();
startBot();
