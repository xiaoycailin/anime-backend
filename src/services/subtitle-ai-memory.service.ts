import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SubtitleAiContext } from "./subtitle-auto-generate-core.service";

export type SubtitleAiProjectMemory = {
  contextKey: string;
  notes: string[];
  updatedAt: string;
};

type MemoryFile = SubtitleAiProjectMemory & {
  userKey: string;
  context: SubtitleAiContext;
  expiresAt: string;
};

const MEMORY_TTL_MS = 60 * 60 * 1000;
const MAX_NOTES = 10;
const memoryDir = path.join(process.cwd(), "memory", "subtitle-ai");

function cleanString(value: unknown, maxLength = 240) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function contextKey(context?: SubtitleAiContext) {
  const normalized = {
    animeTitle: cleanString(context?.animeTitle, 160).toLowerCase(),
    episodeTitle: cleanString(context?.episodeTitle, 180).toLowerCase(),
    episodeNumber: context?.episodeNumber ?? "",
    targetLanguage: cleanString(context?.targetLanguage, 32).toLowerCase(),
    targetLabel: cleanString(context?.targetLabel, 80).toLowerCase(),
  };
  return createHash("sha1").update(JSON.stringify(normalized)).digest("hex");
}

function userKey(userId?: number | string) {
  const raw = cleanString(userId, 80) || "anonymous-admin";
  return raw.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80);
}

function memoryPath(userId: number | string | undefined, key: string) {
  return path.join(memoryDir, `${userKey(userId)}-${key}.json`);
}

function parseMemory(raw: string) {
  try {
    return JSON.parse(raw) as Partial<MemoryFile>;
  } catch {
    return null;
  }
}

async function pruneExpiredMemories() {
  const entries = await fs.readdir(memoryDir).catch(() => []);
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const filePath = path.join(memoryDir, entry);
        const raw = await fs.readFile(filePath, "utf8").catch(() => "");
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as Partial<MemoryFile>;
          const expiresAt = Date.parse(String(parsed.expiresAt ?? ""));
          if (!Number.isFinite(expiresAt) || expiresAt <= now) {
            await fs.unlink(filePath).catch(() => {});
          }
        } catch {
          await fs.unlink(filePath).catch(() => {});
        }
      }),
  );
}

export async function loadSubtitleAiMemory(input: {
  userId?: number | string;
  context?: SubtitleAiContext;
}): Promise<SubtitleAiProjectMemory | null> {
  const key = contextKey(input.context);
  await pruneExpiredMemories();
  const raw = await fs.readFile(memoryPath(input.userId, key), "utf8").catch(() => "");
  if (!raw) return null;

  const parsed = parseMemory(raw) as MemoryFile | null;
  if (!parsed) return null;
  if (parsed.contextKey !== key || Date.parse(parsed.expiresAt) <= Date.now()) {
    return null;
  }

  return {
    contextKey: parsed.contextKey,
    notes: Array.isArray(parsed.notes) ? parsed.notes.slice(-MAX_NOTES) : [],
    updatedAt: String(parsed.updatedAt ?? ""),
  };
}

export async function rememberSubtitleAiInstruction(input: {
  userId?: number | string;
  context?: SubtitleAiContext;
  instruction: string;
  aiMessage?: string;
}) {
  const instruction = cleanString(input.instruction, 500);
  if (!instruction) return null;

  await fs.mkdir(memoryDir, { recursive: true });
  await pruneExpiredMemories();

  const key = contextKey(input.context);
  const filePath = memoryPath(input.userId, key);
  const existing = await fs.readFile(filePath, "utf8").catch(() => "");
  const parsed = existing ? parseMemory(existing) : null;
  const previousNotes = parsed?.contextKey === key ? parsed.notes ?? [] : [];
  const aiMessage = cleanString(input.aiMessage, 220);
  const nextNote = aiMessage ? `${instruction} -> ${aiMessage}` : instruction;
  const notes = [...previousNotes, nextNote]
    .map((note) => cleanString(note, 520))
    .filter(Boolean)
    .slice(-MAX_NOTES);
  const now = new Date();

  const payload: MemoryFile = {
    userKey: userKey(input.userId),
    contextKey: key,
    context: input.context ?? {},
    notes,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + MEMORY_TTL_MS).toISOString(),
  };

  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  return {
    contextKey: key,
    notes,
    updatedAt: payload.updatedAt,
  } satisfies SubtitleAiProjectMemory;
}
