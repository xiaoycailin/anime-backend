import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyPluginAsync } from "fastify";
import { redis } from "../../lib/redis";
import {
  clearHealthMetrics,
  getProviderErrorMetrics,
  getRouteAverageMs,
  getTopEndpointMetrics,
} from "../../services/health-metrics.service";
import { badRequest } from "../../utils/http-error";
import { ok } from "../../utils/response";

const execFileAsync = promisify(execFile);
const PM2_PROCESS_NAMES = ["anime-api", "anime-app", "video-proxy-go"] as const;
const PM2_ACTIONS = ["start", "stop", "restart"] as const;
const GO_PROXY_HEALTH_URL =
  process.env.GO_VIDEO_PROXY_HEALTH_URL ??
  "https://s1-eth0x01.weebin.site/healthz";

type Pm2ProcessName = (typeof PM2_PROCESS_NAMES)[number];
type Pm2Action = (typeof PM2_ACTIONS)[number];

type Pm2ActionBody = {
  processName?: string;
  action?: string;
};

type Pm2Process = {
  name?: string;
  pm2_env?: {
    status?: string;
    restart_time?: number;
    pm_uptime?: number;
  };
  monit?: {
    memory?: number;
    cpu?: number;
  };
};

function mb(bytes?: number) {
  return Number(((bytes ?? 0) / 1024 / 1024).toFixed(1));
}

async function timed<T>(task: () => Promise<T>) {
  const started = performance.now();
  const data = await task();
  return {
    data,
    latencyMs: Number((performance.now() - started).toFixed(2)),
  };
}

async function redisStatus() {
  try {
    const result = await timed(() => redis.ping());
    return {
      status: result.data === "PONG" ? "online" : "degraded",
      latencyMs: result.latencyMs,
      message: result.data,
    };
  } catch (error) {
    return {
      status: "offline",
      latencyMs: null,
      message: error instanceof Error ? error.message : "Redis error",
    };
  }
}

async function goProxyStatus() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const result = await timed(async () => {
      const response = await fetch(GO_PROXY_HEALTH_URL, {
        signal: controller.signal,
      });
      return {
        ok: response.ok,
        statusCode: response.status,
      };
    });
    return {
      status: result.data.ok ? "online" : "degraded",
      latencyMs: result.latencyMs,
      statusCode: result.data.statusCode,
      url: GO_PROXY_HEALTH_URL,
    };
  } catch (error) {
    return {
      status: "offline",
      latencyMs: null,
      statusCode: null,
      url: GO_PROXY_HEALTH_URL,
      message: error instanceof Error ? error.message : "Go proxy error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function pm2Summary() {
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"], {
      timeout: 2000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const rows = JSON.parse(stdout) as Pm2Process[];
    const wanted = new Set<string>(PM2_PROCESS_NAMES);
    return {
      status: "ok",
      rows: rows
        .filter((item) => item.name && wanted.has(item.name))
        .map((item) => ({
          name: item.name,
          status: item.pm2_env?.status ?? "unknown",
          memoryMb: mb(item.monit?.memory),
          cpu: Number((item.monit?.cpu ?? 0).toFixed(1)),
          restarts: item.pm2_env?.restart_time ?? 0,
          uptimeMs: item.pm2_env?.pm_uptime
            ? Date.now() - item.pm2_env.pm_uptime
            : null,
        })),
    };
  } catch (error) {
    return {
      status: "unavailable",
      rows: [],
      message: error instanceof Error ? error.message : "PM2 unavailable",
    };
  }
}

function assertPm2Action(body: Pm2ActionBody) {
  if (!PM2_PROCESS_NAMES.includes(body.processName as Pm2ProcessName)) {
    throw badRequest("Process PM2 tidak valid");
  }

  if (!PM2_ACTIONS.includes(body.action as Pm2Action)) {
    throw badRequest("Action PM2 tidak valid");
  }

  if (body.processName === "anime-api" && body.action === "stop") {
    throw badRequest("anime-api tidak bisa di-stop dari dashboard");
  }

  return {
    processName: body.processName as Pm2ProcessName,
    action: body.action as Pm2Action,
  };
}

async function runPm2Action(processName: Pm2ProcessName, action: Pm2Action) {
  const args = [action, processName];

  if (processName === "anime-api" && action === "restart") {
    setTimeout(() => {
      execFile("pm2", args, { windowsHide: true }, () => undefined);
    }, 250).unref();
    return { scheduled: true };
  }

  await execFileAsync("pm2", args, {
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  return { scheduled: false };
}

function apiStatus() {
  const memory = process.memoryUsage();
  return {
    status: "online",
    uptimeSec: Math.round(process.uptime()),
    memory: {
      rssMb: mb(memory.rss),
      heapUsedMb: mb(memory.heapUsed),
      heapTotalMb: mb(memory.heapTotal),
    },
    homeSectionsAvgMs: getRouteAverageMs("/api/home/sections"),
  };
}

const adminHealthRoute: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.get("/summary", async (_request, reply) => {
    const [redis, goProxy, pm2] = await Promise.all([
      redisStatus(),
      goProxyStatus(),
      pm2Summary(),
    ]);

    return ok(reply, {
      data: {
        generatedAt: new Date().toISOString(),
        api: apiStatus(),
        redis,
        goProxy,
        pm2,
        topEndpoints: getTopEndpointMetrics(),
        providerErrors: getProviderErrorMetrics(),
      },
    });
  });

  app.post("/clear", async (_request, reply) => {
    const cleared = clearHealthMetrics();
    return ok(reply, {
      message: "Health logs dibersihkan",
      data: { cleared },
    });
  });

  app.post<{ Body: Pm2ActionBody }>("/pm2/action", async (request, reply) => {
    const { processName, action } = assertPm2Action(request.body ?? {});
    const result = await runPm2Action(processName, action);

    return ok(reply, {
      message: `${processName} ${action} ${result.scheduled ? "dijadwalkan" : "berhasil"}`,
      data: {
        processName,
        action,
        scheduled: result.scheduled,
      },
    });
  });
};

export default adminHealthRoute;
