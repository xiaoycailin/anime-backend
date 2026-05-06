import { randomUUID } from "node:crypto";
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from "fastify";
import { compare, hash } from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { CacheInvalidator } from "../../lib/cache";
import {
  accessCookieOptions,
  refreshCookieOptions,
  signAccessToken,
} from "../../plugins/auth";
import {
  RefreshTokenError,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
} from "../../services/refreshToken.service";
import {
  calculateLevel,
  getCultivationBadge,
  getLevelProgress,
} from "../../services/exp.service";
import {
  getEquippedDecorations,
  syncUnlocks,
  type EquippedDecorationDTO,
  type EquippedEffectDTO,
} from "../../services/decoration.service";
import { invalidateChatUserSnapshot } from "../../services/chat-user-cache.service";
import {
  emptyProfileStats,
  getProfileStats,
  type ProfileStatsDTO,
} from "../../services/user-profile.service";
import { deleteR2Object, uploadBufferToR2 } from "../../utils/r2";
import { badRequest, conflict, unauthorized } from "../../utils/http-error";
import { created, ok } from "../../utils/response";

type AuthBody = {
  email?: string;
  username?: string;
  password?: string;
};

type ProfileBody = {
  username?: string;
  fullName?: string;
};

type PasswordBody = {
  currentPassword?: string;
  newPassword?: string;
};

type GoogleCallbackBody = {
  code?: string;
  state?: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type GoogleProfile = {
  email: string;
  name: string;
  picture: string | null;
  sub: string;
};

type LoginSessionUser = {
  id: number;
  email: string;
  username: string;
  fullName?: string | null;
  avatar: string | null;
  role: string;
  isVerified?: boolean;
  exp: number;
  level: number;
  lastExpGainAt?: Date | null;
  createdAt?: Date;
};

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AVATAR_PREFIX = "users/content/avatars/";
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ALLOWED_AVATAR_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/gif",
]);

function publicUser(
  user: {
    id: number;
    email: string;
    username: string;
    fullName?: string | null;
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
    effects?: EquippedEffectDTO[];
    profileStats?: ProfileStatsDTO;
  } = {},
) {
  const exp = user.exp ?? 0;
  const level = user.level ?? calculateLevel(exp);
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    fullName: user.fullName?.trim() || user.username,
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
    effects: extras.effects ?? [],
    profileStats: extras.profileStats ?? emptyProfileStats(),
    ...(user.createdAt ? { createdAt: user.createdAt } : {}),
  };
}

function normalizeEmail(email?: string) {
  return (email ?? "").trim().toLowerCase();
}

function normalizeUsername(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/@.*/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized || `user-${randomUUID().slice(0, 8)}`;
}

function normalizeFullName(value?: string) {
  const fullName = (value ?? "").replace(/\s+/g, " ").trim();
  if (!fullName) throw badRequest("Nama wajib diisi");
  if (fullName.length > 100) throw badRequest("Nama maksimal 100 karakter");
  return fullName;
}

function requirePassword(password?: string) {
  const value = password ?? "";
  if (value.length < 6) throw badRequest("Password minimal 6 karakter");
  return value;
}

function normalizeAvatarMimeType(value: string | undefined | null) {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function validateAvatarFile(file: {
  mimetype?: string;
  filename?: string;
}) {
  const contentType = normalizeAvatarMimeType(file.mimetype);
  if (!ALLOWED_AVATAR_MIME_TYPES.has(contentType)) {
    throw badRequest("Avatar harus PNG, JPG, JPEG, SVG, atau GIF");
  }

  return {
    contentType,
    filename: file.filename?.trim() || "avatar",
  };
}

function avatarKeyFromUrl(url: string | null | undefined) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    const markerIndex = pathname.indexOf(AVATAR_PREFIX);
    if (markerIndex < 0) return null;

    const key = pathname.slice(markerIndex).replace(/^\/+/, "");
    if (!key.startsWith(AVATAR_PREFIX) || key.includes("..")) return null;
    return key;
  } catch {
    return null;
  }
}

function googleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    "http://localhost:5173/creds/google/callback";

  if (!clientId || !clientSecret) {
    throw badRequest("Google login belum dikonfigurasi");
  }

  return { clientId, clientSecret, redirectUri };
}

async function exchangeGoogleCode(app: FastifyInstance, code: string) {
  const config = googleConfig();
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = (await response
    .json()
    .catch(() => null)) as GoogleTokenResponse | null;

  if (!response.ok || !payload?.id_token) {
    app.log.warn(
      {
        status: response.status,
        error: payload?.error,
        errorDescription: payload?.error_description,
      },
      "Google token exchange failed",
    );
    throw unauthorized("Google token exchange gagal");
  }

  return { idToken: payload.id_token, clientId: config.clientId };
}

async function verifyGoogleProfile(idToken: string, clientId: string) {
  const client = new OAuth2Client(clientId);

  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: clientId,
    });
    payload = ticket.getPayload();
  } catch {
    throw unauthorized("ID token Google tidak valid");
  }

  const email = normalizeEmail(payload?.email);
  const sub = payload?.sub?.trim();

  if (!payload || !email || !sub) {
    throw unauthorized("ID token Google tidak lengkap");
  }

  if (payload.email_verified !== true) {
    throw unauthorized("Email Google belum verified");
  }

  return {
    email,
    sub,
    name: (payload.name ?? email.split("@")[0] ?? "Google User").trim(),
    picture: payload.picture ?? null,
  } satisfies GoogleProfile;
}

function normalizeUsernameBase(name: string, email: string) {
  const base = normalizeUsername(name || email.split("@")[0] || "google-user")
    .slice(0, 32);

  return base || "google-user";
}

