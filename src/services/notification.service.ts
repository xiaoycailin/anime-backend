import crypto from "crypto";
import { prisma } from "../lib/prisma";
import {
  NotificationCategory,
  NotificationPreference,
  NotificationScope,
  Prisma,
} from "@prisma/client";

let webPushLib: typeof import("web-push") | null | undefined;

type PushTopicMap = Partial<Record<NotificationCategory, boolean>>;

type PushSubscriptionInput = {
  userId?: number | null;
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime?: string | null;
  userAgent?: string | null;
  allowBroadcast?: boolean;
  topics?: PushTopicMap;
};

type NotificationInput = {
  scope: NotificationScope;
  category: NotificationCategory;
  type: string;
  title: string;
  message: string;
  link?: string | null;
  image?: string | null;
  topic?: string | null;
  payload?: Prisma.InputJsonValue | null;
  createdById?: number | null;
};

type BroadcastNotificationInput = Omit<NotificationInput, "scope">;
type UserNotificationInput = Omit<NotificationInput, "scope"> & {
  userId: number;
};
type DevicePushNotificationInput = Omit<NotificationInput, "scope"> & {
  deviceId: string;
};
type RoleNotificationInput = Omit<NotificationInput, "scope"> & {
  role: string;
};
type SegmentNotificationInput = Omit<NotificationInput, "scope"> & {
  segment:
    | { type: "all-users" }
    | { type: "admins" }
    | { type: "saved-anime"; animeId: number }
    | { type: "genres"; genres: string[] };
};

const DEFAULT_TOPIC_SETTINGS: Record<NotificationCategory, boolean> = {
  announcement: true,
  content_new: true,
  content_update: true,
  personal_activity: true,
  watch_reminder: true,
  account_security: true,
  account_system: true,
  admin_operational: true,
};

const FORCED_CATEGORIES = new Set<NotificationCategory>([
  "account_security",
  "account_system",
]);

const preferenceKeyByCategory: Record<
  NotificationCategory,
  keyof NotificationPreference | null
> = {
  announcement: "announcement",
  content_new: "contentNew",
  content_update: "contentUpdate",
  personal_activity: "personalActivity",
  watch_reminder: "watchReminder",
  account_security: null,
  account_system: "accountSystem",
  admin_operational: "adminOperational",
};

function endpointHash(endpoint: string) {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

function normalizeTopics(topics?: PushTopicMap | null) {
  return {
    ...DEFAULT_TOPIC_SETTINGS,
    ...(topics ?? {}),
  };
}

function mapPushSubscription(record: {
  endpoint: string;
  p256dh: string;
  auth: string;
}) {
  return {
    endpoint: record.endpoint,
    keys: {
      p256dh: record.p256dh,
      auth: record.auth,
    },
  };
}

async function getWebPush() {
  if (webPushLib !== undefined) return webPushLib;

  try {
    const loaded = await import("web-push");
    const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    const subject =
      process.env.WEB_PUSH_VAPID_SUBJECT ?? "mailto:admin@example.com";

    if (!publicKey || !privateKey) {
      webPushLib = null;
      return webPushLib;
    }

    loaded.setVapidDetails(subject, publicKey, privateKey);
    webPushLib = loaded;
    return webPushLib;
  } catch {
    webPushLib = null;
    return webPushLib;
  }
}

function canUserReceiveCategory(
  category: NotificationCategory,
  preference: NotificationPreference | null | undefined,
) {
  if (FORCED_CATEGORIES.has(category)) return true;
  if (!preference) return true;

  const key = preferenceKeyByCategory[category];
  if (!key) return true;

  const value = preference[key];
  return typeof value === "boolean" ? value : true;
}

function canSubscriptionReceiveCategory(
  category: NotificationCategory,
  topics?: Prisma.JsonValue | null,
) {
  if (FORCED_CATEGORIES.has(category)) return true;
  if (!topics || typeof topics !== "object" || Array.isArray(topics)) {
    return DEFAULT_TOPIC_SETTINGS[category];
  }

  const value = (topics as Record<string, unknown>)[category];
  return typeof value === "boolean" ? value : DEFAULT_TOPIC_SETTINGS[category];
}

async function sendPush(
  subscriptions: Array<{
    id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>,
  payload: Record<string, unknown>,
) {
  const webPush = await getWebPush();
  if (!webPush || subscriptions.length === 0) return;

  const serialized = JSON.stringify(payload);

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(
          mapPushSubscription(subscription),
          serialized,
        );

        await prisma.pushSubscription.update({
          where: { id: subscription.id },
          data: { lastUsedAt: new Date(), isActive: true },
        });
      } catch {
        await prisma.pushSubscription.update({
          where: { id: subscription.id },
          data: { isActive: false },
        });
      }
    }),
  );
}

