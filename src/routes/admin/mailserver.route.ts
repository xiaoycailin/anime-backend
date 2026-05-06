import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../../lib/prisma";
import { badRequest } from "../../utils/http-error";
import { ok } from "../../utils/response";

type MailConfig = {
  domain: string;
  hostname: string;
  adminEmail: string;
  webmailUrl: string;
  adminUrl: string;
  provider: "mailcow";
  installPath: string;
  status: "planned" | "installing" | "ready" | "maintenance";
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword?: string;
  smtpPasswordSet: boolean;
  smtpFromName: string;
  smtpFromEmail: string;
};

type MailConfigBody = Partial<Omit<MailConfig, "provider">>;

const CONFIG_KEYS = {
  domain: "mail.domain",
  hostname: "mail.hostname",
  adminEmail: "mail.adminEmail",
  webmailUrl: "mail.webmailUrl",
  adminUrl: "mail.adminUrl",
  installPath: "mail.installPath",
  status: "mail.status",
  smtpHost: "mail.smtpHost",
  smtpPort: "mail.smtpPort",
  smtpSecure: "mail.smtpSecure",
  smtpUser: "mail.smtpUser",
  smtpPassword: "mail.smtpPassword",
  smtpFromName: "mail.smtpFromName",
  smtpFromEmail: "mail.smtpFromEmail",
} as const;

const DEFAULT_CONFIG: MailConfig = {
  domain: "",
  hostname: "",
  adminEmail: "",
  webmailUrl: "",
  adminUrl: "",
  provider: "mailcow",
  installPath: "/opt/mailcow-dockerized",
  status: "planned",
  smtpHost: "",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "",
  smtpPassword: "",
  smtpPasswordSet: false,
  smtpFromName: "Weebin",
  smtpFromEmail: "",
};

function isValidDomain(value: string) {
  return /^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i.test(value);
}

function normalizeDomain(value?: string) {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function normalizeUrl(value?: string) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed)
    ? trimmed.replace(/\/+$/, "")
    : `https://${trimmed.replace(/\/+$/, "")}`;
}

function normalizePath(value?: string) {
  const path = (value ?? DEFAULT_CONFIG.installPath).trim();
  if (!path.startsWith("/") || path.includes("..")) {
    throw badRequest("Install path harus absolute Linux path");
  }
  return path.replace(/\/+$/, "") || DEFAULT_CONFIG.installPath;
}

function normalizeStatus(value?: string): MailConfig["status"] {
  if (
    value === "planned" ||
    value === "installing" ||
    value === "ready" ||
    value === "maintenance"
  ) {
    return value;
  }
  return "planned";
}

function normalizeSmtpPort(value?: number) {
  const port = Number(value ?? DEFAULT_CONFIG.smtpPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw badRequest("Port SMTP tidak valid");
  }
  return port;
}

function normalizeBoolean(value?: boolean) {
  return value === true;
}

async function readMailConfig(): Promise<MailConfig> {
  const rows = await prisma.siteConfig.findMany({
    where: { key: { in: Object.values(CONFIG_KEYS) } },
    select: { key: true, value: true },
  });
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const domain = map.get(CONFIG_KEYS.domain) ?? DEFAULT_CONFIG.domain;
  const hostname =
    map.get(CONFIG_KEYS.hostname) ??
    (domain
      ? `mail.${domain.replace(/^mail\./, "")}`
      : DEFAULT_CONFIG.hostname);

  return {
    domain,
    hostname,
    adminEmail: map.get(CONFIG_KEYS.adminEmail) ?? DEFAULT_CONFIG.adminEmail,
    webmailUrl:
      map.get(CONFIG_KEYS.webmailUrl) ??
      (hostname ? `https://${hostname}/SOGo` : ""),
    adminUrl:
      map.get(CONFIG_KEYS.adminUrl) ?? (hostname ? `https://${hostname}` : ""),
    provider: "mailcow",
    installPath: map.get(CONFIG_KEYS.installPath) ?? DEFAULT_CONFIG.installPath,
    status: normalizeStatus(map.get(CONFIG_KEYS.status)),
    smtpHost: map.get(CONFIG_KEYS.smtpHost) ?? hostname,
    smtpPort: normalizeSmtpPort(Number(map.get(CONFIG_KEYS.smtpPort) ?? 587)),
    smtpSecure: map.get(CONFIG_KEYS.smtpSecure) === "true",
    smtpUser: map.get(CONFIG_KEYS.smtpUser) ?? "",
    smtpPassword: "",
    smtpPasswordSet: Boolean(map.get(CONFIG_KEYS.smtpPassword)),
    smtpFromName: map.get(CONFIG_KEYS.smtpFromName) ?? "Weebin",
    smtpFromEmail:
      map.get(CONFIG_KEYS.smtpFromEmail) ??
      map.get(CONFIG_KEYS.smtpUser) ??
      "",
  };
}

async function upsertConfig(key: string, value: string) {
  const existing = await prisma.siteConfig.findUnique({ where: { key } });
  await prisma.siteConfig.upsert({
    where: { key },
    update: { value },
    create: {
      key,
      value,
      group: "mail",
      type: existing?.type ?? "string",
    },
  });
}

