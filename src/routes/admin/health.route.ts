import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
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
const DEPLOY_TARGETS = ["backend", "frontend", "go-proxy"] as const;
const GO_PROXY_HEALTH_URL =
  process.env.GO_VIDEO_PROXY_HEALTH_URL ??
  "https://s1-eth0x01.weebin.site/healthz";

type Pm2ProcessName = (typeof PM2_PROCESS_NAMES)[number];
type Pm2Action = (typeof PM2_ACTIONS)[number];

type Pm2ActionBody = {
  processName?: string;
  action?: string;
};

type DeployTarget = (typeof DEPLOY_TARGETS)[number];

type DeployBody = {
  target?: string;
};

type DeployStatus = "running" | "success" | "failed";

type DeployJob = {
  id: string;
  target: DeployTarget;
  status: DeployStatus;
  exitCode?: number | null;
  startedAt: string;
  finishedAt?: string | null;
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

function deployPath(target: DeployTarget) {
  if (target === "backend") {
    return process.env.BACKEND_DEPLOY_PATH || process.cwd();
  }

  if (target === "go-proxy") {
    return (
      process.env.GO_PROXY_DEPLOY_PATH ||
      path.resolve(process.cwd(), "video-proxy-go")
    );
  }

  return (
    process.env.FRONTEND_DEPLOY_PATH ||
    path.resolve(process.cwd(), "..", "frontend-app")
  );
}

function deployLogDir() {
  return process.env.DEPLOY_LOG_DIR || path.resolve(process.cwd(), "data", "deploy-logs");
}

function deployJobPaths(id: string) {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
  const dir = deployLogDir();
  return {
    log: path.join(dir, `${safeId}.log`),
    status: path.join(dir, `${safeId}.json`),
  };
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function writeDeployStatus(job: DeployJob) {
  const paths = deployJobPaths(job.id);
  await fs.mkdir(path.dirname(paths.status), { recursive: true });
  await fs.writeFile(paths.status, JSON.stringify(job, null, 2));
}

async function readDeployJob(id: string) {
  const paths = deployJobPaths(id);
  const [statusRaw, logRaw] = await Promise.all([
    fs.readFile(paths.status, "utf8"),
    fs.readFile(paths.log, "utf8").catch(() => ""),
  ]);

  return {
    ...(JSON.parse(statusRaw) as DeployJob),
    log: logRaw.slice(-80_000),
  };
}

async function latestDeployJob(target?: DeployTarget) {
  const dir = deployLogDir();
  const files = await fs.readdir(dir).catch(() => []);
  const jobs = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) =>
        fs
          .readFile(path.join(dir, file), "utf8")
          .then((raw) => JSON.parse(raw) as DeployJob)
          .catch(() => null),
      ),
  );

  return jobs
    .filter((job): job is DeployJob => Boolean(job))
    .filter((job) => !target || job.target === target)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
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

async function gitInfo(target: DeployTarget) {
  const cwd = deployPath(target);
  const runGit = async (args: string[]) => {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 2500,
      windowsHide: true,
      maxBuffer: 512 * 1024,
    });
    return stdout.trim();
  };

  try {
    const [branch, commit, subject, committedAt, dirty] = await Promise.all([
      runGit(["branch", "--show-current"]),
      runGit(["rev-parse", "--short=8", "HEAD"]),
      runGit(["log", "-1", "--format=%s"]),
      runGit(["log", "-1", "--format=%cI"]),
      runGit(["status", "--short"]),
    ]);

    return {
      target,
      status: "ok",
      path: cwd,
      branch,
      commit,
      subject,
      committedAt,
      dirty: dirty.length > 0,
    };
  } catch (error) {
    return {
      target,
      status: "unavailable",
      path: cwd,
      message: error instanceof Error ? error.message : "Git unavailable",
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

function assertDeployTarget(body: DeployBody) {
  if (!DEPLOY_TARGETS.includes(body.target as DeployTarget)) {
    throw badRequest("Target deploy tidak valid");
  }

  return body.target as DeployTarget;
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

async function runDeploy(target: DeployTarget) {
  const cwd = deployPath(target);
  const script = process.env.DEPLOY_SCRIPT_NAME || "deploy.sh";
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const paths = deployJobPaths(id);

  await fs.mkdir(path.dirname(paths.log), { recursive: true });
  await fs.writeFile(paths.log, `[${startedAt}] deploy ${target} queued\n`);
  await writeDeployStatus({
    id,
    target,
    status: "running",
    exitCode: null,
    startedAt,
    finishedAt: null,
  });

  const logPath = shellQuote(paths.log);
  const statusPath = shellQuote(paths.status);
  const scriptPath = shellQuote(path.join(cwd, script));
  const command = [
    `echo "[$(date -Iseconds)] running ${script}" >> ${logPath}`,
    `bash ${scriptPath} >> ${logPath} 2>&1`,
    "code=$?",
    `state=$([ "$code" -eq 0 ] && echo success || echo failed)`,
    `printf '{"id":"${id}","target":"${target}","status":"%s","exitCode":%s,"startedAt":"${startedAt}","finishedAt":"%s"}' "$state" "$code" "$(date -Iseconds)" > ${statusPath}`,
    `echo "[$(date -Iseconds)] finished with exit $code" >> ${logPath}`,
  ].join("; ");

  const child = spawn("bash", ["-lc", command], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  return { id, target, scheduled: true };
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
    const [
      redis,
      goProxy,
      pm2,
      backendDeploy,
      frontendDeploy,
      goProxyDeploy,
    ] = await Promise.all([
      redisStatus(),
      goProxyStatus(),
      pm2Summary(),
      gitInfo("backend"),
      gitInfo("frontend"),
      gitInfo("go-proxy"),
    ]);

    return ok(reply, {
      data: {
        generatedAt: new Date().toISOString(),
        api: apiStatus(),
        redis,
        goProxy,
        pm2,
        deploy: {
          backend: backendDeploy,
          frontend: frontendDeploy,
          goProxy: goProxyDeploy,
        },
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

  app.post<{ Body: DeployBody }>("/deploy", async (request, reply) => {
    const target = assertDeployTarget(request.body ?? {});
    const result = await runDeploy(target);

    return ok(reply, {
      message: result.scheduled
        ? `${target} deploy dijadwalkan`
        : `${target} deploy selesai`,
      data: result,
    });
  });

  app.get<{ Querystring: { target?: string } }>(
    "/deploy/latest",
    async (request, reply) => {
      const rawTarget = request.query.target;
      const target = DEPLOY_TARGETS.includes(rawTarget as DeployTarget)
        ? (rawTarget as DeployTarget)
        : undefined;
      const job = await latestDeployJob(target);
      return ok(reply, { data: job ?? null });
    },
  );

  app.get<{ Params: { id: string } }>("/deploy/:id", async (request, reply) => {
    const job = await readDeployJob(request.params.id);
    return ok(reply, { data: job });
  });
};

export default adminHealthRoute;
