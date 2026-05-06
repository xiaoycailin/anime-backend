import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { hash } from "bcryptjs";
import { prisma } from "../../lib/prisma";
import {
  createMailTransport,
  formatFrom,
  readSmtpConfig,
} from "../../services/mail-config.service";
import { badRequest } from "../../utils/http-error";
import { ok } from "../../utils/response";

type RequestResetBody = {
  email?: string;
};

type ConfirmResetBody = {
  token?: string;
  password?: string;
};

const RESET_TOKEN_TTL_MINUTES = 30;

function normalizeEmail(email?: string) {
  return (email ?? "").trim().toLowerCase();
}

function requirePassword(password?: string) {
  const value = password ?? "";
  if (value.length < 6) throw badRequest("Password minimal 6 karakter");
  return value;
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function appBaseUrl() {
  return (
    process.env.APP_BASE_URL?.trim().replace(/\/+$/, "") ||
    process.env.FRONTEND_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://weebin.site"
  );
}

function resetEmailHtml(input: {
  resetUrl: string;
  displayName: string;
  expiresMinutes: number;
}) {
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f2937">
      <h2 style="margin:0 0 12px">Reset password Weebin</h2>
      <p>Halo ${input.displayName},</p>
      <p>Klik tombol di bawah untuk membuat password baru.</p>
      <p>
        <a href="${input.resetUrl}"
          style="display:inline-block;background:#7c3aed;color:white;
          padding:12px 18px;border-radius:10px;text-decoration:none;
          font-weight:700">
          Reset Password
        </a>
      </p>
      <p>Link ini berlaku ${input.expiresMinutes} menit.</p>
      <p>Kalau kamu tidak meminta reset password, abaikan email ini.</p>
    </div>
  `;
}

async function sendResetEmail(input: {
  email: string;
  displayName: string;
  resetUrl: string;
}) {
  const smtp = await readSmtpConfig();
  const transport = createMailTransport(smtp);
  await transport.sendMail({
    from: formatFrom(smtp),
    to: input.email,
    subject: "Reset password Weebin",
    text: [
      `Halo ${input.displayName},`,
      "",
      "Klik link ini untuk reset password:",
      input.resetUrl,
      "",
      `Link berlaku ${RESET_TOKEN_TTL_MINUTES} menit.`,
      "Abaikan email ini kalau kamu tidak meminta reset password.",
    ].join("\n"),
    html: resetEmailHtml({
      resetUrl: input.resetUrl,
      displayName: input.displayName,
      expiresMinutes: RESET_TOKEN_TTL_MINUTES,
    }),
  });
}

export const passwordResetRoutes: FastifyPluginAsync = async (app) => {
  app.post("/request", async (request, reply) => {
    const body = request.body as RequestResetBody;
    const email = normalizeEmail(body.email);
    if (!email) throw badRequest("Email wajib diisi");

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, fullName: true, username: true },
    });

    if (user) {
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(
        Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000,
      );

      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: tokenHash(token),
          expiresAt,
        },
      });

      const resetUrl = `${appBaseUrl()}/reset-password?token=${token}`;
      await sendResetEmail({
        email: user.email,
        displayName: user.fullName?.trim() || user.username,
        resetUrl,
      }).catch((error) => {
        app.log.error({ err: error }, "Failed sending password reset email");
        throw badRequest("Email reset gagal dikirim");
      });
    }

    return ok(reply, {
      message: "Kalau email terdaftar, link reset sudah dikirim",
      data: { sent: true },
    });
  });

  app.post("/confirm", async (request, reply) => {
    const body = request.body as ConfirmResetBody;
    const token = body.token?.trim() ?? "";
    const password = requirePassword(body.password);
    if (!token) throw badRequest("Token reset tidak valid");

    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: tokenHash(token) },
      include: { user: { select: { id: true } } },
    });

    if (
      !resetToken ||
      resetToken.usedAt ||
      resetToken.expiresAt.getTime() < Date.now()
    ) {
      throw badRequest("Token reset sudah tidak berlaku");
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: resetToken.user.id },
        data: { password: await hash(password, 12), loginType: "email" },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: resetToken.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    return ok(reply, {
      message: "Password berhasil direset",
      data: { reset: true },
    });
  });
};

export default passwordResetRoutes;

