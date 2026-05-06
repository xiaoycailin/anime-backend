import nodemailer from "nodemailer";
import { prisma } from "../lib/prisma";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
};

const SMTP_KEYS = {
  host: "mail.smtpHost",
  port: "mail.smtpPort",
  secure: "mail.smtpSecure",
  user: "mail.smtpUser",
  pass: "mail.smtpPassword",
  fromName: "mail.smtpFromName",
  fromEmail: "mail.smtpFromEmail",
} as const;

export async function readSmtpConfig() {
  const rows = await prisma.siteConfig.findMany({
    where: { key: { in: Object.values(SMTP_KEYS) } },
    select: { key: true, value: true },
  });
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const port = Number(map.get(SMTP_KEYS.port) ?? "587");

  return {
    host: map.get(SMTP_KEYS.host)?.trim() ?? "",
    port: Number.isFinite(port) ? port : 587,
    secure: map.get(SMTP_KEYS.secure) === "true",
    user: map.get(SMTP_KEYS.user)?.trim() ?? "",
    pass: map.get(SMTP_KEYS.pass) ?? "",
    fromName: map.get(SMTP_KEYS.fromName)?.trim() || "Weebin",
    fromEmail:
      map.get(SMTP_KEYS.fromEmail)?.trim() ||
      map.get(SMTP_KEYS.user)?.trim() ||
      "",
  } satisfies SmtpConfig;
}

export function assertSmtpReady(config: SmtpConfig) {
  if (!config.host || !config.user || !config.pass || !config.fromEmail) {
    throw new Error("SMTP mailserver belum dikonfigurasi");
  }
}

export function createMailTransport(config: SmtpConfig) {
  assertSmtpReady(config);
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });
}

export function formatFrom(config: SmtpConfig) {
  return `"${config.fromName.replace(/"/g, "'")}" <${config.fromEmail}>`;
}

