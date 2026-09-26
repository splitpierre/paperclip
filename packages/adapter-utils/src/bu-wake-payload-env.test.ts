import { describe, expect, it } from "vitest";
import { boundWakePayloadForEnv, WAKE_PAYLOAD_ENV_MAX_BYTES } from "./server-utils.js";

// bu-fork: E2BIG guard for PAPERCLIP_WAKE_PAYLOAD_JSON.
describe("boundWakePayloadForEnv", () => {
  const history = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, body: "x".repeat(3000) }));
  const big = JSON.stringify({
    reason: "issue_commented",
    issue: { id: "i1", identifier: "BUD-51", title: "WhatsApp", description: "d".repeat(2000) },
    commentIds: ["c59"],
    comments: [{ id: "c59", body: "latest" }],
    executionContinuation: { version: 1, messages: history },
    fallbackFetchNeeded: false,
  });

  it("passes small payloads through untouched", () => {
    const small = JSON.stringify({ reason: "x", issue: { id: "i1" } });
    expect(boundWakePayloadForEnv(small)).toBe(small);
    expect(boundWakePayloadForEnv(null)).toBeNull();
  });

  it("drops the replayed history first and flags a fetch", () => {
    expect(Buffer.byteLength(big)).toBeGreaterThan(128 * 1024);
    const out = JSON.parse(boundWakePayloadForEnv(big)!);
    expect(out.executionContinuation).toBeNull();
    expect(out.comments).toEqual([{ id: "c59", body: "latest" }]);
    expect(out.issue.identifier).toBe("BUD-51");
    expect(out.fallbackFetchNeeded).toBe(true);
    expect(out.envTruncated).toBe(true);
  });

  it("always fits the cap, even when the new comments alone are too big", () => {
    const huge = JSON.stringify({
      reason: "issue_commented",
      issue: { id: "i1", identifier: "BUD-51", description: "d".repeat(50_000) },
      commentIds: ["c1"],
      comments: [{ id: "c1", body: "y".repeat(200_000) }],
    });
    const out = boundWakePayloadForEnv(huge)!;
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(WAKE_PAYLOAD_ENV_MAX_BYTES);
    const parsed = JSON.parse(out);
    expect(parsed.issue.identifier).toBe("BUD-51");
    expect(parsed.fallbackFetchNeeded).toBe(true);
  });
});
