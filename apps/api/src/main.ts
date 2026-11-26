import { createApiServer } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const app = await createApiServer();
await app.listen({ port, host });

process.once("SIGINT", () => {
  void app.close().catch((error: unknown) => {
    console.error("API shutdown failed:", error);
    process.exitCode = 1;
  });
});
process.once("SIGTERM", () => {
  void app.close().catch((error: unknown) => {
    console.error("API shutdown failed:", error);
    process.exitCode = 1;
  });
});
