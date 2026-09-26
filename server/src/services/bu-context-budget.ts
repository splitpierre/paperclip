// bu-fork: context compaction (doc/bu/context-compaction-plan.md).
// Pure helpers that shape an execution continuation so a task's replayed
// history stays bounded: apply the latest compaction summary, then enforce a
// hard byte budget. Kept separate from execution-continuation.ts to keep the
// upstream diff small.
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

/** Above this, an automatic compaction is requested for the issue. */
export const CONTEXT_SOFT_LIMIT_BYTES = 48 * 1024;
/** The continuation handed to a run never exceeds this. */
export const CONTEXT_HARD_LIMIT_BYTES = 96 * 1024;

export interface ReadyCompaction {
  id: string;
  summaryMarkdown: string;
  throughCommentId: string;
  throughCreatedAt: Date;
}

type Message = ExecutionContinuationEnvelope["messages"][number];

export function envelopeBytes(envelope: ExecutionContinuationEnvelope): number {
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

function isAfter(message: Message, compaction: ReadyCompaction): boolean {
  const at = Date.parse(message.createdAt);
  const through = compaction.throughCreatedAt.getTime();
  return at > through || (at === through && message.id > compaction.throughCommentId);
}

/**
 * Replaces the messages a compaction covers with its summary. Messages that
 * triggered this wake (`originCommentIds`) are always kept verbatim.
 */
export function applyCompaction(
  envelope: ExecutionContinuationEnvelope,
  compaction: ReadyCompaction | null,
): ExecutionContinuationEnvelope {
  if (!compaction) return envelope;
  const origins = new Set(envelope.originCommentIds);
  const kept = envelope.messages.filter((m) => isAfter(m, compaction) || origins.has(m.id));
  const summarized = envelope.messages.length - kept.length;
  return {
    ...envelope,
    messages: kept,
    summary: {
      compactionId: compaction.id,
      markdown: compaction.summaryMarkdown,
      throughCommentId: compaction.throughCommentId,
      summarizedMessageCount: summarized,
    },
    coverage: {
      ...envelope.coverage,
      kind: "summarized_task_history",
      summaryThroughCommentId: compaction.throughCommentId,
    },
  };
}

/**
 * Safety net: drops the oldest non-origin messages until the envelope fits.
 * A run can never again carry an unbounded history, compaction or not.
 */
export function enforceBudget(
  envelope: ExecutionContinuationEnvelope,
  limitBytes = CONTEXT_HARD_LIMIT_BYTES,
): ExecutionContinuationEnvelope {
  if (envelopeBytes(envelope) <= limitBytes) return envelope;
  const origins = new Set(envelope.originCommentIds);
  const messages = [...envelope.messages];
  let omitted = 0;
  let current = envelope;
  for (let i = 0; i < messages.length && envelopeBytes(current) > limitBytes; ) {
    if (origins.has(messages[i].id)) {
      i += 1;
      continue;
    }
    messages.splice(i, 1);
    omitted += 1;
    current = {
      ...envelope,
      messages: [...messages],
      coverage: {
        ...envelope.coverage,
        kind: "truncated_task_history",
        omittedMessageCount: (envelope.coverage.omittedMessageCount ?? 0) + omitted,
      },
    };
  }
  // Still too big (huge interaction results or origin messages): trim those payloads.
  if (envelopeBytes(current) > limitBytes) {
    current = {
      ...current,
      interactionOutcomes: current.interactionOutcomes.map((o) => ({ ...o, result: "[omitted: context budget]" })),
      completedWork: current.completedWork ? current.completedWork.slice(0, 4000) : null,
    };
  }
  return current;
}
