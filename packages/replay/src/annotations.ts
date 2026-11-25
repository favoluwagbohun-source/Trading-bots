import { CandleReplaySession } from "./replay-session.js";

export interface ManualTrendline {
  readonly id: string;
  readonly kind: "trendline";
  readonly startTime: number;
  readonly startPrice: number;
  readonly endTime: number;
  readonly endPrice: number;
}

export interface ManualHorizontalLevel {
  readonly id: string;
  readonly kind: "horizontal_level";
  readonly price: number;
  readonly createdAt: number;
  readonly label?: string;
}

export interface ManualZone {
  readonly id: string;
  readonly kind: "zone";
  readonly direction: "supply" | "demand";
  readonly low: number;
  readonly high: number;
  readonly startTime: number;
  readonly endTime?: number;
}

export type ReplayAnnotation = ManualTrendline | ManualHorizontalLevel | ManualZone;

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

export class ReplayAnnotations {
  private readonly annotations = new Map<string, ReplayAnnotation>();

  constructor(private readonly replay: CandleReplaySession) {}

  addTrendline(
    annotation: Omit<ManualTrendline, "kind">
  ): ManualTrendline {
    const id = this.normalizeId(annotation.id);
    this.assertVisibleTime(annotation.startTime);
    this.assertVisibleTime(annotation.endTime);
    if (annotation.endTime <= annotation.startTime) {
      throw new Error("Trendline endTime must be after startTime");
    }
    assertPositive(annotation.startPrice, "startPrice");
    assertPositive(annotation.endPrice, "endPrice");
    const stored: ManualTrendline = Object.freeze({ ...annotation, id, kind: "trendline" });
    this.store(stored);
    return stored;
  }

  addHorizontalLevel(
    annotation: Omit<ManualHorizontalLevel, "kind">
  ): ManualHorizontalLevel {
    const id = this.normalizeId(annotation.id);
    this.assertVisibleTime(annotation.createdAt);
    assertPositive(annotation.price, "price");
    const stored: ManualHorizontalLevel = Object.freeze({
      ...annotation,
      id,
      kind: "horizontal_level"
    });
    this.store(stored);
    return stored;
  }

  addZone(annotation: Omit<ManualZone, "kind">): ManualZone {
    const id = this.normalizeId(annotation.id);
    this.assertVisibleTime(annotation.startTime);
    if (annotation.endTime !== undefined) this.assertVisibleTime(annotation.endTime);
    assertPositive(annotation.low, "low");
    assertPositive(annotation.high, "high");
    if (annotation.low >= annotation.high) {
      throw new Error("Zone low must be below zone high");
    }
    if (annotation.endTime !== undefined && annotation.endTime <= annotation.startTime) {
      throw new Error("Zone endTime must be after startTime");
    }
    const stored: ManualZone = Object.freeze({ ...annotation, id, kind: "zone" });
    this.store(stored);
    return stored;
  }

  remove(id: string): void {
    if (!this.annotations.delete(id)) {
      throw new Error(`Unknown replay annotation: ${id}`);
    }
  }

  snapshot(): readonly ReplayAnnotation[] {
    return Object.freeze([...this.annotations.values()].map((item) =>
      Object.freeze({ ...item })
    ));
  }

  private normalizeId(id: string): string {
    const normalized = id.trim();
    if (!normalized) throw new Error("Annotation id is required");
    if (this.annotations.has(normalized)) {
      throw new Error(`Duplicate replay annotation: ${normalized}`);
    }
    return normalized;
  }

  private assertVisibleTime(timestamp: number): void {
    if (
      !Number.isFinite(timestamp) ||
      timestamp > this.replay.snapshot().currentCandle.closeTime
    ) {
      throw new Error("Annotations cannot reference a future replay timestamp");
    }
  }

  private store(annotation: ReplayAnnotation): void {
    this.annotations.set(annotation.id, annotation);
  }
}
