import type { FastifyPluginAsync } from "fastify";
import {
  type ActivityPingInput,
  upsertActivityPresence,
} from "../../services/activity-presence.service";

const activityRoute: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.post<{ Body: ActivityPingInput }>("/ping", async (request, reply) => {
    const record = upsertActivityPresence(request.user, request.body ?? {});

    return reply.send({
      status: 200,
      message: "Activity updated",
      errorCode: null,
      data: { lastSeenAt: record.lastSeenAt },
    });
  });
};

export default activityRoute;
