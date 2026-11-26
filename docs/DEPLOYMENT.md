# Production deployment

The supported reference deployment is a single Docker Compose host running the
API, one scanner/Telegram worker, and the static web app. It is not a
multi-instance or high-availability design: user state and trade history are
JSON files, and exactly one worker must write them.

## Requirements

- Docker Engine with Docker Compose v2.
- A public HTTPS endpoint for the Mini App, terminated by a trusted
  reverse-proxy/load-balancer. Telegram Mini Apps require HTTPS.
- Persistent storage for the `paper-data` volume and encrypted, access
  controlled backups.
- Outbound access from the API and worker to Binance public endpoints; worker
  also needs Telegram Bot API access.
- A rate-limiting policy at the public edge. Do not expose port 3001 or the
  internal API directly to the internet.

## Configure and start

1. Check out a reviewed commit and copy
   `deploy/production.env.example` to `.env.production`. Keep this file
   restricted to the deployment account (for example, `chmod 600
   .env.production`) and out of version control.
2. Set `TELEGRAM_BOT_TOKEN` from a secret manager, set
   `TELEGRAM_WEB_APP_URL` to the public HTTPS address, choose the watchlist, and
   configure fee/slippage assumptions consistent with your paper-validation
   protocol. Do not commit the resulting environment file.
3. Keep `STRATEGY_QUALITY_EVIDENCE` empty unless it cites real, reviewable
   validation. Empty evidence intentionally blocks automated paper entries.
4. Build and start:

   ```sh
   docker compose --env-file .env.production up -d --build
   docker compose ps
   docker compose logs --tail=100 api worker web
   ```

5. Configure the external TLS proxy to forward the Mini App hostname to
   `127.0.0.1:8080`. Preserve WebSocket upgrade headers for
   `/api/market/stream`; apply TLS, request limits, and access logging at that
   edge. The API is only reachable on the Compose network. The web container
   binds to host loopback, not a public interface.
6. In Telegram, set the bot's Mini App URL to the same HTTPS URL. Confirm
   `/health`, the web chart, authenticated Mini App access, scanner logs, and
   the paper account behavior before enabling any users.

The API mounts the shared data volume read-only. The worker is the sole writer,
and Compose configures one replica. Do not run `apps/telegram` separately
against the same state file, start another worker, or scale the worker service.
Never use synthetic strategy evidence to bypass the default entry gate.
Compose passes the bot token to the API and worker as an environment variable;
Docker administrators can inspect container environments. Restrict access to
the Docker socket/host, and use the infrastructure's runtime secret-injection
facility if the deployment platform provides one.

## Operations and recovery

- Monitor container health, restart counts, disk capacity, API/worker logs, and
  Binance/Telegram connectivity. Logs go to container stdout/stderr; route and
  retain them using the host's normal log management.
- Back up the `paper-data` volume using encrypted, access-controlled storage.
  Stop the worker for a consistent file-level backup. Test restores on an
  isolated deployment before relying on them; do not overwrite live files
  during restore.
- Before upgrading, retain the deployed source commit and a verified backup.
  Rebuild from the reviewed commit and run `docker compose ... up -d --build`.
  For rollback, redeploy the previous reviewed commit and test compatibility
  with the current state-file schema.
- The Dockerfile pins Node and Nginx base-image digests for reproducible
  builds. Review and update those digests through a controlled dependency
  update process, and scan dependencies/images before public production use.
- Configure edge rate limits and firewall rules appropriate to the host. This
  template does not configure a public TLS proxy, DNS, a secret manager,
  automated backups, metrics collection, or multi-host failover.

The application only uses Binance public market data and simulated paper
trades. It does not configure exchange credentials or submit real orders.

## Render Free vs. Always-On Render

Render Free web services (`render.yaml`) spin down after 15 minutes without
inbound HTTP traffic and use an ephemeral filesystem. To reduce free-tier
inactivity sleep, `render.yaml` enables the worker's interval-based HTTP
heartbeat (`HEARTBEAT_ENABLED=true`, `HEARTBEAT_INTERVAL_MS=600000`), which
periodically requests `HEARTBEAT_URL`, `${RENDER_EXTERNAL_URL}/ping`, or the
local `/ping` endpoint. Note that Render Free still uses an ephemeral
filesystem, so JSON paper-trade and user state can still be lost on container
restarts or redeploys.

### Always-On Render Blueprint (`render.always-on.yaml`)

For genuine always-on operation on Render with persistent JSON state across
deploys and restarts:

1. Deploy `render.always-on.yaml` in Render (**New > Blueprint** and select
   `render.always-on.yaml`). It configures `plan: starter` (no inactivity
   sleep) and mounts a persistent disk at `/app/data`.
2. In Render environment settings, configure `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEB_APP_URL` (the service's public HTTPS URL), and optionally
   `STRATEGY_QUALITY_EVIDENCE` once strategy evidence is independently
   validated.
3. Configure an external uptime monitor (for example, UptimeRobot or Better
   Stack) against `GET /health` and `GET /health/signal-engine` to alert if the
   service or scanner degrades, disconnects, or sleeps.

### Free Demo Deployment (`render.yaml`)

The root `render.yaml` configures `plan: free` with `HEARTBEAT_ENABLED=true`
and `HEARTBEAT_INTERVAL_MS=600000`, running the API, static frontend, and
scanner/Telegram worker in one container and serving `/ping`, `/health`, the UI,
and `/api/*` from the same origin.

Worker heartbeat environment variables:

- `HEARTBEAT_ENABLED` — Set to `"true"` to enable the worker heartbeat pinger
  (or `"false"` to disable even if `HEARTBEAT_URL` is set).
- `HEARTBEAT_URL` — Optional explicit target URL. When omitted and enabled, the
  worker falls back to `${RENDER_EXTERNAL_URL}/ping` and then
  `http://127.0.0.1:${PORT:-3000}/ping`.
- `HEARTBEAT_INTERVAL_MS` — Interval in milliseconds between pings (default
  `600000` / 10 minutes; clamped between `10000` and `840000`).

## Health Endpoints and Restart Recovery

The API exposes `GET /ping` plus separated subsystem health endpoints backed by
the worker's persisted heartbeat file (`WORKER_HEALTH_PATH`, default
`./data/worker-health.json`). Subsystems report `HEALTHY`, `DEGRADED`,
`DISCONNECTED`, `SLEEPING`, or `RECOVERING` honestly without exposing tokens or
secrets:

- `GET /ping` — Lightweight keep-alive endpoint returning `{ "status": "ok",
  "timestamp": <epochMs> }` with `Cache-Control: no-store` (exempt from `/api/*`
  rate limits).
- `GET /health` — Overall API readiness (`status: "ok"`), combined `workerState`,
  staleness flag, hosting environment, and subsystem states.
- `GET /health/market-data` — Binance market-data connectivity, consecutive
  failures, skipped zero-duration no-trade candles, and last successful update.
- `GET /health/signal-engine` — Scan timestamps, watchlist, last processed 5-minute
  candle open time per symbol, active paper-trade count, and pending events.
- `GET /health/telegram` — Telegram bot configuration, polling status, last poll
  and delivery timestamps, pending notifications, and failed delivery count.

If the worker restarts or wakes up from sleep, startup recovery automatically
backfills missed closed 5-minute candles between each symbol's persisted ledger
checkpoint and the latest closed 5-minute bar before resuming scheduled scans,
and failed Telegram notifications are released back to `pending` for retry.
