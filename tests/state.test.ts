import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SyncState } from "../src/state.js";

describe("sync state", () => {
  it("stores mappings, snapshots, and deduplicated notifications", () => {
    const directory = mkdtempSync(join(tmpdir(), "linear-sync-state-"));
    const state = new SyncState(join(directory, "state.db"));
    const mapping = {
      personalIssueId: "personal-1",
      externalWorkspaceKey: "work",
      externalIssueId: "work-1",
      personalIssueUrl: "https://linear.app/personal/issue/PER-1",
      externalIssueUrl: "https://linear.app/work/issue/WORK-1",
      active: true,
      conflict: false,
      broken: false,
    };
    state.upsertMapping(mapping);
    expect(state.findMappingByExternal("work", "work-1")).toEqual(mapping);
    expect(state.lastRunAt()).toBeUndefined();
    state.markRunCompleted(1234);
    expect(state.lastRunAt()).toBe(1234);
    expect(() => state.upsertMapping({
      ...mapping,
      externalWorkspaceKey: "startup",
      externalIssueId: "startup-1",
      externalIssueUrl: "https://linear.app/startup/issue/STARTUP-1",
    })).toThrow();
    expect(state.shouldNotify("personal-1", "work", "conflict", "title")).toBe(true);
    expect(state.shouldNotify("personal-1", "work", "conflict", "title")).toBe(false);
    state.close();
  });
});
