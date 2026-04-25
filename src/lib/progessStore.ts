export interface ProgressLog {
  time: string;
  type: "info" | "success" | "error";
  message: string;
}

export interface ProgressState {
  url: string;
  status: "running" | "done" | "error";
  total: number;
  processed: number;
  logs: ProgressLog[];
  startedAt: string;
  finishedAt?: string;
}

// key = url yang di-scrape
const store = new Map<string, ProgressState>();

export function initProgress(url: string, total: number): void {
  store.set(url, {
    url,
    status: "running",
    total,
    processed: 0,
    logs: [],
    startedAt: new Date().toISOString(),
  });
}

export function addLog(
  url: string,
  type: ProgressLog["type"],
  message: string,
): void {
  const state = store.get(url);
  if (!state) return;
  state.logs.push({ time: new Date().toISOString(), type, message });
}

export function incrementProcessed(url: string): void {
  const state = store.get(url);
  if (!state) return;
  state.processed += 1;
}

export function finishProgress(url: string, status: "done" | "error"): void {
  const state = store.get(url);
  if (!state) return;
  state.status = status;
  state.finishedAt = new Date().toISOString();
}

export function getProgress(url: string): ProgressState | undefined {
  return store.get(url);
}

export function deleteProgress(url: string): boolean {
  return store.delete(url);
}