function pushPayload(notification: {
  id: number;
  category: NotificationCategory;
  type: string;
  title: string;
  message: string;
  link: string | null;
  image: string | null;
}) {
  return {
    id: notification.id,
    category: notification.category,
    type: notification.type,
    title: notification.title,
    body: notification.message,
    link: notification.link,
    image: notification.image,
  };
}

async function createNotificationRecord(input: NotificationInput) {
  return prisma.notification.create({
    data: {
      scope: input.scope,
      category: input.category,
      type: input.type,
      title: input.title,
      message: input.message,
      link: input.link ?? null,
      image: input.image ?? null,
      topic: input.topic ?? null,
      payload: input.payload ?? Prisma.JsonNull,
      createdById: input.createdById ?? null,
    },
  });
}

export async function upsertPushSubscription(input: PushSubscriptionInput) {
  const hash = endpointHash(input.endpoint);

  return prisma.pushSubscription.upsert({
    where: { endpointHash: hash },
    update: {
      userId: input.userId ?? null,
      deviceId: input.deviceId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      expirationTime: input.expirationTime
        ? new Date(input.expirationTime)
        : null,
      userAgent: input.userAgent ?? null,
      allowBroadcast: input.allowBroadcast ?? true,
      topics: normalizeTopics(input.topics),
      isActive: true,
      lastUsedAt: new Date(),
    },
    create: {
      userId: input.userId ?? null,
      deviceId: input.deviceId,
      endpoint: input.endpoint,
      endpointHash: hash,
      p256dh: input.p256dh,
      auth: input.auth,
      expirationTime: input.expirationTime
        ? new Date(input.expirationTime)
        : null,
      userAgent: input.userAgent ?? null,
      allowBroadcast: input.allowBroadcast ?? true,
      topics: normalizeTopics(input.topics),
      isActive: true,
      lastUsedAt: new Date(),
    },
  });
}

export async function removePushSubscription(
  endpoint: string,
  deviceId?: string | null,
) {
  const hash = endpointHash(endpoint);

  return prisma.pushSubscription.deleteMany({
    where: {
      endpointHash: hash,
      ...(deviceId ? { deviceId } : {}),
    },
  });
}

export async function ensureNotificationPreference(userId: number) {
  return prisma.notificationPreference.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
}

export async function createBroadcastNotification(
  input: BroadcastNotificationInput,
) {
  const notification = await createNotificationRecord({
    ...input,
    scope: "broadcast",
  });

  const users = await prisma.user.findMany({
    select: {
      id: true,
      notificationPreference: true,
    },
  });

  const allowedUsers = users.filter((user) =>
    canUserReceiveCategory(input.category, user.notificationPreference),
  );

  if (allowedUsers.length > 0) {
    await prisma.notificationRecipient.createMany({
      data: allowedUsers.map((user) => ({
        notificationId: notification.id,
        userId: user.id,
        kind: "user",
      })),
      skipDuplicates: true,
    });
  }

  const subscriptions = await prisma.pushSubscription.findMany({
    where: {
      isActive: true,
      allowBroadcast: true,
    },
    select: {
      id: true,
      endpoint: true,
      p256dh: true,
      auth: true,
      topics: true,
    },
  });

  await sendPush(
    subscriptions.filter((subscription) =>
      canSubscriptionReceiveCategory(input.category, subscription.topics),
    ),
    pushPayload(notification),
  );

  return notification;
}

export async function createUserNotification(input: UserNotificationInput) {
  const [notification, preference] = await Promise.all([
    createNotificationRecord({
      ...input,
      scope: "user",
    }),
    ensureNotificationPreference(input.userId),
  ]);

  if (canUserReceiveCategory(input.category, preference)) {
    await prisma.notificationRecipient.create({
      data: {
        notificationId: notification.id,
        userId: input.userId,
        kind: "user",
      },
    });
  }

  const subscriptions = await prisma.pushSubscription.findMany({
    where: {
      userId: input.userId,
      isActive: true,
    },
    select: {
      id: true,
      endpoint: true,
      p256dh: true,
      auth: true,
      topics: true,
    },
  });

  await sendPush(
    subscriptions.filter((subscription) =>
      canSubscriptionReceiveCategory(input.category, subscription.topics),
    ),
    pushPayload(notification),
  );

  return notification;
}

