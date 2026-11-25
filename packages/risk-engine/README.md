# Risk-engine package

Stage 7 implements risk sizing and central paper-portfolio admission.

- Fixed account risk of 1% per proposed position; caller cannot override it.
- Position quantities round down to instrument step and observe min/max limits.
- Estimated entry/exit fees and adverse slippage are included in risk and target
  reward calculations.
- A position is rejected if its net TP2 reward/risk is below 2:1, its size
  violates instrument constraints, or estimated stop loss exceeds risk budget.
- Portfolio admission enforces one open trade per symbol, duplicate signal
  prevention, configurable trade/exposure/daily/weekly limits, and
  caller-assigned correlation groups.

The portfolio manager is in-memory. Durable account state and cross-process
idempotency require the later database/persistence stages.
