# Telegram application

The bot uses the Telegram Bot API long-polling interface. Configure
`TELEGRAM_BOT_TOKEN` before starting it; optionally set `TELEGRAM_WEB_APP_URL`
to an HTTPS URL for the Mini App button:

```sh
TELEGRAM_BOT_TOKEN=... npm run dev --workspace apps/telegram
```

The commands support simulated-account setup and per-chat strategy preferences.
Account values, preferences, and notification event claims persist by default in
`data/telegram-state.json` (override with `TELEGRAM_STATE_PATH`). The file is
created with owner-only permissions and is excluded from Git. Run a single bot
process per state file.
The photo-required publisher validates signal details and snapshot identity
before delivery. The worker creates PNG chart snapshots and has a cost-aware
portfolio-risk preflight, but neither is wired to Telegram. Candidates are not
published as paper signals until the scanner, risk preflight, quality grading,
durable trade tracking, and chart delivery are connected end to end.

The bot polling offset and active paper-trade lifecycle are still in memory and
are lost on restart. Notification claims are persisted before sending to avoid
re-sending after a restart; if Telegram's response is ambiguous, a claim is kept
and may require manual reconciliation rather than risking a duplicate. No
exchange credentials or real-order execution are used.
