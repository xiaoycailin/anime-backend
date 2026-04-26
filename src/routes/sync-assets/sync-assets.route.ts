import type { FastifyPluginAsync } from "fastify";
import { badRequest } from "../../utils/http-error";
import {
  enqueueAssetSync,
  isAssetSyncProcessing,
  type SyncAssetInput,
} from "../../services/sync-assets.service";

export const syncAssetsRoutes: FastifyPluginAsync = async (app) => {
  app.post("/", async (request, reply) => {
    if (isAssetSyncProcessing()) {
      throw badRequest("Sync asset masih berjalan");
    }

    const body = request.body as { assets?: unknown } | null;
    const assets = Array.isArray(body?.assets)
      ? (body.assets as SyncAssetInput[])
      : [];

    enqueueAssetSync(assets, {
      info: (message) => request.log.info(message),
      warn: (message) => request.log.warn(message),
      error: (message, error) => request.log.error({ err: error }, message),
    });

    return reply.status(204).send();
  });
};
