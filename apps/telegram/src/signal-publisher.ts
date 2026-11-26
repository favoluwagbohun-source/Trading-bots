import type { StrategyId } from "@crypto-signal/shared";
import type { TelegramApiClient } from "./telegram-api.js";
import type { TelegramUserStateStore } from "./user-state.js";

export type StrategyGrade = "A" | "B" | "C" | "D";

export interface SignalChartAttachment {
  readonly snapshotId: string;
  readonly image: Blob;
}

export interface PreparedPaperSignal {
  readonly signalId: string;
  readonly snapshotId: string;
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly strategy: StrategyId;
  readonly higherTimeframeBias: string;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly target1: number;
  readonly target2: number;
  readonly target3: "trailing_runner";
  readonly quantity: number;
  readonly accountEquity: number;
  readonly estimatedMaximumLoss: number;
  readonly minimumRiskReward: number;
  readonly qualityScore: number;
  readonly strategyGrade: StrategyGrade;
}

export interface PaperTradeUpdate {
  readonly eventId: string;
  readonly snapshotId: string;
  readonly symbol: string;
  readonly event: string;
  readonly details: string;
}

function assertPhotoMatchesSnapshot(
  snapshotId: string,
  chart: SignalChartAttachment
): void {
  if (!snapshotId || chart.snapshotId !== snapshotId) {
    throw new Error("Signal and chart image must use the same market snapshot");
  }
  if (chart.image.size === 0) throw new Error("A chart image is required for every signal");
}

function signalCaption(signal: PreparedPaperSignal): string {
  const entryRisk = Math.abs(signal.entryPrice - signal.stopLoss);
  const reward = Math.abs(signal.target2 - signal.entryPrice);
  const geometricRiskReward = reward / entryRisk;
  return [
    `${signal.symbol} — ${signal.side.toUpperCase()}`,
    `Strategy: ${signal.strategy.replaceAll("_", " ")}.`,
    "Execution timeframe: 5M.",
    `Higher-timeframe bias: ${signal.higherTimeframeBias}.`,
    `Entry: ${signal.entryPrice}.`,
    `Stop Loss: ${signal.stopLoss}.`,
    `TP1: ${signal.target1}.`,
    `TP2: ${signal.target2}.`,
    "TP3: Trailing runner.",
    `Risk budget: 1% of simulated equity (${signal.accountEquity * 0.01}); estimated maximum loss: ${signal.estimatedMaximumLoss}.`,
    `Position size: ${signal.quantity}.`,
    `Risk/Reward: at least 1:2 (TP2 ${geometricRiskReward.toFixed(2)}R).`,
    `Signal quality: ${signal.qualityScore}/100 · Grade ${signal.strategyGrade} (not a win probability).`,
    "Status: PAPER TRADE ACTIVE."
  ].join("\n");
}

export class TelegramSignalPublisher {
  constructor(
    private readonly api: Pick<TelegramApiClient, "sendPhoto">,
    private readonly users: TelegramUserStateStore
  ) {}

  async publishSignal(
    chatId: number,
    signal: PreparedPaperSignal,
    chart: SignalChartAttachment
  ): Promise<boolean> {
    const state = this.users.get(chatId);
    if (state.accountEquity === undefined) {
      throw new Error("Set a simulated account before receiving paper signals");
    }
    if (state.paused || !state.enabledStrategies.includes(signal.strategy)) return false;
    this.validateSignal(signal);
    assertPhotoMatchesSnapshot(signal.snapshotId, chart);

    const eventKey = `signal:${signal.signalId}`;
    if (!this.users.claimNotificationEvent(chatId, eventKey)) return false;
    await this.api.sendPhoto(
      chatId,
      chart.image,
      signalCaption(signal)
    );
    return true;
  }

  async publishTradeUpdate(
    chatId: number,
    update: PaperTradeUpdate,
    chart: SignalChartAttachment
  ): Promise<boolean> {
    const eventKey = `event:${update.eventId}`;
    assertPhotoMatchesSnapshot(update.snapshotId, chart);
    if (!update.details.trim() || !update.event.trim() || !update.symbol.trim()) {
      throw new Error("Paper-trade update details are required");
    }
    if (!this.users.claimNotificationEvent(chatId, eventKey)) return false;
    await this.api.sendPhoto(
      chatId,
      chart.image,
      `${update.symbol.toUpperCase()} — ${update.event}\n${update.details}`
    );
    return true;
  }

  private validateSignal(signal: PreparedPaperSignal): void {
    const prices = [
      signal.entryPrice,
      signal.stopLoss,
      signal.target1,
      signal.target2,
      signal.quantity,
      signal.accountEquity,
      signal.estimatedMaximumLoss,
      signal.minimumRiskReward,
      signal.qualityScore
    ];
    if (
      !signal.signalId.trim() ||
      !/^[A-Z0-9]{6,20}$/.test(signal.symbol) ||
      !signal.higherTimeframeBias.trim() ||
      !prices.every(Number.isFinite) ||
      prices.slice(0, 7).some((value) => value <= 0) ||
      signal.qualityScore < 0 ||
      signal.qualityScore > 100 ||
      signal.minimumRiskReward < 2 ||
      signal.estimatedMaximumLoss > signal.accountEquity * 0.01 + 1e-8 ||
      !["A", "B"].includes(signal.strategyGrade)
    ) {
      throw new Error("Paper signal failed quality, risk, or position validation");
    }

    const risk = signal.side === "buy"
      ? signal.entryPrice - signal.stopLoss
      : signal.stopLoss - signal.entryPrice;
    const reward = signal.side === "buy"
      ? signal.target2 - signal.entryPrice
      : signal.entryPrice - signal.target2;
    const target1InDirection = signal.side === "buy"
      ? signal.target1 > signal.entryPrice && signal.target1 < signal.target2
      : signal.target1 < signal.entryPrice && signal.target1 > signal.target2;
    if (
      risk <= 0 ||
      reward <= 0 ||
      !target1InDirection ||
      reward / risk < 2
    ) {
      throw new Error("Paper signal does not meet the minimum 1:2 risk/reward");
    }
  }
}
