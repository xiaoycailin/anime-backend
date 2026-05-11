import type {
  ReelshortImportLogType,
  ReelshortImportResult,
} from "../services/scraper-service/importReelshort.service";

export type ReelshortImportStatus = "running" | "done" | "error";

export type ReelshortImportLog = {
  time: string;
  type: ReelshortImportLogType;
  message: string;
};

export type ReelshortImportItem = {
  sourceUrl: string;
  title?: string;
  slug?: string;
  episodeCount?: number;
  serverCount?: number;
  error?: string;
};

export type ReelshortImportState = {
  id: string;
  status: ReelshortImportStatus;
  total: number;
  processed: number;
  episodeTotal: number;
  episodeProcessed: number;
  urls: string[];
  items: ReelshortImportItem[];
  logs: ReelshortImportLog[];
  startedAt: string;
  finishedAt?: string;
};

const imports = new Map<string, ReelshortImportState>();
const listeners = new Map<string, Set<(state: ReelshortImportState) => void>>();

function now() {
  return new Date().toISOString();
}

function emit(id: string) {
  const state = imports.get(id);
  if (!state) return;
  for (const listener of listeners.get(id) ?? []) listener(state);
}

export function initReelshortImport(id: string, urls: string[]) {
  const state: ReelshortImportState = {
    id,
    status: "running",
    total: urls.length,
    processed: 0,
    episodeTotal: 0,
    episodeProcessed: 0,
    urls,
    items: [],
    logs: [],
    startedAt: now(),
  };
  imports.set(id, state);
  emit(id);
  return state;
}

export function addReelshortImportLog(
  id: string,
  type: ReelshortImportLogType,
  message: string,
) {
  const state = imports.get(id);
  if (!state) return;
  state.logs.push({ time: now(), type, message });
  emit(id);
}

export function addReelshortEpisodeProgress(id: string, total?: number) {
  const state = imports.get(id);
  if (!state) return;
  if (typeof total === "number") state.episodeTotal += total;
  else state.episodeProcessed += 1;
  emit(id);
}

export function addReelshortImportItem(
  id: string,
  sourceUrl: string,
  result: ReelshortImportResult | Error,
) {
  const state = imports.get(id);
  if (!state) return;
  state.processed += 1;
  state.items.push(
    result instanceof Error
      ? { sourceUrl, error: result.message }
      : {
          sourceUrl,
          title: result.title,
          slug: result.slug,
          episodeCount: result.episodeCount,
          serverCount: result.serverCount,
        },
  );
  emit(id);
}

export function finishReelshortImport(id: string, status: ReelshortImportStatus) {
  const state = imports.get(id);
  if (!state) return;
  state.status = status;
  state.finishedAt = now();
  emit(id);
}

export function getReelshortImport(id: string) {
  return imports.get(id) ?? null;
}

export function deleteReelshortImport(id: string) {
  listeners.delete(id);
  return imports.delete(id);
}

export function subscribeReelshortImport(
  id: string,
  listener: (state: ReelshortImportState) => void,
) {
  const entries = listeners.get(id) ?? new Set<(state: ReelshortImportState) => void>();
  entries.add(listener);
  listeners.set(id, entries);
  return () => {
    entries.delete(listener);
    if (entries.size === 0) listeners.delete(id);
  };
}
