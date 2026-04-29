import { badRequest } from "../../../utils/http-error";
import { retrieveWeebinContext } from "./database";
import { buildChatbotMemory } from "./memory";
import {
  buildNoDataReply,
  buildSmallTalkReply,
  buildWeebinSystemPrompt,
  buildWeebinUserPrompt,
  cleanWeebinAiOutput,
  isLikelyOffTopic,
  isNoDataAnswer,
  isSmallTalk,
  sanitizeChatbotPrompt,
} from "./skills";
import type {
  ChatbotInputMessage,
  ChatbotRunInput,
  ChatbotRunResult,
  ChatbotStreamHandlers,
} from "./types";

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function requireOpenAiKey() {
  const value = cleanString(process.env.OPENAI_API_KEY);
  if (!value) {
    throw badRequest("OPENAI_API_KEY belum diatur di backend");
  }
  return value;
}

function resolveTextModel() {
  return cleanString(process.env.OPENAI_TEXT_MODEL) || "gpt-5.4-mini";
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error("Generasi WeebinAI dihentikan");
    error.name = "AbortError";
    throw error;
  }
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}$/);
  if (match) return match[0];
  throw badRequest("Respons WeebinAI bukan JSON valid");
}

function decodePartialJsonString(raw: string) {
  let decoded = "";
  let escaped = false;

  for (const char of raw) {
    if (escaped) {
      if (char === "n") decoded += "\n";
      else if (char === "r") decoded += "\r";
      else if (char === "t") decoded += "\t";
      else decoded += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') break;
    decoded += char;
  }

  return decoded;
}

function extractStreamingAnswer(content: string) {
  const match = content.match(/"answer"\s*:\s*"([\s\S]*)$/);
  if (!match) return "";
  return decodePartialJsonString(match[1] ?? "");
}

function safeAnswer(value: unknown) {
  const text = cleanString(value).replace(/\s+/g, " ");
  if (!text) return "";
  return text.length > 900 ? `${text.slice(0, 897).trim()}...` : text;
}

function isContextFollowUp(query: string) {
  const text = query.trim();
  if (!text || text.length > 120) return false;
  return /\b(itu|tadi|yang\s+(itu|tadi|mana)|coba|cobain|gas|lanjut|pilih|pilihin|rekomendasiin|boleh|mau|yaudah|ywdh)\b/i.test(
    text,
  );
}

function latestAssistantMessage(messages: ChatbotInputMessage[]) {
  return [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.content?.trim());
}

function extractTitlePhrases(text: string) {
  const ignore = new Set([
    "Aku",
    "Animers",
    "Kalau",
    "Weebin",
    "WeebinAI",
  ]);
  const phrases = new Set<string>();
  const matches = text.matchAll(
    /\b(?:[A-Z][A-Za-z0-9'’:-]*|[0-9]+)(?:\s+(?:[A-Z][A-Za-z0-9'’:-]*|[0-9]+)){1,7}\b/g,
  );

  for (const match of matches) {
    const phrase = match[0].replace(/\s+/g, " ").trim();
    const first = phrase.split(/\s+/)[0];
    if (!phrase || ignore.has(phrase) || ignore.has(first)) continue;
    phrases.add(phrase);
    if (phrases.size >= 6) break;
  }

  return Array.from(phrases);
}

function buildContextualRetrievalQuery(
  query: string,
  messages: ChatbotInputMessage[],
) {
  if (!isContextFollowUp(query)) return query;
  const assistant = latestAssistantMessage(messages);
  if (!assistant?.content) return query;
  const titlePhrases = extractTitlePhrases(assistant.content);
  if (titlePhrases.length) {
    return `anime ${titlePhrases.join("; ")}`;
  }
  return `rekomendasi ${assistant.content.slice(0, 320)} ${query}`;
}

async function streamOpenAiAnswer(
  input: {
    query: string;
    prompt: string;
    systemPrompt: string;
  },
  handlers: ChatbotStreamHandlers,
) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireOpenAiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: resolveTextModel(),
      response_format: { type: "json_object" },
      temperature: 0.2,
      stream: true,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.prompt },
      ],
    }),
    signal: handlers.signal,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw badRequest(
      payload?.error?.message ?? "Gagal menghubungi OpenAI untuk WeebinAI",
    );
  }

  if (!response.body) throw badRequest("Stream WeebinAI kosong");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let jsonBuffer = "";
  let lastAnswer = "";

  while (true) {
    throwIfAborted(handlers.signal);
    const { done, value } = await reader.read();
    if (done) break;
    lineBuffer += decoder.decode(value, { stream: true });
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const payloadText = line.slice(5).trim();
      if (!payloadText || payloadText === "[DONE]") continue;

      const payload = JSON.parse(payloadText) as {
        choices?: Array<{ delta?: { content?: string | null } }>;
      };
      const delta = payload.choices?.[0]?.delta?.content;
      if (!delta) continue;

      jsonBuffer += delta;
      const answer = extractStreamingAnswer(jsonBuffer);
      if (answer.length > lastAnswer.length) {
        const nextDelta = answer.slice(lastAnswer.length);
        lastAnswer = answer;
        await handlers.onDelta?.(nextDelta, answer);
      }
    }
  }

  const parsed = JSON.parse(extractJsonObject(jsonBuffer)) as {
    answer?: unknown;
  };
  return safeAnswer(parsed.answer);
}

