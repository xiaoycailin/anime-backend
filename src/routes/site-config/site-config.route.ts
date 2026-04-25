import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma";
import {
  getCachedConfigs,
  invalidateConfigCache,
} from "../../services/siteConfig.service";
import { badRequest, forbidden } from "../../utils/http-error";
import { ok } from "../../utils/response";

type ConfigQuery = {
  group?: string;
};

type ConfigBody = {
  key?: string;
  value?: string;
};

type ConfigBatchBody = {
  configs?: ConfigBody[];
};

function inferGroup(key: string) {
  const [group] = key.split(".");
  return group || "general";
}

function inferType(value: string) {
  if (value === "true" || value === "false") return "boolean";
  if (value.trim() !== "" && Number.isFinite(Number(value))) return "number";

  try {
    JSON.parse(value);
    return "json";
  } catch {
    return "string";
  }
}

function validateConfigInput(config?: ConfigBody) {
  const key = config?.key?.trim();

  if (!key) {
    throw badRequest("Config key is required");
  }

  if (typeof config?.value !== "string") {
    throw badRequest("Config value must be a string");
  }

  return {
    key,
    value: config.value,
  };
}

function assertAdmin(request: FastifyRequest) {
  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (
    adminEmails.length > 0 &&
    !adminEmails.includes(request.user.email.toLowerCase())
  ) {
    throw forbidden("Only admin can update site config");
  }
}

async function upsertConfig(input: { key: string; value: string }) {
  const existing = await prisma.siteConfig.findUnique({
    where: { key: input.key },
  });

  return prisma.siteConfig.upsert({
    where: { key: input.key },
    update: { value: input.value },
    create: {
      key: input.key,
      value: input.value,
      type: inferType(input.value),
      group: inferGroup(input.key),
    },
  });
}

export const siteConfigRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (request, reply) => {
    const query = request.query as ConfigQuery;
    const configs = await getCachedConfigs(query.group);

    return ok(reply, {
      message: "Site config fetched successfully",
      data: configs,
    });
  });

  app.put(
    "/",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      assertAdmin(request);

      const input = validateConfigInput(request.body as ConfigBody);
      const config = await upsertConfig(input);
      invalidateConfigCache();

      return ok(reply, {
        message: "Site config updated successfully",
        data: config,
      });
    },
  );

  app.put(
    "/batch",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      assertAdmin(request);

      const body = request.body as ConfigBatchBody;

      if (!Array.isArray(body.configs) || body.configs.length === 0) {
        throw badRequest("configs must contain at least one item");
      }

      const inputs = body.configs.map(validateConfigInput);

      await prisma.$transaction(
        inputs.map((input) =>
          prisma.siteConfig.upsert({
            where: { key: input.key },
            update: { value: input.value },
            create: {
              key: input.key,
              value: input.value,
              type: inferType(input.value),
              group: inferGroup(input.key),
            },
          }),
        ),
      );

      invalidateConfigCache();

      return ok(reply, {
        message: "Site config batch updated successfully",
        data: { updated: inputs.length },
      });
    },
  );
};

export default siteConfigRoutes;
