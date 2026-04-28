import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { calculateLevel } from "./exp.service";

const FRAME_BASE_PATH = "/frame-border";
const DECORATION_TYPES = ["frame", "nametag", "effect"] as const;

export type DecorationType = (typeof DECORATION_TYPES)[number];

/** Maksimum profile effect yang bisa di-equip secara bersamaan. */
export const MAX_EQUIPPED_EFFECTS = 3;

export type NameTagConfig = {
  style?:
    | "aura"
    | "glitch"
    | "cosmic"
    | "glitch-glasses"
    | "blood-god"
    | "royal";
};

export type EffectConfig = {
  src?: string;
  loop?: boolean;
  duration?: number;
};

export type DecorationConfig =
  | NameTagConfig
  | EffectConfig
  | Record<string, unknown>;

const DECORATION_SELECT = {
  id: true,
  name: true,
  type: true,
  asset: true,
  config: true,
  requiredLevel: true,
  priceExp: true,
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
  priceExp: number;
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
  priceExp: number;
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

export type EquippedEffectDTO = NonNullable<EquippedDecorationDTO>;

export type EquippedFrameDTO = EquippedDecorationDTO;
export type EquippedNameTagDTO = EquippedDecorationDTO;

export type EquippedDecorationsDTO = {
  frame: EquippedDecorationDTO;
  nametag: EquippedDecorationDTO;
  effects: EquippedEffectDTO[];
};

export type PurchaseResultDTO = {
  decoration: EquippedDecorationDTO;
  exp: number;
  level: number;
  spentExp: number;
};

function emptyEquipped(): EquippedDecorationsDTO {
  return { frame: null, nametag: null, effects: [] };
}

function normalizeType(type: string | null | undefined): DecorationType {
  if (type === "nametag") return "nametag";
  if (type === "effect") return "effect";
  return "frame";
}

function toConfig(config: Prisma.JsonValue | null): DecorationConfig {
  if (config && typeof config === "object" && !Array.isArray(config)) {
    return config as DecorationConfig;
  }
  return {};
}

function isRemoteFrameAsset(asset: string | null | undefined) {
  return Boolean(asset?.trim().toLowerCase().startsWith("https://"));
}

function toAssetUrl(decoration: {
  type: string;
  asset: string | null;
  config: Prisma.JsonValue | null;
}) {
  const type = normalizeType(decoration.type);
  if (type === "frame") {
    const asset = decoration.asset?.trim();
    if (!asset) return null;
    if (isRemoteFrameAsset(asset) || asset.startsWith("/")) return asset;
    return `${FRAME_BASE_PATH}/${asset}`;
  }
  if (type === "effect") {
    const cfg = toConfig(decoration.config) as EffectConfig;
    return typeof cfg.src === "string" && cfg.src ? cfg.src : null;
  }
  return null;
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
    priceExp: decoration.priceExp ?? 0,
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

/**
 * Auto-grant decorations berdasarkan level. Hanya berlaku untuk type "frame" &
 * "nametag" — type "effect" diakuisisi via exchange EXP, jadi TIDAK boleh
 * di-auto-grant berdasarkan level.
 */
export async function syncUnlocks(userId: number, level: number) {
  const eligible = await prisma.decoration.findMany({
    where: {
      isActive: true,
      requiredLevel: { lte: level },
      type: { in: ["frame", "nametag"] },
      priceExp: { lte: 0 },
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
    orderBy: [
      { type: "asc" },
      { sortOrder: "asc" },
      { requiredLevel: "asc" },
      { id: "asc" },
    ],
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
    const dto = toDTO(decoration);
    const ownership = ownedMap.get(decoration.id);
    // Type "effect": "isUnlocked" hanya benar saat sudah dibeli (priceExp > 0
    // tidak boleh auto-unlock by level).
    const isPurchasable = dto.type === "effect" || dto.priceExp > 0;
    const isUnlocked = isPurchasable
      ? Boolean(ownership)
      : level >= dto.requiredLevel;
    return {
      ...dto,
      isUnlocked,
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

export type EquipResult =
  | { ok: true; equipped: EquippedDecorationDTO; type: DecorationType }
  | {
      ok: false;
      reason: "not_owned" | "max_effects_reached";
      max?: number;
    };

export async function equipDecoration(
  userId: number,
  decorationId: number,
): Promise<EquipResult> {
  return prisma.$transaction(async (tx) => {
    const owned = await tx.userDecoration.findUnique({
      where: { userId_decorationId: { userId, decorationId } },
      include: { decoration: { select: DECORATION_SELECT } },
    });

    if (!owned || !owned.decoration.isActive) {
      return { ok: false, reason: "not_owned" } as const;
    }

    const decorationType = normalizeType(owned.decoration.type);

    if (decorationType === "effect") {
      // Effect: boleh equip multiple sampai MAX_EQUIPPED_EFFECTS.
      if (!owned.isEquipped) {
        const equippedCount = await tx.userDecoration.count({
          where: {
            userId,
            isEquipped: true,
            decoration: { type: "effect" },
          },
        });
        if (equippedCount >= MAX_EQUIPPED_EFFECTS) {
          return {
            ok: false,
            reason: "max_effects_reached",
            max: MAX_EQUIPPED_EFFECTS,
          } as const;
        }
        await tx.userDecoration.update({
          where: { id: owned.id },
          data: { isEquipped: true },
        });
      }
    } else {
      // Frame / nametag: max 1 — unequip yang lama.
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
    }

    return {
      ok: true,
      equipped: toEquippedDTO(owned.decoration),
      type: decorationType,
    } as const;
  });
}

/**
 * Lepas dekorasi.
 * - Untuk frame/nametag: lepas yang sedang ter-equip dari type tersebut.
 * - Untuk effect: kalau `decorationId` diberikan, lepas effect itu saja; kalau
 *   tidak, lepas SEMUA effect ter-equip.
 */
export async function unequipDecoration(
  userId: number,
  options: { type?: DecorationType; decorationId?: number } = {},
) {
  const { type, decorationId } = options;

  if (decorationId !== undefined) {
    await prisma.userDecoration.updateMany({
      where: { userId, decorationId, isEquipped: true },
      data: { isEquipped: false },
    });
    return;
  }

  await prisma.userDecoration.updateMany({
    where: {
      userId,
      isEquipped: true,
      ...(type ? { decoration: { type } } : {}),
    },
    data: { isEquipped: false },
  });
}

export async function getEquippedDecorations(
  userId: number,
): Promise<EquippedDecorationsDTO> {
  const equipped = await prisma.userDecoration.findMany({
    where: { userId, isEquipped: true, decoration: { isActive: true } },
    orderBy: [{ unlockedAt: "asc" }],
    include: { decoration: { select: DECORATION_SELECT } },
  });

  const result = emptyEquipped();
  for (const item of equipped) {
    const type = normalizeType(item.decoration.type);
    const dto = toEquippedDTO(item.decoration);
    if (!dto) continue;
    if (type === "effect") {
      if (result.effects.length < MAX_EQUIPPED_EFFECTS) {
        result.effects.push(dto);
      }
    } else if (type === "frame") {
      result.frame = dto;
    } else if (type === "nametag") {
      result.nametag = dto;
    }
  }
  return result;
}

export async function getEquippedDecoration(
  userId: number,
  type: Exclude<DecorationType, "effect">,
): Promise<EquippedDecorationDTO> {
  const equipped = await prisma.userDecoration.findFirst({
    where: { userId, isEquipped: true, decoration: { isActive: true, type } },
    include: { decoration: { select: DECORATION_SELECT } },
  });

  if (!equipped) return null;
  return toEquippedDTO(equipped.decoration);
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
    orderBy: [{ unlockedAt: "asc" }],
    include: { decoration: { select: DECORATION_SELECT } },
  });

  for (const userId of userIds) {
    result.set(userId, emptyEquipped());
  }

  for (const item of equipped) {
    const current = result.get(item.userId) ?? emptyEquipped();
    const type = normalizeType(item.decoration.type);
    const dto = toEquippedDTO(item.decoration);
    if (!dto) continue;
    if (type === "effect") {
      if (current.effects.length < MAX_EQUIPPED_EFFECTS) {
        current.effects.push(dto);
      }
    } else if (type === "frame") {
      current.frame = dto;
    } else if (type === "nametag") {
      current.nametag = dto;
    }
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

export type PurchaseError =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_purchasable" }
  | { ok: false; reason: "already_owned" }
  | { ok: false; reason: "insufficient_exp"; required: number; current: number }
  | { ok: false; reason: "user_not_found" };

export type PurchaseSuccess = {
  ok: true;
  result: PurchaseResultDTO;
};

export async function purchaseDecorationWithExp(
  userId: number,
  decorationId: number,
): Promise<PurchaseSuccess | PurchaseError> {
  return prisma.$transaction(async (tx) => {
    const decoration = await tx.decoration.findUnique({
      where: { id: decorationId },
      select: DECORATION_SELECT,
    });
    if (!decoration || !decoration.isActive) {
      return { ok: false, reason: "not_found" } as const;
    }
    if ((decoration.priceExp ?? 0) <= 0) {
      return { ok: false, reason: "not_purchasable" } as const;
    }

    const existing = await tx.userDecoration.findUnique({
      where: { userId_decorationId: { userId, decorationId } },
      select: { id: true },
    });
    if (existing) {
      return { ok: false, reason: "already_owned" } as const;
    }

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { exp: true, level: true },
    });
    if (!user) {
      return { ok: false, reason: "user_not_found" } as const;
    }

    const price = decoration.priceExp;
    if (user.exp < price) {
      return {
        ok: false,
        reason: "insufficient_exp",
        required: price,
        current: user.exp,
      } as const;
    }

    const newExp = Math.max(0, user.exp - price);
    const newLevel = calculateLevel(newExp);

    await tx.user.update({
      where: { id: userId },
      data: { exp: newExp, level: newLevel },
    });

    // ExpLog: simpan negative value sebagai jejak audit. refId unik per
    // (user, type, refId) — sudah dijamin tidak bentrok via guard "already_owned"
    // di atas, tapi tetap aman karena dekorasi cuma bisa dibeli sekali per user.
    await tx.expLog.create({
      data: {
        userId,
        type: "decoration_purchase",
        value: -price,
        refId: `decoration:${decorationId}`,
      },
    });

    await tx.userDecoration.create({
      data: { userId, decorationId, isEquipped: false },
    });

    return {
      ok: true,
      result: {
        decoration: toEquippedDTO(decoration),
        exp: newExp,
        level: newLevel,
        spentExp: price,
      },
    } as const;
  });
}