async function uniqueUsername(name: string, email: string) {
  const base = normalizeUsernameBase(name, email);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${randomUUID().slice(0, 6)}`;
    const username = `${base}${suffix}`.slice(0, 40);
    const exists = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });

    if (!exists) return username;
  }

  return `google-${randomUUID().slice(0, 12)}`;
}

async function issueLoginSession(
  app: FastifyInstance,
  request: FastifyRequest,
  user: LoginSessionUser,
) {
  const tokenUser = {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
  };

  const accessToken = signAccessToken(app, tokenUser);
  const refreshToken = await issueRefreshToken(app, tokenUser, request);

  await syncUnlocks(user.id, user.level).catch(() => null);
  const [equipped, profileStats] = await Promise.all([
    getEquippedDecorations(user.id),
    getProfileStats(user.id),
  ]);

  return {
    accessToken,
    refreshToken,
    user: publicUser(user, { ...equipped, profileStats }),
  };
}

async function findOrCreateGoogleUser(profile: GoogleProfile) {
  try {
    const byGoogleId = await prisma.user.findUnique({
      where: { googleId: profile.sub },
    });

    if (byGoogleId) {
      if (byGoogleId.email !== profile.email) {
        const emailOwner = await prisma.user.findUnique({
          where: { email: profile.email },
          select: { id: true },
        });

        if (emailOwner && emailOwner.id !== byGoogleId.id) {
          throw conflict("Email Google sudah digunakan akun lain");
        }
      }

      if (!byGoogleId.avatar && profile.picture) {
        return prisma.user.update({
          where: { id: byGoogleId.id },
          data: { avatar: profile.picture },
        });
      }

      return byGoogleId;
    }

    const byEmail = await prisma.user.findUnique({
      where: { email: profile.email },
    });

    if (byEmail) {
      if (byEmail.googleId && byEmail.googleId !== profile.sub) {
        throw conflict("Email sudah terhubung dengan akun Google lain");
      }

      return prisma.user.update({
        where: { id: byEmail.id },
        data: {
          googleId: profile.sub,
          ...(!byEmail.avatar && profile.picture
            ? { avatar: profile.picture }
            : {}),
        },
      });
    }

    return prisma.user.create({
      data: {
        email: profile.email,
        username: await uniqueUsername(profile.name, profile.email),
        fullName: normalizeFullName(profile.name),
        password: await hash(randomUUID(), 12),
        avatar: profile.picture,
        loginType: "google",
        isVerified: true,
        googleId: profile.sub,
        preference: { create: {} },
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw conflict("Akun Google atau email sudah digunakan");
    }
    throw error;
  }
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/register", async (request, reply) => {
    const body = request.body as AuthBody;
    const email = normalizeEmail(body.email);
    const username = await uniqueUsername(email.split("@")[0] ?? email, email);
    const fullName = normalizeFullName(body.username ?? email.split("@")[0]);
    const password = requirePassword(body.password);

    if (!email) {
      throw badRequest("Email wajib diisi");
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
        fullName,
        password: await hash(password, 12),
        preference: { create: {} },
      },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
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
    const body = (request.body ?? {}) as AuthBody;
    const email = normalizeEmail(body.email);
    const password = body.password ?? "";

    if (!email) {
      throw badRequest("Email wajib diisi");
    }

    if (!password) {
      throw badRequest("Password wajib diisi");
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await compare(password, user.password))) {
      throw unauthorized("Email atau password salah");
    }

    const session = await issueLoginSession(app, request, user);

    reply.setCookie("accessToken", session.accessToken, accessCookieOptions);
    reply.setCookie("refreshToken", session.refreshToken, refreshCookieOptions);

    return ok(reply, {
      message: "Login successful",
      data: session,
    });
  });

  app.post("/google/callback", async (request, reply) => {
    const body = (request.body ?? {}) as GoogleCallbackBody;
    const code = body.code?.trim();

    if (!code) {
      throw badRequest("Code Google wajib diisi");
    }

    const { idToken, clientId } = await exchangeGoogleCode(app, code);
    const profile = await verifyGoogleProfile(idToken, clientId);
    const user = await findOrCreateGoogleUser(profile);
    const session = await issueLoginSession(app, request, user);

    reply.setCookie("accessToken", session.accessToken, accessCookieOptions);
    reply.setCookie("refreshToken", session.refreshToken, refreshCookieOptions);

    return ok(reply, {
      message: "Google login successful",
      data: session,
    });
  });

  app.post("/refresh", async (request, reply) => {
    const body = (request.body ?? {}) as { refreshToken?: string };
    const token =
      body.refreshToken?.trim() || request.cookies?.refreshToken || null;

    if (!token) throw unauthorized("Refresh token tidak ditemukan");

    let rotated;
    try {
      rotated = await rotateRefreshToken(app, token, request);
    } catch (err) {
      if (err instanceof RefreshTokenError) {
        reply.clearCookie("refreshToken", { path: "/" });
        throw unauthorized(err.message);
      }
      throw err;
    }

    const user = await prisma.user.findUnique({
      where: { id: rotated.user.id },
      select: { id: true, email: true, username: true, role: true },
    });

    if (!user) {
      reply.clearCookie("refreshToken", { path: "/" });
      throw unauthorized("Refresh token tidak valid");
    }

    const accessToken = signAccessToken(app, user);

    reply.setCookie("accessToken", accessToken, accessCookieOptions);
    reply.setCookie("refreshToken", rotated.refreshToken, refreshCookieOptions);

    return ok(reply, {
      message: "Token refreshed",
      data: {
        accessToken,
        refreshToken: rotated.refreshToken,
      },
    });
  });

  app.post("/logout", async (request, reply) => {
    const presented = request.cookies?.refreshToken;
    if (presented) {
      await revokeRefreshToken(app, presented);
    }
    reply.clearCookie("accessToken", { path: "/" });
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
        fullName: true,
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
    const [equipped, profileStats] = await Promise.all([
      getEquippedDecorations(user.id),
      getProfileStats(user.id),
    ]);

    return ok(reply, {
      message: "Profile fetched",
      data: publicUser(user, { ...equipped, profileStats }),
    });
  });

  app.put("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const body = request.body as ProfileBody;
    const data: { fullName?: string } = {};

    if (typeof body.username === "string" && body.username.trim()) {
      data.fullName = normalizeFullName(body.username);
    }

    if (typeof body.fullName === "string" && body.fullName.trim()) {
      data.fullName = normalizeFullName(body.fullName);
    }

    try {
      const user = await prisma.user.update({
        where: { id: request.user.id },
        data,
        select: {
          id: true,
          email: true,
          username: true,
          fullName: true,
          avatar: true,
          role: true,
          isVerified: true,
          createdAt: true,
          exp: true,
          level: true,
          lastExpGainAt: true,
        },
      });

      await Promise.all([
        CacheInvalidator.onPublicUserChange(user.id),
        invalidateChatUserSnapshot(user.id),
      ]);
      const [equipped, profileStats] = await Promise.all([
        getEquippedDecorations(user.id),
        getProfileStats(user.id),
      ]);

      return ok(reply, {
        message: "Profile updated",
        data: publicUser(user, { ...equipped, profileStats }),
      });
    } catch (error) {
      if ((error as any).code === "P2002") {
        throw badRequest("Username already exists");
      }
      throw badRequest("Gagal memperbarui profile", error);
    }
  });

  app.post(
    "/me/avatar",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!request.isMultipart()) {
        throw badRequest("Content-Type harus multipart/form-data");
      }

      const currentUser = await prisma.user.findUnique({
        where: { id: request.user.id },
        select: { avatar: true },
      });

      if (!currentUser) throw unauthorized("User tidak ditemukan");

      const file = await request.file();
      if (!file) throw badRequest("File avatar wajib diupload");

      const { contentType, filename } = validateAvatarFile(file);
      const buffer = await file.toBuffer();

      if (buffer.length > MAX_AVATAR_BYTES) {
        throw badRequest("Ukuran avatar maksimal 5MB");
      }

      const oldAvatarKey = avatarKeyFromUrl(currentUser.avatar);
      const uploaded = await uploadBufferToR2({
        buffer,
        filename,
        contentType,
        folder: AVATAR_PREFIX.replace(/\/+$/, ""),
        metadata: {
          userId: String(request.user.id),
          kind: "user-avatar",
        },
      });

      let user;
      try {
        user = await prisma.user.update({
          where: { id: request.user.id },
          data: { avatar: uploaded.url },
          select: {
            id: true,
            email: true,
            username: true,
            fullName: true,
            avatar: true,
            role: true,
            isVerified: true,
            createdAt: true,
            exp: true,
            level: true,
            lastExpGainAt: true,
          },
        });
      } catch (error) {
        await deleteR2Object(uploaded.key).catch((deleteError) => {
          app.log.warn(
            { err: deleteError, key: uploaded.key },
            "Failed to cleanup uploaded avatar after profile update error",
          );
        });
        throw error;
      }

      await Promise.all([
        CacheInvalidator.onPublicUserChange(user.id),
        invalidateChatUserSnapshot(user.id),
      ]);

      if (oldAvatarKey && oldAvatarKey !== uploaded.key) {
        await deleteR2Object(oldAvatarKey).catch((error) => {
          app.log.warn(
            { err: error, key: oldAvatarKey },
            "Failed to delete previous user avatar",
          );
        });
      }

      const [equipped, profileStats] = await Promise.all([
        getEquippedDecorations(user.id),
        getProfileStats(user.id),
      ]);

      return ok(reply, {
        message: "Avatar updated",
        data: publicUser(user, { ...equipped, profileStats }),
      });
    },
  );

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
