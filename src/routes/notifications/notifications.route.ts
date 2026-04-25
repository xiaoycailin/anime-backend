import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma";
import { badRequest, unauthorized } from "../../utils/http-error";
import { ok } from "../../utils/response";
import {
  ensureNotificationPreference,
  getPushPublicConfig,
  removePushSubscription,
  upsertPushSubscription,
} from "../../services/notification.service";

type NotificationListQuery = {
  page?: string;
  limit?: string;
  unreadOnly?: string;
};

type SubscribeBody = {
  deviceId?: string;
  subscription?: {
    endpoint?: string;
    expirationTime?: number | null;
    keys?: {
      p256dh?: string;
      auth?: string;
    };
  };
  topics?: Record<string, boolean>;
  allowBroadcast?: boolean;
};

type UnsubscribeBody = {
  deviceId?: string;
  endpoint?: string;
};

type ReadBody = {
  ids?: number[];
  recipientIds?: number[];
  notificationIds?: number[];
};

type PreferenceBody = {
  announcement?: boolean;
  contentNew?: boolean;
  contentUpdate?: boolean;
  personalActivity?: boolean;
  watchReminder?: boolean;
  accountSystem?: boolean;
  adminOperational?: boolean;
  pushEnabled?: boolean;
  inAppEnabled?: boolean;
};

async function resolveOptionalUser(app: Parameters<FastifyPluginAsync>[0], request: FastifyRequest) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;

  try {
    const payload = app.jwt.verify<{ id: number }>(header.slice(7));
    return prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, role: true },
    });
  } catch {
    return null;
  }
}

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/push/public-config", async (_request, reply) => {
    return ok(reply, { data: getPushPublicConfig() });
  });

  app.post("/push/subscribe", async (request, reply) => {
    const body = request.body as SubscribeBody;
    const subscription = body.subscription;
    if (
      !body.deviceId ||
      !subscription?.endpoint ||
      !subscription.keys?.p256dh ||
      !subscription.keys?.auth
    ) {
      throw badRequest("Subscription browser belum lengkap");
    }

    const user = await resolveOptionalUser(app, request);
    const saved = await upsertPushSubscription({
      userId: user?.id ?? null,
      deviceId: body.deviceId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      expirationTime:
        subscription.expirationTime != null
          ? new Date(subscription.expirationTime).toISOString()
          : null,
      userAgent: request.headers["user-agent"] ?? null,
      topics: body.topics,
      allowBroadcast: body.allowBroadcast ?? true,
    });

    return ok(reply, {
      message: "Push subscription tersimpan",
      data: { id: saved.id, userId: saved.userId },
    });
  });

  app.post("/push/unsubscribe", async (request, reply) => {
    const body = request.body as UnsubscribeBody;
    if (!body.endpoint) throw badRequest("Endpoint wajib diisi");
    const result = await removePushSubscription(body.endpoint, body.deviceId);
    return ok(reply, {
      message: "Push subscription dihapus",
      data: { deleted: result.count },
    });
  });

  app.get("/", { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as NotificationListQuery;
    const page = Math.max(1, Number(query.page ?? 1) || 1);
    const limit = Math.min(50, Math.max(1, Number(query.limit ?? 20) || 20));
    const skip = (page - 1) * limit;
    const unreadOnly = query.unreadOnly === "true";

    const where = {
      userId: request.user.id,
      ...(unreadOnly ? { isRead: false } : {}),
    };

    const [items, total, unreadCount] = await Promise.all([
      prisma.notificationRecipient.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          notification: {
            select: {
              id: true,
              scope: true,
              category: true,
              type: true,
              title: true,
              message: true,
              link: true,
              image: true,
              topic: true,
              payload: true,
              createdAt: true,
            },
          },
        },
      }),
      prisma.notificationRecipient.count({ where }),
      prisma.notificationRecipient.count({
        where: { userId: request.user.id, isRead: false },
      }),
    ]);

    return ok(reply, {
      data: items.map((item) => ({
        ...item.notification,
        id: item.id,
        recipientId: item.id,
        notificationId: item.notification.id,
        isRead: item.isRead,
        readAt: item.readAt,
        deliveredAt: item.deliveredAt,
        deliveredCreatedAt: item.createdAt,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        unreadCount,
      },
    });
  });

  app.post("/read", { preHandler: app.authenticate }, async (request, reply) => {
    const body = request.body as ReadBody;
    const recipientIds = [...(body.recipientIds ?? []), ...(body.ids ?? [])].filter((id) =>
      Number.isInteger(id),
    );
    const notificationIds = (body.notificationIds ?? []).filter((id) => Number.isInteger(id));
    if (recipientIds.length === 0 && notificationIds.length === 0) {
      throw badRequest("ID notifikasi wajib diisi");
    }

    const result = await prisma.notificationRecipient.updateMany({
      where: {
        userId: request.user.id,
        OR: [
          ...(recipientIds.length > 0 ? [{ id: { in: recipientIds } }] : []),
          ...(notificationIds.length > 0 ? [{ notificationId: { in: notificationIds } }] : []),
        ],
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return ok(reply, { data: { updated: result.count } });
  });

  app.post("/read-all", { preHandler: app.authenticate }, async (request, reply) => {
    const result = await prisma.notificationRecipient.updateMany({
      where: {
        userId: request.user.id,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return ok(reply, { data: { updated: result.count } });
  });

  app.get("/preferences", { preHandler: app.authenticate }, async (request, reply) => {
    const preference = await ensureNotificationPreference(request.user.id);
    return ok(reply, { data: preference });
  });

  app.put("/preferences", { preHandler: app.authenticate }, async (request, reply) => {
    const body = request.body as PreferenceBody;
    const updated = await prisma.notificationPreference.upsert({
      where: { userId: request.user.id },
      update: {
        announcement: body.announcement,
        contentNew: body.contentNew,
        contentUpdate: body.contentUpdate,
        personalActivity: body.personalActivity,
        watchReminder: body.watchReminder,
        accountSystem: body.accountSystem,
        adminOperational: body.adminOperational,
        pushEnabled: body.pushEnabled,
        inAppEnabled: body.inAppEnabled,
      },
      create: {
        userId: request.user.id,
        announcement: body.announcement ?? true,
        contentNew: body.contentNew ?? true,
        contentUpdate: body.contentUpdate ?? true,
        personalActivity: body.personalActivity ?? true,
        watchReminder: body.watchReminder ?? true,
        accountSystem: body.accountSystem ?? true,
        adminOperational: body.adminOperational ?? true,
        pushEnabled: body.pushEnabled ?? true,
        inAppEnabled: body.inAppEnabled ?? true,
      },
    });

    return ok(reply, { message: "Preferensi notifikasi diperbarui", data: updated });
  });
};

export default notificationRoutes;
