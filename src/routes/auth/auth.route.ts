import type { FastifyPluginAsync } from "fastify";
import { compare, hash } from "bcryptjs";
import { prisma } from "../../lib/prisma";
import {
  refreshCookieOptions,
  signAccessToken,
  signRefreshToken,
} from "../../plugins/auth";
import {
  calculateLevel,
  getCultivationBadge,
  getLevelProgress,
} from "../../services/exp.service";
import {
  getEquippedDecorations,
  syncUnlocks,
  type EquippedDecorationDTO,
} from "../../services/decoration.service";
import { badRequest, unauthorized } from "../../utils/http-error";
import { created, ok } from "../../utils/response";

type AuthBody = {
  email?: string;
  username?: string;
  password?: string;
};

type ProfileBody = {
  username?: string;
  avatar?: string | null;
};

type PasswordBody = {
  currentPassword?: string;
  newPassword?: string;
};

function publicUser(
  user: {
    id: number;
    email: string;
    username: string;
    avatar: string | null;
    role?: string;
    isVerified?: boolean;
    exp?: number;
    level?: number;
    lastExpGainAt?: Date | null;
    createdAt?: Date;
  },
  extras: {
    frame?: EquippedDecorationDTO;
    nametag?: EquippedDecorationDTO;
  } = {},
) {
  const exp = user.exp ?? 0;
  const level = user.level ?? calculateLevel(exp);
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    avatar: user.avatar,
    ...(user.role ? { role: user.role } : {}),
    isVerified: Boolean(user.isVerified),
    exp,
    level,
    lastExpGainAt: user.lastExpGainAt ?? null,
    badge: getCultivationBadge(level),
    levelProgress: getLevelProgress(exp, level),
    frame: extras.frame ?? null,
    nametag: extras.nametag ?? null,
    ...(user.createdAt ? { createdAt: user.createdAt } : {}),
  };
}

function normalizeEmail(email?: string) {
  return (email ?? "").trim().toLowerCase();
}

function requirePassword(password?: string) {
  const value = password ?? "";
  if (value.length < 6) throw badRequest("Password minimal 6 karakter");
  return value;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/register", async (request, reply) => {
    const body = request.body as AuthBody;
    const email = normalizeEmail(body.email);
    const username = (body.username ?? "").trim();
    const password = requirePassword(body.password);

    if (!email || !username) {
      throw badRequest("Email dan username wajib diisi");
    }

    const exists = await prisma.user.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
      select: { id: true },
    });

    if (exists) throw badRequest("Email atau username sudah digunakan");

    const user = await prisma.user.create({
      data: {
        email,
        username,
        password: await hash(password, 12),
        preference: { create: {} },
      },
      select: {
        id: true,
        email: true,
        username: true,
        avatar: true,
        role: true,
        isVerified: true,
        exp: true,
        level: true,
        lastExpGainAt: true,
      },
    });

    return created(reply, {
      message: "User registered successfully",
      data: { user: publicUser(user) },
    });
  });

  app.post("/login", async (request, reply) => {
    const body = request.body as AuthBody;
    const email = normalizeEmail(body.email);
    const password = body.password ?? "";

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await compare(password, user.password))) {
      throw unauthorized("Email atau password salah");
    }

    const tokenUser = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };

    reply.setCookie(
      "refreshToken",
      signRefreshToken(app, tokenUser),
      refreshCookieOptions,
    );

    await syncUnlocks(user.id, user.level).catch(() => null);
    const equipped = await getEquippedDecorations(user.id);

    return ok(reply, {
      message: "Login successful",
      data: {
        accessToken: signAccessToken(app, tokenUser),
        user: publicUser(user, equipped),
      },
    });
  });

  app.post(
    "/refresh",
    { preHandler: app.authenticate },
    async (request, reply) => {
      // get token by autorization header
      let token = null;
      if (request) {
        const authHeader = request.headers["authorization"] || "";
        if (authHeader.startsWith("Bearer ")) {
          token = authHeader.slice(7);
        }
      }

      if (!token) throw unauthorized("Refresh token tidak ditemukan");

      try {
        const payload = app.jwt.verify<{
          id: number;
          email: string;
          username: string;
          role?: string;
        }>(token);

        const user = await prisma.user.findUnique({
          where: { id: payload.id },
          select: { id: true, email: true, username: true, role: true },
        });

        if (!user) throw unauthorized("Refresh token tidak valid");

        return ok(reply, {
          message: "Token refreshed",
          data: { accessToken: signAccessToken(app, user) },
        });
      } catch {
        throw unauthorized("Refresh token tidak valid atau kedaluwarsa");
      }
    },
  );

  app.post("/logout", async (_request, reply) => {
    reply.clearCookie("refreshToken", { path: "/" });
    return ok(reply, { message: "ok", data: { message: "ok" } });
  });

  app.get("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        id: true,
        email: true,
        username: true,
        avatar: true,
        role: true,
        isVerified: true,
        createdAt: true,
        exp: true,
        level: true,
        lastExpGainAt: true,
      },
    });

    if (!user) throw unauthorized("User tidak ditemukan");

    await syncUnlocks(user.id, user.level).catch(() => null);
    const equipped = await getEquippedDecorations(user.id);

    return ok(reply, {
      message: "Profile fetched",
      data: publicUser(user, equipped),
    });
  });

  app.put("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const body = request.body as ProfileBody;
    const data: ProfileBody = {};

    if (typeof body.username === "string" && body.username.trim()) {
      data.username = body.username.trim();
    }

    if (typeof body.avatar === "string" || body.avatar === null) {
      data.avatar = body.avatar;
    }

    const user = await prisma.user.update({
      where: { id: request.user.id },
      data,
      select: {
        id: true,
        email: true,
        username: true,
        avatar: true,
        role: true,
        isVerified: true,
        createdAt: true,
        exp: true,
        level: true,
        lastExpGainAt: true,
      },
    });

    const equipped = await getEquippedDecorations(user.id);

    return ok(reply, {
      message: "Profile updated",
      data: publicUser(user, equipped),
    });
  });

  app.put(
    "/password",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const body = request.body as PasswordBody;
      const newPassword = requirePassword(body.newPassword);

      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
      });

      if (
        !user ||
        !(await compare(body.currentPassword ?? "", user.password))
      ) {
        throw badRequest("Current password salah");
      }

      await prisma.user.update({
        where: { id: request.user.id },
        data: { password: await hash(newPassword, 12) },
      });

      return ok(reply, { message: "ok", data: { message: "ok" } });
    },
  );
};

export default authRoutes;
