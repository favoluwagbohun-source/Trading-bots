# Telegram application

The bot uses the Telegram Bot API long-polling interface. Configure
`TELEGRAM_BOT_TOKEN` before starting it; optionally set `TELEGRAM_WEB_APP_URL`
to an HTTPS URL for the Mini App button:

```sh
TELEGRAM_BOT_TOKEN=... npm run dev --workspace apps/telegram
```

The commands support simulated-account setup and per-chat strategy preferences.
The photo-required publisher validates signal details and snapshot identity
before delivery. The worker creates PNG chart snapshots and has a cost-aware
portfolio-risk preflight, but neither is wired to Telegram. Candidates are not
published as paper signals until the scanner, risk preflight, quality grading,
durable trade tracking, and chart delivery are connected end to end.

Chat settings, bot polling offset, and duplicate-delivery tracking are currently
in memory only and are lost on restart. No exchange credentials or real-order
execution are used.
