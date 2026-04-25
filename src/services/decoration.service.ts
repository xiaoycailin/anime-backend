import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

const FRAME_BASE_PATH = "/frame-border";
const DECORATION_TYPES = ["frame", "nametag"] as const;

export type DecorationType = (typeof DECORATION_TYPES)[number];

export type NameTagConfig = {
  style?: "aura" | "glitch" | "cosmic" | "glitch-glasses" | "blood-god";
};

export type DecorationConfig = NameTagConfig | Record<string, unknown>;

const DECORATION_SELECT = {
  id: true,
  name: true,
  type: true,
  asset: true,
  config: true,
  requiredLevel: true,
  sortOrder: true,
  isActive: true,
} as const;

type SelectedDecoration = {
  id: number;
  name: string;
  type: string;
  asset: string | null;
  config: Prisma.JsonValue | null;
  requiredLevel: number;
  sortOrder: number;
};

export type DecorationDTO = {
  id: number;
  name: string;
  type: DecorationType;
  asset: string | null;
  assetUrl: string | null;
  config: DecorationConfig;
  requiredLevel: number;
  sortOrder: number;
};

export type ShopDecorationDTO = DecorationDTO & {
  isUnlocked: boolean;
  isOwned: boolean;
  isEquipped: boolean;
  unlockedAt: string | null;
};

export type OwnedDecorationDTO = DecorationDTO & {
  isEquipped: boolean;
  unlockedAt: string;
};

export type EquippedDecorationDTO = Pick<
  DecorationDTO,
  "id" | "name" | "type" | "asset" | "assetUrl" | "config"
> | null;

export type EquippedFrameDTO = EquippedDecorationDTO;
export type EquippedNameTagDTO = EquippedDecorationDTO;

export type EquippedDecorationsDTO = {
  frame: EquippedDecorationDTO;
  nametag: EquippedDecorationDTO;
};

function normalizeType(type: string | null | undefined): DecorationType {
  return type === "nametag" ? "nametag" : "frame";
}

function toConfig(config: Prisma.JsonValue | null): DecorationConfig {
  if (config && typeof config === "object" && !Array.isArray(config)) {
    return config as DecorationConfig;
  }
  return {};
}

function toAssetUrl(decoration: { type: string; asset: string | null }) {
  if (normalizeType(decoration.type) !== "frame" || !decoration.asset) return null;
  return `${FRAME_BASE_PATH}/${decoration.asset}`;
}

function toDTO(decoration: SelectedDecoration): DecorationDTO {
  return {
    id: decoration.id,
    name: decoration.name,
    type: normalizeType(decoration.type),
    asset: decoration.asset,
    assetUrl: toAssetUrl(decoration),
    config: toConfig(decoration.config),
    requiredLevel: decoration.requiredLevel,
    sortOrder: decoration.sortOrder,
  };
}

function toEquippedDTO(decoration: SelectedDecoration): EquippedDecorationDTO {
  const dto = toDTO(decoration);
  return {
    id: dto.id,
    name: dto.name,
    type: dto.type,
    asset: dto.asset,
    assetUrl: dto.assetUrl,
    config: dto.config,
  };
}

export async function syncUnlocks(userId: number, level: number) {
  const eligible = await prisma.decoration.findMany({
    where: {
      isActive: true,
      requiredLevel: { lte: level },
    },
    select: { id: true },
  });

  if (eligible.length === 0) return [];

  const data = eligible.map((decoration) => ({
    userId,
    decorationId: decoration.id,
  }));

  try {
    const result = await prisma.userDecoration.createMany({
      data,
      skipDuplicates: true,
    });
    return result.count > 0 ? eligible.map((decoration) => decoration.id) : [];
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return [];
    }
    throw error;
  }
}

