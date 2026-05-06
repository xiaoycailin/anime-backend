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
    <div style="margin:0;padding:0;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f6f7fb">
        <tr>
          <td align="center" style="padding:32px 16px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;border-collapse:collapse">
              <tr>
                <td style="padding:0 0 16px;text-align:center">
                  <div style="font-size:24px;font-weight:800;letter-spacing:.2px;color:#111827">Weebin</div>
                  <div style="margin-top:6px;font-size:13px;color:#6b7280">Account Security</div>
                </td>
              </tr>
              <tr>
                <td style="overflow:hidden;border:1px solid #e5e7eb;border-radius:18px;background:#ffffff;box-shadow:0 16px 36px rgba(17,24,39,.08)">
                  <div style="height:8px;background:linear-gradient(90deg,#7c3aed,#06b6d4,#22c55e)"></div>
                  <div style="padding:32px">
                    <div style="display:inline-block;margin-bottom:18px;border-radius:999px;background:#f3e8ff;color:#6d28d9;padding:7px 12px;font-size:12px;font-weight:800">
                      Permintaan reset password
                    </div>
                    <h1 style="margin:0 0 12px;font-size:26px;line-height:1.25;color:#111827">
                      Buat password baru
                    </h1>
                    <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#374151">
                      Halo ${input.displayName}, kami menerima permintaan untuk mengganti password akun Weebin kamu.
                    </p>
                    <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#374151">
                      Klik tombol di bawah untuk lanjut. Link ini hanya berlaku selama <strong>${input.expiresMinutes} menit</strong>.
                    </p>
                    <a href="${input.resetUrl}" style="display:inline-block;border-radius:12px;background:#7c3aed;color:#ffffff;padding:14px 22px;font-size:15px;font-weight:800;text-decoration:none">
                      Reset password
                    </a>
                    <div style="margin:26px 0 0;padding:16px;border-radius:14px;background:#f9fafb;border:1px solid #eef0f4">
                      <p style="margin:0 0 8px;font-size:13px;font-weight:800;color:#111827">Bukan kamu?</p>
                      <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280">
                        Abaikan email ini kalau kamu tidak meminta reset password. Password lama kamu tetap aman.
                      </p>
                    </div>
                    <p style="margin:22px 0 0;font-size:12px;line-height:1.6;color:#9ca3af">
                      Kalau tombol tidak bisa dibuka, salin link ini ke browser:<br>
                      <a href="${input.resetUrl}" style="color:#7c3aed;text-decoration:none;word-break:break-all">${input.resetUrl}</a>
                    </p>
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:18px 8px 0;text-align:center;font-size:12px;line-height:1.6;color:#9ca3af">
                  Email otomatis dari Weebin. Jangan balas email ini.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
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