export async function createDevicePushNotification(
  input: DevicePushNotificationInput,
) {
  const notification = await createNotificationRecord({
    ...input,
    scope: "user",
  });

  const subscriptions = await prisma.pushSubscription.findMany({
    where: {
      deviceId: input.deviceId,
      isActive: true,
    },
    select: {
      id: true,
      endpoint: true,
      p256dh: true,
      auth: true,
      topics: true,
    },
  });

  await sendPush(
    subscriptions.filter((subscription) =>
      canSubscriptionReceiveCategory(input.category, subscription.topics),
    ),
    pushPayload(notification),
  );

  return notification;
}

export async function createRoleNotification(input: RoleNotificationInput) {
  const notification = await createNotificationRecord({
    ...input,
    scope: "role",
  });

  const users = await prisma.user.findMany({
    where: { role: input.role },
    select: {
      id: true,
      notificationPreference: true,
    },
  });

  const allowedUsers = users.filter((user) =>
    canUserReceiveCategory(input.category, user.notificationPreference),
  );

  if (allowedUsers.length > 0) {
    await prisma.notificationRecipient.createMany({
      data: allowedUsers.map((user) => ({
        notificationId: notification.id,
        userId: user.id,
        role: input.role,
        kind: "role",
      })),
      skipDuplicates: true,
    });
  }

  const subscriptions = await prisma.pushSubscription.findMany({
    where: {
      user: { role: input.role },
      isActive: true,
    },
    select: {
      id: true,
      endpoint: true,
      p256dh: true,
      auth: true,
      topics: true,
    },
  });

  await sendPush(
    subscriptions.filter((subscription) =>
      canSubscriptionReceiveCategory(input.category, subscription.topics),
    ),
    pushPayload(notification),
  );

  return notification;
}

async function resolveSegmentUsers(
  segment: SegmentNotificationInput["segment"],
) {
  if (segment.type === "all-users") {
    return prisma.user.findMany({
      select: { id: true, notificationPreference: true },
    });
  }

  if (segment.type === "admins") {
    return prisma.user.findMany({
      where: { role: "admin" },
      select: { id: true, notificationPreference: true },
    });
  }

  if (segment.type === "saved-anime") {
    const rows = await prisma.savedAnime.findMany({
      where: { animeId: segment.animeId },
      distinct: ["userId"],
      select: {
        user: {
          select: {
            id: true,
            notificationPreference: true,
          },
        },
      },
    });

    return rows.map((row) => row.user);
  }

  const genres = [
    ...new Set(segment.genres.map((item) => item.trim()).filter(Boolean)),
  ];
  if (genres.length === 0) return [];

  const animeIds = (
    await prisma.anime.findMany({
      where: {
        genres: {
          some: {
            genre: {
              name: {
                in: genres,
              },
            },
          },
        },
      },
      select: { id: true },
    })
  ).map((anime) => anime.id);

  if (animeIds.length === 0) return [];

  const rows = await prisma.savedAnime.findMany({
    where: {
      animeId: {
        in: animeIds,
      },
    },
    distinct: ["userId"],
    select: {
      user: {
        select: {
          id: true,
          notificationPreference: true,
        },
      },
    },
  });

  return rows.map((row) => row.user);
}

export async function createSegmentNotification(
  input: SegmentNotificationInput,
) {
  const notification = await createNotificationRecord({
    ...input,
    scope: "user",
  });

  const users = await resolveSegmentUsers(input.segment);
  const allowedUsers = users.filter((user) =>
    canUserReceiveCategory(input.category, user.notificationPreference),
  );

  if (allowedUsers.length > 0) {
    await prisma.notificationRecipient.createMany({
      data: allowedUsers.map((user) => ({
        notificationId: notification.id,
        userId: user.id,
        kind: "user",
      })),
      skipDuplicates: true,
    });
  }

  const subscriptions = await prisma.pushSubscription.findMany({
    where: {
      userId: {
        in: allowedUsers.map((user) => user.id),
      },
      isActive: true,
    },
    select: {
      id: true,
      endpoint: true,
      p256dh: true,
      auth: true,
      topics: true,
    },
  });

  await sendPush(
    subscriptions.filter((subscription) =>
      canSubscriptionReceiveCategory(input.category, subscription.topics),
    ),
    pushPayload(notification),
  );

  return {
    notification,
    recipientCount: allowedUsers.length,
  };
}

export function getPushPublicConfig() {
  return {
    publicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY ?? null,
    enabled: Boolean(
      process.env.WEB_PUSH_VAPID_PUBLIC_KEY &&
      process.env.WEB_PUSH_VAPID_PRIVATE_KEY,
    ),
  };
}