export async function listDecorationsForUser(
  userId: number | null,
  level: number,
): Promise<ShopDecorationDTO[]> {
  const decorations = await prisma.decoration.findMany({
    where: { isActive: true },
    orderBy: [{ type: "asc" }, { requiredLevel: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    select: DECORATION_SELECT,
  });

  const owned = userId
    ? await prisma.userDecoration.findMany({
        where: { userId },
        select: {
          decorationId: true,
          isEquipped: true,
          unlockedAt: true,
        },
      })
    : [];

  const ownedMap = new Map(owned.map((item) => [item.decorationId, item]));

  return decorations.map((decoration) => {
    const ownership = ownedMap.get(decoration.id);
    return {
      ...toDTO(decoration),
      isUnlocked: level >= decoration.requiredLevel,
      isOwned: Boolean(ownership),
      isEquipped: Boolean(ownership?.isEquipped),
      unlockedAt: ownership?.unlockedAt.toISOString() ?? null,
    };
  });
}

export async function listOwnedDecorations(
  userId: number,
): Promise<OwnedDecorationDTO[]> {
  const owned = await prisma.userDecoration.findMany({
    where: { userId, decoration: { isActive: true } },
    orderBy: [{ isEquipped: "desc" }, { unlockedAt: "desc" }],
    include: { decoration: { select: DECORATION_SELECT } },
  });

  return owned.map((item) => ({
    ...toDTO(item.decoration),
    isEquipped: item.isEquipped,
    unlockedAt: item.unlockedAt.toISOString(),
  }));
}

export async function equipDecoration(
  userId: number,
  decorationId: number,
): Promise<EquippedDecorationDTO> {
  return prisma.$transaction(async (tx) => {
    const owned = await tx.userDecoration.findUnique({
      where: { userId_decorationId: { userId, decorationId } },
      include: { decoration: { select: DECORATION_SELECT } },
    });

    if (!owned || !owned.decoration.isActive) return null;

    const decorationType = normalizeType(owned.decoration.type);

    await tx.userDecoration.updateMany({
      where: {
        userId,
        isEquipped: true,
        decorationId: { not: decorationId },
        decoration: { type: decorationType },
      },
      data: { isEquipped: false },
    });

    if (!owned.isEquipped) {
      await tx.userDecoration.update({
        where: { id: owned.id },
        data: { isEquipped: true },
      });
    }

    return toEquippedDTO(owned.decoration);
  });
}

export async function unequipDecoration(
  userId: number,
  type?: DecorationType,
) {
  await prisma.userDecoration.updateMany({
    where: {
      userId,
      isEquipped: true,
      ...(type ? { decoration: { type } } : {}),
    },
    data: { isEquipped: false },
  });
}

export async function getEquippedDecoration(
  userId: number,
  type: DecorationType,
): Promise<EquippedDecorationDTO> {
  const equipped = await prisma.userDecoration.findFirst({
    where: { userId, isEquipped: true, decoration: { isActive: true, type } },
    include: { decoration: { select: DECORATION_SELECT } },
  });

  if (!equipped) return null;
  return toEquippedDTO(equipped.decoration);
}

export async function getEquippedDecorations(
  userId: number,
): Promise<EquippedDecorationsDTO> {
  const equipped = await prisma.userDecoration.findMany({
    where: { userId, isEquipped: true, decoration: { isActive: true } },
    include: { decoration: { select: DECORATION_SELECT } },
  });

  const result: EquippedDecorationsDTO = { frame: null, nametag: null };
  for (const item of equipped) {
    const type = normalizeType(item.decoration.type);
    result[type] = toEquippedDTO(item.decoration);
  }
  return result;
}

export async function getEquippedFrame(
  userId: number,
): Promise<EquippedFrameDTO> {
  return getEquippedDecoration(userId, "frame");
}

export async function getEquippedNameTag(
  userId: number,
): Promise<EquippedNameTagDTO> {
  return getEquippedDecoration(userId, "nametag");
}

export async function getEquippedDecorationsForUsers(
  userIds: number[],
): Promise<Map<number, EquippedDecorationsDTO>> {
  const result = new Map<number, EquippedDecorationsDTO>();
  if (userIds.length === 0) return result;

  const equipped = await prisma.userDecoration.findMany({
    where: {
      userId: { in: userIds },
      isEquipped: true,
      decoration: { isActive: true },
    },
    include: { decoration: { select: DECORATION_SELECT } },
  });

  for (const userId of userIds) {
    result.set(userId, { frame: null, nametag: null });
  }

  for (const item of equipped) {
    const current = result.get(item.userId) ?? { frame: null, nametag: null };
    const type = normalizeType(item.decoration.type);
    current[type] = toEquippedDTO(item.decoration);
    result.set(item.userId, current);
  }
  return result;
}

export async function getEquippedFramesForUsers(
  userIds: number[],
): Promise<Map<number, EquippedFrameDTO>> {
  const all = await getEquippedDecorationsForUsers(userIds);
  const result = new Map<number, EquippedFrameDTO>();
  for (const [userId, equipped] of all.entries()) {
    result.set(userId, equipped.frame);
  }
  return result;
}
