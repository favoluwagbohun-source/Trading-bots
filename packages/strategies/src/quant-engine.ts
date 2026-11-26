import type { Candle, StrategyId } from "@crypto-signal/shared";
export type MarketTimeframe = string;

export interface QuantSignalResult {
  readonly id: string;
  readonly timestamp: number;
  readonly symbol: string;
  readonly timeframe: MarketTimeframe;
  readonly strategy: StrategyId;
  readonly side: "buy" | "sell";
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly target1: number;
  readonly target2: number;
  readonly riskRewardRatio: number;
  readonly consistencyScore: number; // 0 to 100 based on multi-timeframe confirmation & volatility filter
  readonly expectancyScore: number;
  readonly regime: "bullish" | "bearish" | "ranging" | "high_volatility";
  readonly confidence: "high" | "moderate" | "low";
  readonly rationale: string;
}

function calculateAtr(candles: readonly Candle[], period = 14): number[] {
  if (candles.length === 0) return [];
  const atrValues: number[] = [];
  let sumTr = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = i > 0 ? candles[i - 1]! : c;
    const tr = Math.max(
      Number(c.high) - Number(c.low),
      Math.abs(Number(c.high) - Number(prev.close)),
      Math.abs(Number(c.low) - Number(prev.close))
    );
    if (i < period) {
      sumTr += tr;
      atrValues.push(sumTr / (i + 1));
    } else {
      const prevAtr = atrValues[i - 1]!;
      const currAtr = (prevAtr * (period - 1) + tr) / period;
      atrValues.push(currAtr);
    }
  }
  return atrValues;
}

export function evaluateQuantitativeConsistency(input: {
  readonly symbol: string;
  readonly timeframe: MarketTimeframe;
  readonly candles: readonly Candle[];
  readonly higherTimeframeBias?: "bullish" | "bearish" | "neutral";
}): readonly QuantSignalResult[] {
  const { symbol, timeframe, candles, higherTimeframeBias = "neutral" } = input;
  if (candles.length < 25) return [];

  const atrs = calculateAtr(candles, 14);
  const results: QuantSignalResult[] = [];

  // Scan recent closed candles for high-expectancy quant setups
  const startIndex = Math.max(14, candles.length - 10);
  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle || !candle.closed) continue;

    const atr = atrs[i] ?? Number(candle.high) - Number(candle.low);
    const open = Number(candle.open);
    const close = Number(candle.close);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const body = Math.abs(close - open);
    const range = high - low;

    if (range <= 0 || atr <= 0) continue;

    const prevClose = Number(candles[i - 1]?.close ?? open);
    const isBullishMomentum = close > open && body > atr * 0.85 && body / range >= 0.52 && close > prevClose;
    const isBearishMomentum = close < open && body > atr * 0.85 && body / range >= 0.52 && close < prevClose;

    if (!isBullishMomentum && !isBearishMomentum) continue;

    const side = isBullishMomentum ? "buy" : "sell";
    const volume = Number(candle.volume);
    const lookback = candles.slice(Math.max(0, i - 10), i);
    const avgVol = lookback.length > 0
      ? lookback.reduce((acc, c) => acc + Number(c.volume), 0) / lookback.length
      : volume;
    const volRatio = avgVol > 0 ? volume / avgVol : 1;

    const biasAligned =
      (higherTimeframeBias === "bullish" && side === "buy") ||
      (higherTimeframeBias === "bearish" && side === "sell");
    const biasOpposed =
      (higherTimeframeBias === "bullish" && side === "sell") ||
      (higherTimeframeBias === "bearish" && side === "buy");

    if (biasOpposed && volRatio < 1.1 && body <= atr * 1.1) continue;

    const entryPrice = close;
    const stopBuffer = atr * 0.5;
    const stopLoss = side === "buy" ? low - stopBuffer : high + stopBuffer;
    const risk = Math.abs(entryPrice - stopLoss);
    if (risk <= 0) continue;

    const target1 = side === "buy" ? entryPrice + risk * 1.5 : entryPrice - risk * 1.5;
    const target2 = side === "buy" ? entryPrice + risk * 2.5 : entryPrice - risk * 2.5;
    const riskRewardRatio = 2.0;

    let consistencyScore = 72;
    if (volRatio > 1.2) consistencyScore += 10;
    if (body > atr * 1.1) consistencyScore += 6;
    if (biasAligned) consistencyScore += 10;
    else if (biasOpposed) consistencyScore -= 6;
    consistencyScore = Math.max(55, Math.min(98, consistencyScore));

    const expectancyScore = Number((riskRewardRatio * (consistencyScore / 100) - (1 - consistencyScore / 100)).toFixed(2));

    results.push({
      id: `${symbol}:${timeframe}:${candle.openTime}:${side}`,
      timestamp: candle.closeTime,
      symbol: symbol.toUpperCase(),
      timeframe,
      strategy: isBullishMomentum ? "break_and_retest" : "liquidity_sweep_reversal",
      side,
      entryPrice,
      stopLoss,
      target1,
      target2,
      riskRewardRatio,
      consistencyScore,
      expectancyScore,
      regime: volRatio > 1.5 ? "high_volatility" : "ranging",
      confidence: consistencyScore >= 85 ? "high" : "moderate",
      rationale: `Deterministic quantitative momentum confirmation on ${timeframe} with ATR volatility filter (${(atr / entryPrice * 100).toFixed(2)}%) and volume multiplier ${volRatio.toFixed(2)}x.`
    });
  }

  return results;
}
