import type { AnimeDetail } from "../services/scraper-service/types";
import type { SokujaAnimeCard } from "../services/scraper-service/scrapeSokujaAnimeList.service";

export type SokujaScanStatus = "running" | "done" | "error";

export type SokujaScanLog = {
  time: string;
  type: "info" | "success" | "error";
  message: string;
};

export type SokujaScanItem = {
  card: SokujaAnimeCard;
  detail?: AnimeDetail;
  error?: string;
};

export type SokujaScanState = {
  id: string;
  status: SokujaScanStatus;
  fromPage: number;
  toPage: number;
  episodeMode: "full" | "recent";
  episodeLimit: number;
  total: number;
  processed: number;
  items: SokujaScanItem[];
  logs: SokujaScanLog[];
  startedAt: string;
  finishedAt?: string;
};

const scans = new Map<string, SokujaScanState>();
const listeners = new Map<string, Set<(state: SokujaScanState) => void>>();

function now() {
  return new Date().toISOString();
}

function emit(id: string) {
  const state = scans.get(id);
  const entries = listeners.get(id);
  if (!state || !entries) return;
  for (const listener of entries) listener(state);
}

export function initSokujaScan(input: {
  id: string;
  fromPage: number;
  toPage: number;
  episodeMode: "full" | "recent";
  episodeLimit: number;
}) {
  const state: SokujaScanState = {
    ...input,
    status: "running",
    total: 0,
    processed: 0,
    items: [],
    logs: [],
    startedAt: now(),
  };
  scans.set(input.id, state);
  emit(input.id);
  return state;
}

export function setSokujaScanTotal(id: string, total: number) {
  const state = scans.get(id);
  if (!state) return;
  state.total = total;
  emit(id);
}

export function addSokujaScanLog(id: string, type: SokujaScanLog["type"], message: string) {
  const state = scans.get(id);
  if (!state) return;
  state.logs.push({ time: now(), type, message });
  emit(id);
}

export function addSokujaScanItem(id: string, item: SokujaScanItem) {
  const state = scans.get(id);
  if (!state) return;
  state.items.push(item);
  state.processed += 1;
  emit(id);
}

export function finishSokujaScan(id: string, status: SokujaScanStatus) {
  const state = scans.get(id);
  if (!state) return;
  state.status = status;
  state.finishedAt = now();
  emit(id);
}

export function getSokujaScan(id: string) {
  return scans.get(id);
}

export function deleteSokujaScan(id: string) {
  listeners.delete(id);
  return scans.delete(id);
}

export function subscribeSokujaScan(id: string, listener: (state: SokujaScanState) => void) {
  const entries = listeners.get(id) ?? new Set<(state: SokujaScanState) => void>();
  entries.add(listener);
  listeners.set(id, entries);

  const current = scans.get(id);
  if (current) listener(current);

  return () => {
    const currentEntries = listeners.get(id);
    if (!currentEntries) return;
    currentEntries.delete(listener);
    if (currentEntries.size === 0) listeners.delete(id);
  };
}
