import type { Candle } from "@crypto-signal/shared";
import type { MarketTimeframe } from "@crypto-signal/market-data";
import { evaluateQuantitativeConsistency, type QuantSignalResult } from "../../../../packages/strategies/src/index.js";
import { formatPrice } from "../chart-state.js";
import type { ChartTradeOverlay } from "../chart-state.js";

interface QuantSignalsViewProps {
  readonly symbol: string;
  readonly timeframe: MarketTimeframe;
  readonly candles: readonly Candle[];
  readonly onPlotTrade: (overlay: ChartTradeOverlay) => void;
}

export function QuantSignalsView({
  symbol,
  timeframe,
  candles,
  onPlotTrade
}: QuantSignalsViewProps) {
  const signals = evaluateQuantitativeConsistency({
    symbol,
    timeframe,
    candles
  });

  return (
    <section className="surface-card" aria-label="Quantitative trading signals">
      <div className="subblock-header">
        <div>
          <h3>Quantitative Consistency &amp; Signal Engine</h3>
          <p className="muted-copy">
            Deterministic ATR volatility filtering, momentum displacement, and mathematical expectancy scoring.
          </p>
        </div>
        <span className="mono-label">{signals.length} signals generated</span>
      </div>

      {signals.length === 0 ? (
        <div className="empty-state-panel">
          No qualifying quantitative consistency signals in current {timeframe} window.
        </div>
      ) : (
        <div className="stacked-list">
          {signals.map((sig) => {
            const isBuy = sig.side === "buy";
            return (
              <article key={sig.id} className="surface-card" style={{ background: "var(--bg)" }}>
                <div className="card-top-line">
                  <div className="tf-matrix-left">
                    <strong className={isBuy ? "tone-bullish" : "tone-bearish"}>
                      {sig.side.toUpperCase()} · {sig.strategy.replace(/_/g, " ").toUpperCase()}
                    </strong>
                    <span className="mono-meta">{sig.timeframe}</span>
                  </div>
                  <div className="metric-strip-inline">
                    <span>Consistency: <strong>{sig.consistencyScore}%</strong></span>
                    <span>Expectancy: <strong className={sig.expectancyScore >= 1 ? "tone-bullish" : "tone-caution"}>{sig.expectancyScore}R</strong></span>
                  </div>
                </div>

                <div className="metric-strip-inline" style={{ fontSize: "13px" }}>
                  <span>Entry {formatPrice(sig.entryPrice)}</span>
                  <span>Stop {formatPrice(sig.stopLoss)}</span>
                  <span>TP1 {formatPrice(sig.target1)}</span>
                  <span>TP2 {formatPrice(sig.target2)}</span>
                </div>

                <p className="muted-copy">{sig.rationale}</p>

                <div className="card-footer-row">
                  <span className="mono-meta">Confidence: {sig.confidence.toUpperCase()}</span>
                  <button
                    type="button"
                    className="primary-cta"
                    onClick={() =>
                      onPlotTrade({
                        symbol: sig.symbol,
                        strategy: sig.strategy,
                        side: sig.side === "buy" ? "long" : "short",
                        entryPrice: sig.entryPrice,
                        stopPrice: sig.stopLoss,
                        target1: sig.target1,
                        target2: sig.target2,
                        label: `Quant Signal (${sig.consistencyScore}% score)`
                      })
                    }
                  >
                    Plot Quant Signal
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
