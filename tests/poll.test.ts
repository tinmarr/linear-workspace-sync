import { describe, expect, it } from "vitest";
import { isPollDue } from "../src/poll.js";

describe("poll scheduling", () => {
  it("does not retry a failed run before the poll interval elapses", () => {
    const attemptedAt = 1_000;

    expect(isPollDue(attemptedAt, attemptedAt + 299_999, 300, false, false)).toBe(false);
    expect(isPollDue(attemptedAt, attemptedAt + 300_000, 300, false, false)).toBe(true);
  });
});
