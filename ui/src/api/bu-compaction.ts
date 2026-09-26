// bu-fork: context compaction (doc/bu/context-compaction-plan.md).
import { api } from "./client";

export interface IssueCompaction {
  id: string;
  status: "queued" | "running" | "ready" | "failed" | "superseded";
  trigger: string;
  sourceMessageCount: number;
  sourceBytes: number;
  summaryBytes: number | null;
  summaryMarkdown: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type CompactionRequestResult =
  | { status: "started" | "already_running"; compactionId: string }
  | { status: "nothing_to_compact" }
  | { status: "unavailable"; reason: string };

export const buCompactionApi = {
  list: (issueId: string) => api.get<IssueCompaction[]>(`/issues/${issueId}/compactions`),
  request: (issueId: string) => api.post<CompactionRequestResult>(`/issues/${issueId}/compact`, {}),
};

export function describeCompactionRequest(result: CompactionRequestResult): string {
  switch (result.status) {
    case "started":
      return "Compacting: a separate run is summarizing the history. The next turn will use the summary.";
    case "already_running":
      return "A compaction is already running for this conversation.";
    case "nothing_to_compact":
      return "Nothing to compact yet: the recent messages are always kept as they are.";
    case "unavailable":
      return `Compaction is unavailable: ${result.reason}.`;
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "0 KB";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
