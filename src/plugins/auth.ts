import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { unauthorized } from "../utils/http-error";

const ACCESS_TOKEN_TTL = process.env.JWT_ACCESS_TTL ?? "15m";
const REFRESH_TOKEN_TTL = process.env.JWT_REFRESH_TTL ?? "7d";

export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  const secret = process.env.JWT_SECRET ?? "dev-secret-change-me";

  await app.register(cookie);
  await app.register(jwt, {
    secret,
  });

  app.decorate("authenticate", async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw unauthorized("Invalid or expired access token");
    }
  });
});

export function signAccessToken(
  app: FastifyInstance,
  user: { id: number; email: string; username: string; role: string },
) {
  return app.jwt.sign(user, { expiresIn: ACCESS_TOKEN_TTL });
}

export function signRefreshToken(
  app: FastifyInstance,
  user: { id: number; email: string; username: string; role: string },
  jti: string,
) {
  return app.jwt.sign(user, { expiresIn: REFRESH_TOKEN_TTL, jti });
}

export const REFRESH_TTL_MS = parseTtlMs(REFRESH_TOKEN_TTL);

function parseTtlMs(ttl: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(ttl.trim());
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2];
  const factor =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;
  return value * factor;
}

export const refreshCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
};
