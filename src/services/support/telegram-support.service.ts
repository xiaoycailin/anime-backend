import { badRequest } from "../../utils/http-error";
import type { SupportConversationMeta } from "./support.types";

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseCsvNumbers(value: string) {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function parseCsvUsernames(value: string) {
  return value
    .split(",")
    .map((v) => v.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
}

export function verifyTelegramWebhookSecret(secret: unknown) {
  const expected = cleanString(process.env.TELEGRAM_WEBHOOK_SECRET);
  if (!expected) throw badRequest("TELEGRAM_WEBHOOK_SECRET belum diatur");
  return cleanString(secret) === expected;
}

export function isTelegramAdminUserId(userId: unknown) {
  const list = cleanString(process.env.TELEGRAM_ADMIN_USER_IDS);
  if (!list) return false;
  const id = Number(userId);
  if (!Number.isFinite(id)) return false;
  return parseCsvNumbers(list).includes(id);
}

export function isTelegramAdminUsername(username: unknown) {
  const list = cleanString(process.env.TELEGRAM_ADMIN_USERNAMES);
  if (!list) return false;
  const normalized =
    typeof username === "string" ? username.trim().replace(/^@/, "").toLowerCase() : "";
  if (!normalized) return false;
  return parseCsvUsernames(list).includes(normalized);
}

function requireTelegramConfig() {
  const token = cleanString(process.env.TELEGRAM_BOT_TOKEN);
  const chatId = cleanString(process.env.TELEGRAM_CS_CHAT_ID);
  if (!token || !chatId) return null;
  return { token, chatId };
}

function ticketForConversationId(conversationId: string) {
  return `SUP-${conversationId.slice(0, 8)}`;
}

export async function sendTelegramSupportNotification(input: {
  meta: SupportConversationMeta;
  userLabel: string;
  userText: string;
  aiSummary?: string;
}) {
  const cfg = requireTelegramConfig();
  if (!cfg) return { ok: false as const, skipped: true as const };

  const ticket = ticketForConversationId(input.meta.id);
  const lines = [
    `[CS Weebin] Butuh Human`,
    `Ticket: ${ticket}`,
    `User: ${input.userLabel}`,
    `Status: ${input.meta.status}`,
    "",
    "Pesan:",
    `"${input.userText.slice(0, 600)}"`,
  ];
  if (input.aiSummary?.trim()) {
    lines.push("", "Ringkasan AI:", input.aiSummary.trim().slice(0, 600));
  }
  lines.push("", `Balas: /reply ${ticket} pesan kamu`);

  const response = await fetch(
    `https://api.telegram.org/bot${cfg.token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: lines.join("\n"),
      }),
    },
  );

  if (!response.ok) {
    return { ok: false as const, skipped: false as const };
  }
  return { ok: true as const };
}

export function parseTelegramCommand(text: string) {
  const trimmed = cleanString(text);
  if (!trimmed.startsWith("/")) return null;

  const [cmdRaw, ...rest] = trimmed.split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const argsText = rest.join(" ").trim();

  if (cmd === "/reply") {
    const [ticket, ...msgParts] = argsText.split(/\s+/);
    const message = msgParts.join(" ").trim();
    if (!ticket || !message) return null;
    return { type: "reply" as const, ticket, message };
  }

  if (cmd === "/resolve") {
    const ticket = argsText.trim();
    if (!ticket) return null;
    return { type: "resolve" as const, ticket };
  }

  return null;
}
