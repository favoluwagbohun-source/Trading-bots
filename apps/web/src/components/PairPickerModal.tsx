import { useState, type FormEvent } from "react";
import { normalizeChartSymbol } from "../chart-state.js";

interface PairPickerModalProps {
  readonly open: boolean;
  readonly currentSymbol: string;
  readonly pairs: readonly string[];
  readonly onSelect: (symbol: string) => void;
  readonly onClose: () => void;
}

export function PairPickerModal({
  open,
  currentSymbol,
  pairs,
  onSelect,
  onClose
}: PairPickerModalProps) {
  const [customInput, setCustomInput] = useState(currentSymbol);
  const [validationError, setValidationError] = useState<string | null>(null);

  if (!open) return null;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = normalizeChartSymbol(customInput);
    if (!normalized) {
      setValidationError("Enter a valid Binance symbol such as BTCUSDT or SOLUSDT.");
      return;
    }
    setValidationError(null);
    onSelect(normalized);
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="pair-picker-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Select trading pair"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-grab-handle" aria-hidden="true" />
        <div className="sheet-header">
          <div>
            <h3>Select Market Pair</h3>
            <p className="muted-meta">Binance public spot pairs</p>
          </div>
          <button type="button" className="quiet-button" onClick={onClose}>
            Close
          </button>
        </div>

        <form className="pair-search-form" onSubmit={handleSubmit}>
          <input
            aria-label="Custom trading pair"
            placeholder="e.g. BTCUSDT, ETHUSDT"
            value={customInput}
            onChange={(event) => setCustomInput(event.target.value)}
            spellCheck={false}
          />
          <button type="submit" className="primary-cta">
            Load Pair
          </button>
        </form>

        {validationError && <p className="inline-alert">{validationError}</p>}

        <div className="pair-grid">
          {pairs.map((item) => (
            <button
              key={item}
              type="button"
              className={item === currentSymbol ? "pair-tile active" : "pair-tile"}
              onClick={() => {
                onSelect(item);
                onClose();
              }}
            >
              <strong className="mono-label">{item}</strong>
              <span className="muted-meta">Spot</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
