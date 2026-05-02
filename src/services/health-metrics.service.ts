import type { FastifyReply, FastifyRequest } from "fastify";

const WINDOW_MS = 60 * 60 * 1000;
const MAX_EVENTS = 15_000;
const HEALTH_PATH = "/api/admin/health";

type MetricEvent = {
  at: number;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  provider?: string | null;
  errorMessage?: string | null;
};

export type EndpointMetric = {
  route: string;
  method: string;
  hits: number;
  avgMs: number;
  p95Ms: number;
  errorCount: number;
};

export type ProviderErrorMetric = {
  provider: string;
  totalErrors: number;
  lastStatusCode: number;
  lastError: string | null;
  lastAt: string;
};

let events: MetricEvent[] = [];

function now() {
  return Date.now();
}

function prune(current = now()) {
  const since = current - WINDOW_MS;
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  if (events[0]?.at && events[0].at < since) {
    events = events.filter((item) => item.at >= since);
  }
}

function normalizeRoute(request: FastifyRequest) {
  return request.url.split("?")[0] || "/";
}

function providerFromRoute(route: string) {
  const match = route.match(/\/api\/video-stream\/([^/]+)/);
  if (!match) return null;
  return match[1].replace(/-stream$/, "");
}

export function recordRequestMetric(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const route = normalizeRoute(request);
  if (route.startsWith(HEALTH_PATH)) return;

  const statusCode = reply.statusCode;
  const durationMs = Number(reply.elapsedTime.toFixed(2));
  const provider = providerFromRoute(route);
  const shouldKeep =
    route.startsWith("/api") || Boolean(provider) || statusCode >= 500;

  if (!shouldKeep) return;

  events.push({
    at: now(),
    method: request.method,
    route,
    statusCode,
    durationMs,
    provider,
    errorMessage: statusCode >= 400 ? reply.statusCode.toString() : null,
  });
  prune();
}

function percentile(values: number[], percent: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percent / 100) * sorted.length) - 1,
  );
  return sorted[index] ?? 0;
}

export function getTopEndpointMetrics(limit = 12): EndpointMetric[] {
  prune();
  const grouped = new Map<string, MetricEvent[]>();

  for (const event of events) {
    const key = `${event.method} ${event.route}`;
    const list = grouped.get(key) ?? [];
    list.push(event);
    grouped.set(key, list);
  }

  return [...grouped.entries()]
    .map(([key, list]) => {
      const [method, ...routeParts] = key.split(" ");
      const durations = list.map((item) => item.durationMs);
      const total = durations.reduce((sum, value) => sum + value, 0);
      return {
        method,
        route: routeParts.join(" "),
        hits: list.length,
        avgMs: Number((total / Math.max(1, list.length)).toFixed(2)),
        p95Ms: Number(percentile(durations, 95).toFixed(2)),
        errorCount: list.filter((item) => item.statusCode >= 400).length,
      };
    })
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit);
}

export function getProviderErrorMetrics(): ProviderErrorMetric[] {
  prune();
  const grouped = new Map<string, MetricEvent[]>();

  for (const event of events) {
    if (!event.provider || event.statusCode < 400) continue;
    const list = grouped.get(event.provider) ?? [];
    list.push(event);
    grouped.set(event.provider, list);
  }

  return [...grouped.entries()]
    .map(([provider, list]) => {
      const last = list.reduce((latest, item) =>
        item.at > latest.at ? item : latest,
      );
      return {
        provider,
        totalErrors: list.length,
        lastStatusCode: last.statusCode,
        lastError: last.errorMessage ?? null,
        lastAt: new Date(last.at).toISOString(),
      };
    })
    .sort((a, b) => b.totalErrors - a.totalErrors);
}

export function getRouteAverageMs(route: string) {
  prune();
  const matches = events.filter((event) => event.route === route);
  if (!matches.length) return null;
  const total = matches.reduce((sum, event) => sum + event.durationMs, 0);
  return Number((total / matches.length).toFixed(2));
}

export function clearHealthMetrics() {
  const cleared = events.length;
  events = [];
  return cleared;
}
