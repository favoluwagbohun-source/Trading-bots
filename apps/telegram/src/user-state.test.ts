import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TelegramUserStateStore } from "./user-state.js";

const temporaryDirectories: string[] = [];

function createStatePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "telegram-user-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.json");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TelegramUserStateStore persistence", () => {
  it("restores chat preferences and notification claims after a restart", () => {
    const filePath = createStatePath();
    const first = new TelegramUserStateStore({ filePath });
    first.setAccountEquity(-100, 2500);
    first.setPaused(-100, true);
    first.setPaperTradingEnabled(-100, true);
    first.setStrategyEnabled(-100, "liquidity_sweep_reversal", false);

    expect(first.claimNotificationEvent(-100, "event-1")).toBe(true);

    const reloaded = new TelegramUserStateStore({ filePath });
    expect(reloaded.get(-100)).toMatchObject({
      accountEquity: 2500,
      awaitingAccount: false,
      paused: true,
      paperTradingEnabled: true
    });
    expect(reloaded.isStrategyEnabled(-100, "liquidity_sweep_reversal")).toBe(false);
    expect(reloaded.claimNotificationEvent(-100, "event-1")).toBe(false);
    expect(reloaded.claimNotificationEvent(-101, "event-1")).toBe(true);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("fails explicitly when the persisted state is malformed", () => {
    const filePath = createStatePath();
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      users: { "4": { paused: "yes" } },
      notificationClaims: []
    }));

    expect(() => new TelegramUserStateStore({ filePath }))
      .toThrow("Telegram state for chat 4 is malformed");
  });

  it("migrates version-one users with automatic paper entries disabled", () => {
    const filePath = createStatePath();
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      users: {
        "5": {
          accountEquity: 1000,
          awaitingAccount: false,
          paused: false,
          enabledStrategies: ["break_and_retest"]
        }
      },
      notificationClaims: []
    }));

    const migrated = new TelegramUserStateStore({ filePath });
    expect(migrated.get(5).paperTradingEnabled).toBe(false);
    migrated.setPaperTradingEnabled(5, true);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({ version: 2 });
  });

  it("requires a configured account balance before opting in", () => {
    const states = new TelegramUserStateStore();
    expect(() => states.setPaperTradingEnabled(8, true))
      .toThrow("Set a simulated account balance");
    expect(states.get(8).paperTradingEnabled).toBe(false);
  });

  it("fails explicitly on invalid JSON instead of silently resetting users", () => {
    const filePath = createStatePath();
    writeFileSync(filePath, "{invalid");

    expect(() => new TelegramUserStateStore({ filePath }))
      .toThrow("contains invalid JSON");
    expect(readFileSync(filePath, "utf8")).toBe("{invalid");
  });
});
