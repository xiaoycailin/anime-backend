import { readFile } from "fs/promises";
import path from "path";

let cached: { loadedAt: number; text: string } | null = null;

function clean(text: string) {
  return String(text || "").replace(/\r\n/g, "\n").trim();
}

function maxChars() {
  const raw = Number(process.env.SUPPORT_KNOWLEDGE_MAX_CHARS ?? 12000);
  if (!Number.isFinite(raw) || raw <= 2000) return 12000;
  return Math.floor(raw);
}

function clampToMax(text: string) {
  const limit = maxChars();
  if (text.length <= limit) return text;
  return [
    text.slice(0, limit),
    "",
    `[truncated: SUPPORT_KNOWLEDGE_MAX_CHARS=${limit}]`,
  ].join("\n");
}

export async function getSupportKnowledgeText() {
  if (cached) return cached.text;

  const candidates = [
    path.join(process.cwd(), "src/services/support/support-knowledge.md"),
    path.join(
      process.cwd(),
      "backend-api/src/services/support/support-knowledge.md",
    ),
  ];

  for (const filePath of candidates) {
    try {
      const raw = await readFile(filePath, "utf8");
      cached = { loadedAt: Date.now(), text: clampToMax(clean(raw)) };
      return cached.text;
    } catch {
      // try next
    }
  }

  cached = { loadedAt: Date.now(), text: "" };
  return "";
}