function buildInstallScript(config: MailConfig) {
  const hostname = config.hostname || "mail.example.com";
  const domain = config.domain || hostname.replace(/^mail\./, "");
  const path = config.installPath || DEFAULT_CONFIG.installPath;

  return [
    "# Jalankan di VPS Ubuntu/Debian sebagai root atau user sudo.",
    "# Pastikan DNS A record sudah mengarah ke IP VPS sebelum install.",
    "sudo apt update && sudo apt install -y git curl docker.io docker-compose-plugin",
    "sudo systemctl enable --now docker",
    `sudo mkdir -p ${path}`,
    `sudo git clone https://github.com/mailcow/mailcow-dockerized ${path}`,
    `cd ${path}`,
    `sudo MAILCOW_HOSTNAME=${hostname} ./generate_config.sh`,
    "sudo docker compose pull",
    "sudo docker compose up -d",
    "sudo docker compose ps",
    "",
    "# DNS minimum:",
    `# A     ${hostname} -> IP_VPS`,
    `# MX    ${domain} -> ${hostname} priority 10`,
    `# TXT   ${domain} -> v=spf1 mx -all`,
    `# TXT   _dmarc.${domain} -> v=DMARC1; p=quarantine; rua=mailto:${config.adminEmail || `postmaster@${domain}`}`,
    "# DKIM dibuat dari Mailcow UI setelah container aktif.",
    "# PTR/rDNS wajib diatur dari panel provider VPS ke hostname mail server.",
  ].join("\n");
}

function buildStatusChecks(config: MailConfig) {
  const hostname = config.hostname || "mail.example.com";
  return [
    `dig +short A ${hostname}`,
    `dig +short MX ${config.domain || hostname.replace(/^mail\./, "")}`,
    `curl -I ${config.adminUrl || `https://${hostname}`}`,
    "sudo docker compose ps",
    "sudo docker compose logs --tail=80 postfix-mailcow dovecot-mailcow nginx-mailcow",
  ];
}

export const adminMailserverRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.get("/", async (_request, reply) => {
    const config = await readMailConfig();
    return ok(reply, {
      data: {
        config,
        installScript: buildInstallScript(config),
        statusChecks: buildStatusChecks(config),
      },
    });
  });

  app.put("/", async (request, reply) => {
    const body = request.body as MailConfigBody;
    const current = await readMailConfig();
    const domain = normalizeDomain(body.domain ?? current.domain);
    const hostname = normalizeDomain(body.hostname ?? current.hostname);

    if (domain && !isValidDomain(domain))
      throw badRequest("Domain tidak valid");
    if (hostname && !isValidDomain(hostname))
      throw badRequest("Hostname tidak valid");

    const config: MailConfig = {
      domain,
      hostname,
      adminEmail: (body.adminEmail ?? current.adminEmail).trim(),
      webmailUrl: normalizeUrl(body.webmailUrl ?? current.webmailUrl),
      adminUrl: normalizeUrl(body.adminUrl ?? current.adminUrl),
      provider: "mailcow",
      installPath: normalizePath(body.installPath ?? current.installPath),
      status: normalizeStatus(body.status ?? current.status),
      smtpHost: normalizeDomain(body.smtpHost ?? current.smtpHost),
      smtpPort: normalizeSmtpPort(body.smtpPort ?? current.smtpPort),
      smtpSecure: normalizeBoolean(body.smtpSecure ?? current.smtpSecure),
      smtpUser: (body.smtpUser ?? current.smtpUser).trim(),
      smtpPassword: body.smtpPassword?.trim() ? body.smtpPassword : "",
      smtpPasswordSet:
        Boolean(body.smtpPassword?.trim()) || current.smtpPasswordSet,
      smtpFromName: (body.smtpFromName ?? current.smtpFromName).trim(),
      smtpFromEmail: (body.smtpFromEmail ?? current.smtpFromEmail).trim(),
    };

    if (config.smtpHost && !isValidDomain(config.smtpHost))
      throw badRequest("SMTP host tidak valid");

    const updates = [
      upsertConfig(CONFIG_KEYS.domain, config.domain),
      upsertConfig(CONFIG_KEYS.hostname, config.hostname),
      upsertConfig(CONFIG_KEYS.adminEmail, config.adminEmail),
      upsertConfig(CONFIG_KEYS.webmailUrl, config.webmailUrl),
      upsertConfig(CONFIG_KEYS.adminUrl, config.adminUrl),
      upsertConfig(CONFIG_KEYS.installPath, config.installPath),
      upsertConfig(CONFIG_KEYS.status, config.status),
      upsertConfig(CONFIG_KEYS.smtpHost, config.smtpHost),
      upsertConfig(CONFIG_KEYS.smtpPort, String(config.smtpPort)),
      upsertConfig(CONFIG_KEYS.smtpSecure, String(config.smtpSecure)),
      upsertConfig(CONFIG_KEYS.smtpUser, config.smtpUser),
      upsertConfig(CONFIG_KEYS.smtpFromName, config.smtpFromName),
      upsertConfig(CONFIG_KEYS.smtpFromEmail, config.smtpFromEmail),
    ];
    if (config.smtpPassword) {
      updates.push(upsertConfig(CONFIG_KEYS.smtpPassword, config.smtpPassword));
    }

    await Promise.all([
      ...updates,
    ]);

    config.smtpPassword = "";

    return ok(reply, {
      message: "Konfigurasi mailserver disimpan",
      data: {
        config,
        installScript: buildInstallScript(config),
        statusChecks: buildStatusChecks(config),
      },
    });
  });
};

export default adminMailserverRoutes;
