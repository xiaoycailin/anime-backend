export interface ProgressLog {
  time: string;
  type: "info" | "success" | "error";
  message: string;
}

export interface ProgressAnimeUpdate {
  animeTitle: string;
  animeSlug: string;
  isNewAnime: boolean;
  totalEpisodesDetected: number;
  scannedEpisodes: number;
  newEpisodesAdded: number;
  newEpisodeNumbers: number[];
}

export interface ProgressSummary {
  recentEpisodeLimit: number;
  newAnimeCount: number;
  animeWithNewEpisodesCount: number;
  newEpisodesTotal: number;
  animeUpdates: ProgressAnimeUpdate[];
}

export interface ProgressState {
  url: string;
  status: "running" | "done" | "error";
  total: number;
  processed: number;
  logs: ProgressLog[];
  summary: ProgressSummary;
  startedAt: string;
  finishedAt?: string;
}

// key = url yang di-scrape
const store = new Map<string, ProgressState>();
const listeners = new Map<string, Set<(state: ProgressState) => void>>();

function emitUpdate(url: string): void {
  const state = store.get(url);
  if (!state) return;
  const entries = listeners.get(url);
  if (!entries || entries.size === 0) return;

  for (const listener of entries) {
    listener(state);
  }
}

export function initProgress(
  url: string,
  total: number,
  recentEpisodeLimit = 2,
): void {
  store.set(url, {
    url,
    status: "running",
    total,
    processed: 0,
    logs: [],
    summary: {
      recentEpisodeLimit,
      newAnimeCount: 0,
      animeWithNewEpisodesCount: 0,
      newEpisodesTotal: 0,
      animeUpdates: [],
    },
    startedAt: new Date().toISOString(),
  });
  emitUpdate(url);
}

export function addLog(
  url: string,
  type: ProgressLog["type"],
  message: string,
): void {
  const state = store.get(url);
  if (!state) return;
  state.logs.push({ time: new Date().toISOString(), type, message });
  emitUpdate(url);
}

export function incrementProcessed(url: string): void {
  const state = store.get(url);
  if (!state) return;
  state.processed += 1;
  emitUpdate(url);
}

export function upsertAnimeUpdate(
  url: string,
  update: ProgressAnimeUpdate,
): void {
  const state = store.get(url);
  if (!state) return;

  const existing = state.summary.animeUpdates.findIndex(
    (item) => item.animeSlug === update.animeSlug,
  );

  if (existing >= 0) {
    state.summary.animeUpdates[existing] = update;
  } else {
    state.summary.animeUpdates.push(update);
  }

  state.summary.newAnimeCount = state.summary.animeUpdates.filter(
    (item) => item.isNewAnime,
  ).length;
  state.summary.animeWithNewEpisodesCount = state.summary.animeUpdates.filter(
    (item) => item.newEpisodesAdded > 0,
  ).length;
  state.summary.newEpisodesTotal = state.summary.animeUpdates.reduce(
    (total, item) => total + item.newEpisodesAdded,
    0,
  );

  emitUpdate(url);
}

export function finishProgress(url: string, status: "done" | "error"): void {
  const state = store.get(url);
  if (!state) return;
  state.status = status;
  state.finishedAt = new Date().toISOString();
  emitUpdate(url);
}

export function getProgress(url: string): ProgressState | undefined {
  return store.get(url);
}

export function deleteProgress(url: string): boolean {
  listeners.delete(url);
  return store.delete(url);
}

export function subscribeProgress(
  url: string,
  listener: (state: ProgressState) => void,
): () => void {
  const entries = listeners.get(url) ?? new Set<(state: ProgressState) => void>();
  entries.add(listener);
  listeners.set(url, entries);

  const current = store.get(url);
  if (current) {
    listener(current);
  }

  return () => {
    const currentEntries = listeners.get(url);
    if (!currentEntries) return;
    currentEntries.delete(listener);
    if (currentEntries.size === 0) {
      listeners.delete(url);
    }
  };
}
