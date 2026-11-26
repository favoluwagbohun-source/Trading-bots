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
