import { createApp } from "../../api/app";
import { type Running, createDeps } from "../../api/deps";

/**
 * Ponder serves this app next to its own /health, /ready, /status and /metrics. The API keeps its
 * own database pools and background loops; on a dev hot reload the previous set is disposed first
 * so nothing leaks.
 */
const holder = globalThis as typeof globalThis & { __memefunApi?: Running };
if (holder.__memefunApi) await holder.__memefunApi.dispose();
holder.__memefunApi = await createDeps();

export default createApp(holder.__memefunApi);
