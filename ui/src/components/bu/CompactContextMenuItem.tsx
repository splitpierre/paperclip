// bu-fork: context compaction — "Compact context" in the task/chat actions menu.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Minimize2 } from "lucide-react";
import { useState } from "react";
import { buCompactionApi, describeCompactionRequest, formatBytes } from "../../api/bu-compaction";

function statusLine(latest: Awaited<ReturnType<typeof buCompactionApi.list>>[number] | undefined): string | null {
  if (!latest) return null;
  if (latest.status === "queued" || latest.status === "running") return `Compacting ${latest.sourceMessageCount} messages…`;
  if (latest.status === "failed") return `Last compaction failed: ${latest.error ?? "unknown error"}`;
  if (latest.status === "ready" || latest.status === "superseded") {
    const when = latest.completedAt ? new Date(latest.completedAt).toLocaleString() : "";
    return `Last: ${latest.sourceMessageCount} messages (${formatBytes(latest.sourceBytes)}) → ${formatBytes(latest.summaryBytes)} summary · ${when}`;
  }
  return null;
}

export function CompactContextMenuItem({ issueId }: { issueId: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const history = useQuery({
    queryKey: ["bu-compactions", issueId],
    queryFn: () => buCompactionApi.list(issueId),
    refetchInterval: (query) =>
      query.state.data?.some((c) => c.status === "queued" || c.status === "running") ? 5000 : false,
  });
  const compact = useMutation({
    mutationFn: () => buCompactionApi.request(issueId),
    onSuccess: (result) => {
      setNotice(describeCompactionRequest(result));
      void queryClient.invalidateQueries({ queryKey: ["bu-compactions", issueId] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });
  const latest = history.data?.[0];
  const running = latest?.status === "queued" || latest?.status === "running";
  const line = notice ?? statusLine(latest);
  return (
    <div className="border-t border-border/60 mt-1 pt-1">
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50 disabled:opacity-50"
        disabled={running || compact.isPending}
        title="Summarize the older history in a separate run, so later turns replay a short summary instead of every message."
        onClick={() => compact.mutate()}
      >
        <Minimize2 className="h-3 w-3" />
        {running ? "Compacting…" : "Compact context"}
      </button>
      {line ? <p className="px-2 pb-1 text-[11px] leading-snug text-muted-foreground">{line}</p> : null}
    </div>
  );
}
