import { BinanceRestClient } from "@crypto-signal/market-data";
import { SignalScanner } from "./signal-scanner.js";

function parseWatchlist(value: string | undefined): string[] {
  if (!value) throw new Error("Set WATCHLIST_SYMBOLS to a comma-separated Binance symbol list");
  return value.split(",").map((symbol) => symbol.trim()).filter(Boolean);
}

function parseScanInterval(value: string | undefined): number {
  if (value === undefined) return 30_000;
  const interval = Number(value);
  if (!Number.isInteger(interval) || interval < 5_000) {
    throw new Error("SCAN_INTERVAL_MS must be an integer of at least 5000");
  }
  return interval;
}

const controller = new AbortController();
const scanner = new SignalScanner({
  symbols: parseWatchlist(process.env.WATCHLIST_SYMBOLS),
  client: new BinanceRestClient(),
  scanIntervalMs: parseScanInterval(process.env.SCAN_INTERVAL_MS),
  onCandidate: (candidate) => {
    console.info(
      `Candidate detected: ${candidate.symbol} ${candidate.strategy} ${candidate.side} at ${candidate.signalCandle.closeTime}; awaiting downstream publication gates.`
    );
  },
  onError: (symbol, error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Scan failed for ${symbol}: ${message}`);
  }
});

process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
await scanner.run(controller.signal);
