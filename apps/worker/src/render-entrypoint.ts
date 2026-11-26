import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const services = [
  { name: "API", entrypoint: "apps/api/dist/main.js" },
  { name: "Worker", entrypoint: "apps/worker/dist/main.js" }
] as const;
const children: ChildProcess[] = [];
let stopping = false;
let shutdownTimer: NodeJS.Timeout | undefined;

function allChildrenExited(): boolean {
  return children.every((child) => child.exitCode !== null || child.signalCode !== null);
}

function stopChildren(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
  shutdownTimer = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 20_000);
  shutdownTimer.unref();
}

process.once("SIGINT", () => stopChildren("SIGINT"));
process.once("SIGTERM", () => stopChildren("SIGTERM"));

for (const service of services) {
  const child = spawn(
    process.execPath,
    [resolve(process.cwd(), service.entrypoint)],
    { stdio: "inherit" }
  );
  children.push(child);
  child.once("error", (error: Error) => {
    console.error(`${service.name} failed to start:`, error);
    process.exitCode = 1;
    stopChildren("SIGTERM");
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(
        `${service.name} exited unexpectedly (code ${code ?? "none"}, signal ${signal ?? "none"}).`
      );
      process.exitCode = code ?? 1;
      stopChildren("SIGTERM");
    }
    if (stopping && allChildrenExited()) {
      if (shutdownTimer) clearTimeout(shutdownTimer);
      process.exitCode ??= 0;
    }
  });
}
