import type { FastifyPluginAsync } from "fastify";
import {
  controlManagedJob,
  controlManagedJobItem,
  listManagedJobs,
} from "../../jobs/job-control.service";
import { ok, sendError } from "../../utils/response";

type JobQuery = {
  category?: string;
};

type JobActionBody = {
  action?: "run-now" | "play" | "stop";
};

export const adminJobsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.get("/", async (request, reply) => {
    const query = request.query as JobQuery;
    const data = await listManagedJobs(query.category);
    return ok(reply, { data });
  });

  app.post("/:id/actions", async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as JobActionBody;

    if (!body.action) {
      return sendError(reply, {
        status: 400,
        message: "Action wajib diisi",
        errorCode: "JOB_ACTION_REQUIRED",
      });
    }

    try {
      const data = await controlManagedJob(params.id, body.action);
      return ok(reply, { data, message: "Job berhasil dikontrol" });
    } catch (error) {
      return sendError(reply, {
        status: 400,
        message: error instanceof Error ? error.message : "Gagal kontrol job",
        errorCode: "JOB_CONTROL_FAILED",
      });
    }
  });

  app.post("/:id/items/:itemId/actions", async (request, reply) => {
    const params = request.params as { id: string; itemId: string };
    const body = request.body as JobActionBody;

    if (!body.action) {
      return sendError(reply, {
        status: 400,
        message: "Action wajib diisi",
        errorCode: "JOB_ACTION_REQUIRED",
      });
    }

    try {
      const data = await controlManagedJobItem(
        params.id,
        decodeURIComponent(params.itemId),
        body.action,
      );
      return ok(reply, { data, message: "Item job berhasil dikontrol" });
    } catch (error) {
      return sendError(reply, {
        status: 400,
        message: error instanceof Error ? error.message : "Gagal kontrol item job",
        errorCode: "JOB_ITEM_CONTROL_FAILED",
      });
    }
  });
};

export default adminJobsRoutes;
