import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getEquippedDecorations, syncUnlocks } from "./decoration.service";

export type ExpType =
  | "open_app"
  | "watch_30s"
  | "watch_80_bonus"
  | "comment"
  | "episode_like"
  | "comment_like";

type AddExpResult = {
  granted: boolean;
  reason?: "duplicate" | "cooldown" | "invalid";
  value: number;
  totalExp?: number;
  level?: number;
  badge?: ReturnType<typeof getCultivationBadge>;
  cooldownRemainingSec?: number;
};

const COOLDOWNS_MS: Partial<Record<ExpType, number>> = {
  open_app: 60 * 60 * 1000,
  comment: 20 * 60 * 1000,
};

const MAX_WATCH_DURATION_SEC = 6 * 60 * 60;

export function calculateLevel(exp: number) {
  return Math.max(1, Math.floor(Math.sqrt(Math.max(0, exp) / 100)));
}

export function getCultivationBadge(level: number) {
  if (level >= 99) {
    return {
      name: "God Immortal",
      color: "linear-gradient(135deg, #fde68a, #f472b6, #a78bfa, #38bdf8)",
    };
  }
  if (level >= 91) {
    return {
      name: "Ascendant Immortal",
      color: "linear-gradient(135deg, #e9d5ff, #a78bfa, #22d3ee)",
    };
  }
  if (level >= 71) {
    return {
      name: "Dao Integration",
      color: "linear-gradient(135deg, #67e8f9, #60a5fa, #818cf8)",
    };
  }
  if (level >= 51) {
    return {
      name: "Void Refinement",
      color: "linear-gradient(135deg, #c084fc, #6366f1, #0f172a)",
    };
  }
  if (level >= 36) {
    return {
      name: "Soul Transformation",
      color: "linear-gradient(135deg, #fb7185, #f97316, #facc15)",
    };
  }
  if (level >= 21) {
    return {
      name: "Nascent Soul",
      color: "linear-gradient(135deg, #34d399, #14b8a6, #0ea5e9)",
    };
  }
  if (level >= 11) {
    return {
      name: "Core Formation",
      color: "linear-gradient(135deg, #f59e0b, #ef4444, #ec4899)",
    };
  }
  if (level >= 6) {
    return {
      name: "Foundation Establishment",
      color: "linear-gradient(135deg, #8b5cf6, #6366f1, #22d3ee)",
    };
  }
  return {
    name: "Qi Condensation",
    color: "linear-gradient(135deg, #a78bfa, #7c3aed, #4f46e5)",
  };
}

export function getLevelProgress(exp: number, level = calculateLevel(exp)) {
  const currentLevelExp = level <= 1 ? 0 : Math.pow(level, 2) * 100;
  const nextLevelExp = Math.pow(level + 1, 2) * 100;
  const span = Math.max(1, nextLevelExp - currentLevelExp);
  const progress = Math.min(100, Math.max(0, ((exp - currentLevelExp) / span) * 100));

  return {
    currentLevelExp,
    nextLevelExp,
    progress,
    remainingExp: Math.max(0, nextLevelExp - exp),
  };
}

export async function checkCooldown(userId: number, type: ExpType) {
  const cooldownMs = COOLDOWNS_MS[type] ?? 0;
  if (!cooldownMs) return { allowed: true, remainingMs: 0 };

  const latest = await prisma.expLog.findFirst({
    where: { userId, type },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  if (!latest) return { allowed: true, remainingMs: 0 };

  const elapsed = Date.now() - latest.createdAt.getTime();
  const remainingMs = Math.max(0, cooldownMs - elapsed);
  return { allowed: remainingMs <= 0, remainingMs };
}

export async function addExp(
  userId: number,
  type: ExpType,
  value: number,
  refId?: string | null,
): Promise<AddExpResult> {
  const normalizedValue = Math.floor(Number(value));
  if (!Number.isFinite(normalizedValue) || normalizedValue <= 0) {
    return { granted: false, reason: "invalid", value: 0 };
  }

  if (refId) {
    const duplicate = await prisma.expLog.findFirst({
      where: { userId, type, refId },
      select: { id: true },
    });
    if (duplicate) return { granted: false, reason: "duplicate", value: 0 };
  }

  const cooldown = await checkCooldown(userId, type);
  if (!cooldown.allowed) {
    return {
      granted: false,
      reason: "cooldown",
      value: 0,
      cooldownRemainingSec: Math.ceil(cooldown.remainingMs / 1000),
    };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { exp: true, level: true },
      });
      if (!user) return null;

      const previousLevel = user.level;
      const totalExp = user.exp + normalizedValue;
      const level = calculateLevel(totalExp);

      await tx.expLog.create({
        data: {
          userId,
          type,
          value: normalizedValue,
          refId: refId ?? null,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          exp: totalExp,
          level,
          lastExpGainAt: new Date(),
        },
      });

      return {
        previousLevel,
        totalExp,
        level,
      };
    });

    if (!result) return { granted: false, reason: "invalid", value: 0 };

    if (result.level > result.previousLevel) {
      await syncUnlocks(userId, result.level).catch(() => null);
    }

    return {
      granted: true,
      value: normalizedValue,
      totalExp: result.totalExp,
      level: result.level,
      badge: getCultivationBadge(result.level),
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { granted: false, reason: "duplicate", value: 0 };
    }
    throw error;
  }
}

export async function grantWatchExp(input: {
  userId: number;
  episodeId: number;
  progressSec: number;
  durationSec: number;
  previousProgressSec?: number;
}) {
  const episodeId = Math.floor(Number(input.episodeId));
  const durationSec = Number(input.durationSec);
  const progressSec = Number(input.progressSec);
  const previousProgressSec = Math.max(0, Number(input.previousProgressSec ?? 0));

  if (
    !Number.isFinite(episodeId) ||
    episodeId <= 0 ||
    !Number.isFinite(durationSec) ||
    durationSec < 30 ||
    durationSec > MAX_WATCH_DURATION_SEC ||
    !Number.isFinite(progressSec)
  ) {
    return { granted: 0, value: 0, logs: [] as AddExpResult[] };
  }

  const safeProgress = Math.min(Math.max(0, progressSec), durationSec);
  const safePrevious = Math.min(previousProgressSec, durationSec);
  const previousBucket = Math.floor(safePrevious / 30);
  const currentBucket = Math.floor(safeProgress / 30);
  const logs: AddExpResult[] = [];

  for (let bucket = previousBucket + 1; bucket <= currentBucket; bucket += 1) {
    logs.push(
      await addExp(input.userId, "watch_30s", 20, `episode:${episodeId}:watch:${bucket}`),
    );
  }

  if (safeProgress / durationSec >= 0.8) {
    logs.push(await addExp(input.userId, "watch_80_bonus", 100, `episode:${episodeId}:bonus80`));
  }

  return {
    granted: logs.filter((log) => log.granted).length,
    value: logs.reduce((total, log) => total + (log.granted ? log.value : 0), 0),
    logs,
  };
}

export async function getUserExpProfile(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      exp: true,
      level: true,
      lastExpGainAt: true,
    },
  });

  if (!user) return null;

  const level = user.level ?? calculateLevel(user.exp);
  const progress = getLevelProgress(user.exp, level);
  await syncUnlocks(userId, level).catch(() => null);
  const equipped = await getEquippedDecorations(userId);

  return {
    ...user,
    level,
    badge: getCultivationBadge(level),
    progress,
    frame: equipped.frame,
    nametag: equipped.nametag,
  };
}
