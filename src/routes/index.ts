import type { FastifyPluginAsync } from "fastify";
import fs from "fs";
import path from "path";

function toRoutePrefix(routesDir: string, filePath: string) {
  const relativePath = path.relative(routesDir, filePath).replace(/\\/g, "/");
  const noExtension = relativePath.replace(/\.route\.(ts|js)$/i, "");
  const segments = noExtension.split("/").filter(Boolean);

  if (segments.length === 0) return "/";

  const lastSegment = segments[segments.length - 1];
  const parentSegment =
    segments.length > 1 ? segments[segments.length - 2] : "";

  if (lastSegment.toLowerCase() === "index") {
    segments.pop();
  } else if (lastSegment.toLowerCase() === parentSegment.toLowerCase()) {
    segments.pop();
  }

  if (segments.length === 0) return "/";

  return `/${segments.join("/")}`;
}

function collectRouteFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectRouteFiles(fullPath));
      continue;
    }

    if (
      /\.route\.(ts|js)$/i.test(entry.name) &&
      entry.name !== "index.ts" &&
      entry.name !== "index.js" &&
      !["video-stream/skj.route.ts", "video-stream/skj.route.js"].includes(
        path.relative(__dirname, fullPath).replace(/\\/g, "/"),
      )
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

function resolveRoutePlugin(moduleExports: Record<string, unknown>) {
  if (typeof moduleExports.default === "function")
    return moduleExports.default as FastifyPluginAsync;

  for (const value of Object.values(moduleExports)) {
    if (typeof value === "function") {
      return value as FastifyPluginAsync;
    }
  }

  return null;
}

export const apiRoutes: FastifyPluginAsync = async (app) => {
  const routesDir = __dirname;
  const routeFiles = collectRouteFiles(routesDir);
  const usedPrefixes = new Map<string, string>();

  for (const file of routeFiles) {
    const routeModule = require(file);
    const plugin = resolveRoutePlugin(routeModule);

    if (!plugin) {
      app.log.warn(`Skipping route file without valid plugin export: ${file}`);
      continue;
    }

    const prefix = toRoutePrefix(routesDir, file);
    const existingFile = usedPrefixes.get(prefix);

    if (existingFile) {
      app.log.warn(
        `Prefix conflict detected: ${prefix} from ${file} conflicts with ${existingFile}`,
      );
      continue;
    }

    usedPrefixes.set(prefix, file);
    app.register(plugin, { prefix });
    app.log.info(
      `Registered route prefix: ${prefix} <- ${path.relative(routesDir, file)}`,
    );
  }
};
