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
) {
  return app.jwt.sign(user, { expiresIn: REFRESH_TOKEN_TTL });
}

export const refreshCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
};
