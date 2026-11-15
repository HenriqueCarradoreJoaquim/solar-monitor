# solar-monitor

Coletor + API para monitorar sua usina solar via SOLARMAN OpenAPI.
Etapa 1 e 2 do plano: autenticação, coleta periódica, SQLite e API para o app.

## Requisitos

Node.js 24 ou superior (testado no 26.13.0). Usa o SQLite nativo (`node:sqlite`) e o carregamento
nativo de `.env` (`--env-file`), então não há dependências que precisem de compilação.

## Rodando

```bash
npm install            # requer Node 24+ (testado no Node 26.13.0)
cp .env.example .env      # preencha appId, appSecret, e-mail e senha (SHA-256)
npm run discover          # confere usinas, inversores e chaves reais da sua conta
npm run collect           # testa uma coleta única
npm start                 # API + coletor agendado
```

Hash da senha: `echo -n 'suasenha' | sha256sum`

## Telegram (grátis)

1. No Telegram, fale com **@BotFather**, envie `/newbot` e copie o token para `TELEGRAM_BOT_TOKEN`.
2. Rode `npm start`, abra seu bot e mande `/id`. Copie o número para `TELEGRAM_CHAT_ID` e reinicie.
3. Teste com `npm run report` ou mandando `/hoje` ao bot.

Comandos: `/hoje` (relatório agora), `/semana` (últimos 7 dias), `/id`.
O relatório diário sai às 20h (`REPORT_CRON`). O bot só responde ao seu chat.
`ANTHROPIC_API_KEY` é opcional: com ela, uma frase escrita por IA é adicionada ao relatório.

## Total do dia = soma dos equipamentos

Na instalação do dono, o total que a API da usina devolve só inclui o microinversor. Por isso o total do dia
é a **soma da produção de cada equipamento** (inversor + microinversor), obtida do histórico diário de cada um
(`/device/v1.0/historical`) e da leitura atual. O relatório mostra o detalhamento por equipamento.

- `npm run backfill` — importa o histórico (usina + equipamentos); roda sozinho no primeiro início.
- `npm run history` — mostra o que a API devolve no histórico de cada equipamento (para conferência).
- Às 21h30 o sistema reconcilia os últimos 3 dias com o histórico oficial.

## Painel web

Com `npm start` rodando, abra `http://localhost:3000` (ou `http://IP-DO-PC:3000` no celular, na mesma rede Wi-Fi).
Na primeira vez a página pede o `API_TOKEN` do `.env`. Mostra os kWh de hoje, potência atual,
curva de potência do dia e os últimos 30 dias. Atualiza sozinha a cada minuto.

## Alertas e previsão (Telegram)

**Alertas** (só avisam quando o estado muda, sem repetir a cada coleta; avisam também quando normaliza):
- usina sem enviar dados há mais de 1 h entre 9h e 16h;
- inversor ou microinversor sem produzir com sol forte (10h–15h, radiação ≥ 500 W/m²);
- status do equipamento diferente de "Grid connected"/normal em horário de sol;
- fim do dia (após 19h30): geração abaixo de 60% do esperado para a radiação que houve.

**Previsão de geração**: usa a previsão de radiação solar do Open-Meteo (gratuito, sem chave) e
calibra com o seu histórico (kWh gerados por kWh/m² de radiação). Sai todo dia às 7h (`FORECAST_CRON`),
no relatório das 20h (linha "Amanhã") e sob demanda com `/previsao`. Teste no terminal com `npm run forecast`.
Ajuste `LATITUDE`/`LONGITUDE` no `.env` para o endereço da usina.

**Comandos**: `/hoje`, `/semana`, `/previsao`, `/status` (potência, produção do dia e status de cada equipamento), `/id`.

## Endpoints (Authorization: Bearer <API_TOKEN>)

- `GET /health`
- `GET /api/today`  → kWh de hoje, potência atual, média dos 7 dias anteriores, variação %
- `GET /api/days?limit=30`  → kWh por dia (gráfico de barras)
- `GET /api/power?date=YYYY-MM-DD`  → curva de potência do dia

## Pontos a validar no primeiro teste

Os nomes de campos abaixo seguem a documentação pública da API, mas variam por conta/inversor:

- `generationPower` em `/station/v1.0/realTime` (usado como potência atual, em W)
- `generationValue`, `year`, `month`, `day` em `/station/v1.0/history` (kWh por dia)

O JSON bruto de cada leitura fica na coluna `readings.raw`; se algum campo vier diferente,
ajuste só `src/collector.js`. O `npm run discover` mostra exatamente o que sua conta devolve.

## Próximas etapas

3. ~~Relatório diário~~ feito via Telegram
4. Painel web /  App React Native (Expo) consumindo esta API
