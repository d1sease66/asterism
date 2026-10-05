# Smart Wallet Alerts · Asterism

Собирает «умные» кошельки Solana из лент GMGN, сам оценивает их, присылает в Telegram алерты о кластерах
и показывает всё на публичном дашборде **Asterism** (с задержкой 15 минут).

Только чтение: никаких ключей кошельков, подписей и свапов.

## Запуск

```bash
npm install
npm run build
npm start              # collector + HTTP на 127.0.0.1:$PORT (сайт и /api/public/*)
npm test
npm run stats -- 1     # отчёт collector за последние N часов
```

`COLLECTOR=0` запускает только HTTP (просмотр сайта рядом с работающим collector), `PUBLIC_DELAY_MIN=0` — без задержки для локальной вёрстки.

## Устройство

- `src/gmgn/client.ts` — единственная точка общения с GMGN (HTTP к `openapi.gmgn.ai`), общий взвешенный leaky bucket с приоритетами, пауза до `reset_at` при 429.
- `src/collector/` — опрос лент smartmoney/kol с адаптивным интервалом, нормализация мульти-хоп свапов, детекция пропусков (`poll_log`).
- `src/public.ts` — данные дашборда, обрезанные по `now − PUBLIC_DELAY_MIN`.
- `web/` — сайт Asterism (статический HTML/CSS/JS без сборки).
- `docs/gmgn-fields.md` — реальные поля и ловушки API GMGN, `fixtures/` — сырые ответы.

## HTTP

| путь | что |
|---|---|
| `/health` | `{ ok: true }` |
| `/api/stats?window=3600` | служебная статистика collector и лимитера (на сервере только локально) |
| `/api/public/summary`, `/sky`, `/signals`, `/wallets` | данные дашборда, с задержкой |
