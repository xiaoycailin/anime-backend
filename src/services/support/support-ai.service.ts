import { badRequest } from "../../utils/http-error";
import { CS_BOT_DISPLAY_NAME } from "./support.constants";
import type { SupportMessagePayload } from "./support.types";
import { getSupportKnowledgeText } from "./support-knowledge";

type SupportAiResult = {
  reply: string;
  confidence: number;
  handoffRequired: boolean;
  handoffReason: string;
  summaryForAdmin: string;
};

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function clamp01(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function resolveTextModel() {
  return cleanString(process.env.OPENAI_TEXT_MODEL) || "gpt-5.4-mini";
}

function requireOpenAiKey() {
  const value = cleanString(process.env.OPENAI_API_KEY);
  if (!value) return null;
  return value;
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}$/);
  if (match) return match[0];
  throw badRequest("Respons AI bukan JSON valid");
}

function isHumanRequest(text: string) {
  return /\b(cs|customer\s*service|admin|operator|manusia|orang\s*asli|agent)\b/i.test(
    text,
  );
}

function isSensitiveTopic(text: string) {
  return /\b(password|kata\s*sandi|pembayaran|payment|refund|ban|banned|hack|phishing|data\s*pribadi)\b/i.test(
    text,
  );
}

function isOutOfScope(text: string) {
  // Support chat is for Weebin product support, not general tutoring.
  // Keep this conservative: only block clearly unrelated requests.
  return /\b(bikin|buat)\s+(website|web)\b/i.test(text)
    || /\b(kode|coding|ngoding|script)\b/i.test(text)
    || /\b(html|css|javascript|typescript|react|nextjs|wordpress|vue|angular|laravel)\b/i.test(text)
    || /\bbuat\s+aplikasi\b/i.test(text);
}

function isSmallTalk(text: string) {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  // short acknowledgements, thanks, closings
  if (/^(ok(ay)?|oke|sip|siap|yup|ya|iya|yaudah|gpp|gapapa|mantap|nice|thanks|thx|makasih|terima kasih|tq|ty|bye|dadah|nanti|ntar)(\W|$)/i.test(t)) {
    return t.length <= 40;
  }
  // playful closings
  if (/(makasih|thanks|thx|sip|oke).*(baby|sayang|bestie)/i.test(t) && t.length <= 80) return true;
  return false;
}

function normalizeComparable(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function runSupportAiTriage(input: {
  userText: string;
  recentMessages: SupportMessagePayload[];
  aiFailures: number;
}): Promise<SupportAiResult> {
  const userText = input.userText.trim();
  if (!userText) {
    return {
      reply: "Tulis keluhannya ya.",
      confidence: 0.4,
      handoffRequired: false,
      handoffReason: "",
      summaryForAdmin: "",
    };
  }

  const lastAiReply =
    input.recentMessages
      .slice()
      .reverse()
      .find((m) => m.senderType === "ai")?.content ?? "";

  // Hard rules: user ask human / sensitive / repeated failures -> handoff.
  if (isHumanRequest(userText) || isSensitiveTopic(userText) || input.aiFailures >= 2) {
    return {
      reply:
        "Oke, aku terusin ke CS human ya. Tunggu sebentar, nanti dibalas.",
      confidence: 0.9,
      handoffRequired: true,
      handoffReason: isHumanRequest(userText)
        ? "USER_REQUESTED_HUMAN"
        : isSensitiveTopic(userText)
          ? "SENSITIVE_TOPIC"
          : "AI_REPEATED_FAILURES",
      summaryForAdmin: `User minta dibantu human. Keluhan: ${userText.slice(0, 240)}`,
    };
  }

  // Keep support channel on-topic (Weebin product support).
  if (isOutOfScope(userText)) {
    return {
      reply:
        "Ini chat support Weebin ya. Aku bisa bantu masalah di Weebin (video gak bisa play, subtitle, akun, komentar, notifikasi, dll).\n\nCoba jelasin masalahnya kamu ngalamin apa di Weebin dan terjadi di judul/episode mana?",
      confidence: 0.8,
      handoffRequired: false,
      handoffReason: "OUT_OF_SCOPE",
      summaryForAdmin: "",
    };
  }

  // If user only small-talks, keep it short and do not spam repetitive templates.
  if (isSmallTalk(userText)) {
    return {
      reply: /baby|sayang|bestie/i.test(userText)
        ? "siap, sama-sama ya 😄"
        : "siap 🙌",
      confidence: 0.85,
      handoffRequired: false,
      handoffReason: "",
      summaryForAdmin: "",
    };
  }

  const apiKey = requireOpenAiKey();
  if (!apiKey) {
    return {
      reply:
        "Aku belum bisa jawab pakai AI sekarang. Aku terusin ke CS human ya.",
      confidence: 0.7,
      handoffRequired: true,
      handoffReason: "OPENAI_KEY_MISSING",
      summaryForAdmin: `OPENAI_API_KEY kosong. User: ${userText.slice(0, 240)}`,
    };
  }

  const memory = input.recentMessages
    .slice(-12)
    .map((m) => `${m.senderDisplay.name}: ${m.content}`)
    .join("\n");

  const knowledge = await getSupportKnowledgeText().catch(() => "");

  const systemPrompt = [
    `Kamu adalah CS AI bernama ${CS_BOT_DISPLAY_NAME}.`,
    "Tugas kamu: pahami konteks user dan jawab singkat, padat, jelas.",
    "Hindari jawaban yang repetitif. Kalau user cuma basa-basi (oke/makasih/sip/nanti), bales 1 kalimat pendek aja.",
    "Kalau tidak yakin, atau butuh akses internal, set handoffRequired=true.",
    "",
    "Context platform (wajib dipakai):",
    knowledge ? `\n---\n${knowledge}\n---\n` : "(knowledge kosong)",
    "",
    "Kembalikan JSON dengan keys: reply, confidence (0..1), handoffRequired, handoffReason, summaryForAdmin.",
  ].join("\n");

  const userPrompt = [
    "Riwayat (ringkas):",
    memory || "(kosong)",
    "",
    lastAiReply ? `Balasan AI terakhir (jangan diulang persis): ${lastAiReply}` : "",
    "",
    `Pesan user terbaru: ${userText}`,
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: resolveTextModel(),
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return {
      reply:
        "Aku lagi error jawab otomatis. Aku terusin ke CS human ya.",
      confidence: 0.6,
      handoffRequired: true,
      handoffReason: `OPENAI_ERROR:${payload?.error?.message ?? response.status}`,
      summaryForAdmin: `OpenAI error. User: ${userText.slice(0, 240)}`,
    };
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = cleanString(json.choices?.[0]?.message?.content);
  const parsed = JSON.parse(extractJsonObject(content)) as any;

  const reply = cleanString(parsed.reply).slice(0, 1500);
  const confidence = clamp01(parsed.confidence);
  const handoffRequired = Boolean(parsed.handoffRequired);
  const handoffReason = cleanString(parsed.handoffReason).slice(0, 120);
  const summaryForAdmin = cleanString(parsed.summaryForAdmin).slice(0, 900);

  const normalizedReply = normalizeComparable(reply);
  const normalizedLast = normalizeComparable(lastAiReply);
  const finalReply =
    normalizedReply && normalizedLast && normalizedReply === normalizedLast
      ? `${reply}\n\nBtw, biar aku bantu tepat: ini masalahnya di judul/episode apa?`
      : reply;

  return {
    reply: finalReply || "Aku bantu cek ya. Boleh jelasin detailnya sedikit lagi?",
    confidence,
    handoffRequired,
    handoffReason,
    summaryForAdmin,
  };
}
