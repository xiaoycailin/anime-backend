import type { ChatContextPayload } from "../../chat.types";

export type ChatbotStatus =
  | "WeebinAI sedang berfikir..."
  | "WeebinAI sedang mencari info..."
  | "WeebinAI sedang mencocokan data...";

export type ChatbotInputMessage = {
  role?: "user" | "assistant";
  content?: string;
};

export type ChatbotAnimeCandidate = {
  id: number;
  title: string;
  slug: string;
  thumbnail: string | null;
  synopsis: string | null;
  status: string | null;
  type: string | null;
  totalEpisodes: number | null;
  genres: string[];
  url: string;
};

export type ChatbotEpisodeCandidate = {
  id: number;
  title: string;
  slug: string;
  number: number;
  thumbnail: string | null;
  animeTitle: string;
  animeSlug: string;
  animeSynopsis: string | null;
  url: string;
};

export type ChatbotRetrievalContext = {
  query: string;
  animeCandidates: ChatbotAnimeCandidate[];
  episodeCandidates: ChatbotEpisodeCandidate[];
  cards: ChatContextPayload[];
  shouldShowCards: boolean;
};

export type ChatbotStreamHandlers = {
  signal?: AbortSignal;
  onStatus?: (status: ChatbotStatus) => void | Promise<void>;
  onDelta?: (delta: string, fullText: string) => void | Promise<void>;
  onCards?: (cards: ChatContextPayload[]) => void | Promise<void>;
};

export type ChatbotRunInput = {
  content?: unknown;
  mentionedBot?: unknown;
  currentContext?: unknown;
  messages?: unknown;
};

export type ChatbotRunResult = {
  text: string;
  cards: ChatContextPayload[];
  usedOpenAi: boolean;
};
