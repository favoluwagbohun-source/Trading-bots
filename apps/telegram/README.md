# Telegram application

The bot uses the Telegram Bot API long-polling interface. Configure
`TELEGRAM_BOT_TOKEN` before starting it; optionally set `TELEGRAM_WEB_APP_URL`
to an HTTPS URL for the Mini App button:

```sh
TELEGRAM_BOT_TOKEN=... npm run dev --workspace apps/telegram
```

The commands support simulated-account setup, per-chat strategy preferences,
and explicit `/paper on|off` opt-in. The supported combined scanner and Telegram
runtime is `apps/worker`; configure its environment as described in
[`../worker/README.md`](../worker/README.md). Running `apps/telegram` directly
starts the command-only bot and does not run the market scanner. Do not run both
processes with the same state paths.

Account values, preferences, and notification event claims persist by default
in `data/telegram-state.json` (override with `TELEGRAM_STATE_PATH`). The file is
created with owner-only permissions and is excluded from Git. Telegram signal
publication requires a matching chart image, Grade B+ evidence, risk-approved
position sizing, and durable paper-trade tracking. The publisher does not place
exchange orders.

The bot polling offset is in memory and is lost on restart. Notification claims
are persisted before sending to avoid re-sending after a restart; if Telegram's
response is ambiguous, a claim is kept and may require manual reconciliation
rather than risking a duplicate. No exchange credentials or real-order
execution are used.
