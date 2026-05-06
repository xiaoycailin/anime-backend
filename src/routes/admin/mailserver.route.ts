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
    };

    await Promise.all([
      upsertConfig(CONFIG_KEYS.domain, config.domain),
      upsertConfig(CONFIG_KEYS.hostname, config.hostname),
      upsertConfig(CONFIG_KEYS.adminEmail, config.adminEmail),
      upsertConfig(CONFIG_KEYS.webmailUrl, config.webmailUrl),
      upsertConfig(CONFIG_KEYS.adminUrl, config.adminUrl),
      upsertConfig(CONFIG_KEYS.installPath, config.installPath),
      upsertConfig(CONFIG_KEYS.status, config.status),
    ]);

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
