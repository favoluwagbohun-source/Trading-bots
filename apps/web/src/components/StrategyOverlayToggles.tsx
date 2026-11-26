import type { OverlayLens } from "../chart-overlays.js";

interface StrategyOverlayTogglesProps {
  readonly enabledStrategies: ReadonlySet<OverlayLens | "swings">;
  readonly onToggle: (strategy: OverlayLens | "swings") => void;
  readonly onSelectAll: (enable: boolean) => void;
}

const STRATEGY_TOGGLE_ITEMS: readonly { readonly id: OverlayLens | "swings"; readonly label: string; readonly desc: string }[] = [
  { id: "top_down_trendline", label: "Top-Down Trendlines", desc: "4H support & resistance touchpoints (▲/▼)" },
  { id: "break_and_retest", label: "Break & Retest", desc: "Key swing structure levels & breakout zones" },
  { id: "liquidity_sweep_reversal", label: "Liquidity Sweep", desc: "BSL highs & SSL lows" },
  { id: "order_block_retest", label: "Order Blocks", desc: "Unmitigated demand & supply displacement origins" },
  { id: "swings", label: "Swing Structure", desc: "HH / LH / HL / LL pivot markers" }
];

export function StrategyOverlayToggles({
  enabledStrategies,
  onToggle,
  onSelectAll
}: StrategyOverlayTogglesProps) {
  const allEnabled = STRATEGY_TOGGLE_ITEMS.every((item) => enabledStrategies.has(item.id));

  return (
    <div className="strategy-toggles-card" aria-label="Strategy overlay toggles">
      <div className="subblock-header">
        <h3>Technical Overlays</h3>
        <button
          type="button"
          className="quiet-button"
          onClick={() => onSelectAll(!allEnabled)}
        >
          {allEnabled ? "Disable All" : "Enable All"}
        </button>
      </div>
      <p className="muted-copy">
        Toggle individual trading strategies and structural overlays on or off to customize the active chart view.
      </p>
      <div className="strategy-toggle-grid">
        {STRATEGY_TOGGLE_ITEMS.map((item) => {
          const active = enabledStrategies.has(item.id);
          return (
            <button
              key={item.id}
              type="button"
              className={active ? "strategy-toggle-tile active" : "strategy-toggle-tile"}
              onClick={() => onToggle(item.id)}
              aria-pressed={active}
            >
              <div className="strategy-toggle-top">
                <span className={`strategy-checkbox ${active ? "checked" : ""}`} aria-hidden="true" />
                <strong>{item.label}</strong>
              </div>
              <span className="strategy-toggle-desc">{item.desc}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