export async function runWeebinAiChatbot(
  input: ChatbotRunInput,
  handlers: ChatbotStreamHandlers = {},
): Promise<ChatbotRunResult> {
  await handlers.onStatus?.("WeebinAI sedang berfikir...");
  const sanitized = sanitizeChatbotPrompt(input.content);
  const query = sanitized.text;
  const memory = buildChatbotMemory({ messages: input.messages });

  if (!query) {
    return {
      text: cleanWeebinAiOutput(
        "Mention aku dengan pertanyaan anime atau episode yang mau dicari di Weebin, Weebiners.",
      ),
      cards: [],
      usedOpenAi: false,
    };
  }

  if (isSmallTalk(query)) {
    await handlers.onCards?.([]);
    return {
      text: cleanWeebinAiOutput(buildSmallTalkReply(query)),
      cards: [],
      usedOpenAi: false,
    };
  }

  if (isLikelyOffTopic(query)) {
    await handlers.onCards?.([]);
    return {
      text: cleanWeebinAiOutput(buildNoDataReply(query)),
      cards: [],
      usedOpenAi: false,
    };
  }

  const retrievalQuery = buildContextualRetrievalQuery(
    query,
    memory.recentMessages,
  );

  await handlers.onStatus?.("WeebinAI sedang mencari info...");
  const retrieval = await retrieveWeebinContext(retrievalQuery);

  if (
    retrieval.animeCandidates.length === 0 &&
    retrieval.episodeCandidates.length === 0
  ) {
    await handlers.onCards?.([]);
    return {
      text: cleanWeebinAiOutput(buildNoDataReply(query)),
      cards: [],
      usedOpenAi: false,
    };
  }

  await handlers.onStatus?.("WeebinAI sedang mencocokan data...");
  const prompt = buildWeebinUserPrompt({
    query,
    retrieval,
    recentMessages: memory.recentMessages,
    hadInjectionHint: sanitized.hadInjectionHint,
  });

  try {
    const answer = cleanWeebinAiOutput(
      await streamOpenAiAnswer(
      {
        query,
        prompt,
        systemPrompt: buildWeebinSystemPrompt(),
      },
      handlers,
      ),
    );

    const outputCards =
      !retrieval.shouldShowCards || isNoDataAnswer(answer)
        ? []
        : retrieval.cards;
    await handlers.onCards?.(outputCards);

    return {
      text: cleanWeebinAiOutput(
        answer ||
        "Aku menemukan item di Weebin, tapi belum bisa menyusun jawabannya sekarang, Weebiners.",
      ),
      cards: outputCards,
      usedOpenAi: true,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    const fallbackCards = retrieval.shouldShowCards ? retrieval.cards : [];
    await handlers.onCards?.(fallbackCards);
    return {
      text: cleanWeebinAiOutput(
        fallbackCards.length
          ? "Aku menemukan item di Weebin, tapi AI lagi belum bisa jawab detail. Cek kartu yang aku kirim ya, Weebiners."
          : "Aku belum bisa jawab detail sekarang, Animers. Coba tanya anime atau episode yang mau kamu cari di Weebin.",
      ),
      cards: fallbackCards,
      usedOpenAi: false,
    };
  }
}
