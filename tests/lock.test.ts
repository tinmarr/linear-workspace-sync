import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryAcquireRunLock } from "../src/lock.js";

describe("run lock", () => {
  it("allows only one holder", () => {
    const directory = mkdtempSync(join(tmpdir(), "linear-sync-lock-"));
    const path = join(directory, "run.lock");
    const first = tryAcquireRunLock(path);
    expect(first).toBeDefined();
    expect(tryAcquireRunLock(path)).toBeUndefined();
    first?.release();
    expect(tryAcquireRunLock(path)).toBeDefined();
  });
});
