import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../lib/prisma";
import { REFRESH_TTL_MS, signRefreshToken } from "../plugins/auth";

export type RefreshTokenUser = {
  id: number;
  email: string;
  username: string;
  role: string;
};

export class RefreshTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefreshTokenError";
  }
}

type SessionInfo = {
  userAgent?: string | null;
  ip?: string | null;
};

function sessionInfoFromRequest(request?: FastifyRequest): SessionInfo {
  if (!request) return {};
  return {
    userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
    ip: request.ip ?? null,
  };
}

export async function issueRefreshToken(
  app: FastifyInstance,
  user: RefreshTokenUser,
  request?: FastifyRequest,
) {
  const id = randomUUID();
  const info = sessionInfoFromRequest(request);
  await prisma.refreshToken.create({
    data: {
      id,
      userId: user.id,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      userAgent: info.userAgent ?? null,
      ip: info.ip ?? null,
    },
  });
  return signRefreshToken(app, user, id);
}

type RefreshJwtPayload = RefreshTokenUser & { jti?: string };

export async function rotateRefreshToken(
  app: FastifyInstance,
  presented: string,
  request?: FastifyRequest,
) {
  let payload: RefreshJwtPayload;
  try {
    payload = app.jwt.verify<RefreshJwtPayload>(presented);
  } catch {
    throw new RefreshTokenError("Refresh token tidak valid atau kedaluwarsa");
  }

  const jti = payload.jti;
  if (!jti) throw new RefreshTokenError("Refresh token tidak valid");

  const row = await prisma.refreshToken.findUnique({ where: { id: jti } });
  if (!row) throw new RefreshTokenError("Refresh token tidak valid");

  if (row.revokedAt) {
    // Token reuse detected — someone replayed an already-rotated token.
    // Defensively revoke every active token in this user's session family.
    await prisma.refreshToken.updateMany({
      where: { userId: row.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new RefreshTokenError(
      "Refresh token sudah digunakan, sesi dihentikan",
    );
  }

  if (row.expiresAt.getTime() < Date.now()) {
    throw new RefreshTokenError("Refresh token kedaluwarsa");
  }

  const newId = randomUUID();
  const info = sessionInfoFromRequest(request);
  const now = new Date();

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: now, replacedById: newId },
    }),
    prisma.refreshToken.create({
      data: {
        id: newId,
        userId: row.userId,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        userAgent: info.userAgent ?? null,
        ip: info.ip ?? null,
      },
    }),
  ]);

  const tokenUser: RefreshTokenUser = {
    id: payload.id,
    email: payload.email,
    username: payload.username,
    role: payload.role,
  };

  return {
    user: tokenUser,
    refreshToken: signRefreshToken(app, tokenUser, newId),
  };
}

export async function revokeRefreshToken(
  app: FastifyInstance,
  presented: string,
) {
  try {
    const payload = app.jwt.verify<RefreshJwtPayload>(presented);
    if (!payload.jti) return;
    await prisma.refreshToken.updateMany({
      where: { id: payload.jti, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  } catch {
    // Ignore — invalid/expired token has nothing useful to revoke.
  }
}
