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

  it("stores relationship and parent synchronization state", () => {
    const directory = mkdtempSync(join(tmpdir(), "linear-sync-relationship-state-"));
    const state = new SyncState(join(directory, "state.db"));
    const relationship = {
      externalWorkspaceKey: "work",
      personalIssueId: "personal-1",
      personalRelatedIssueId: "personal-2",
      relationType: "blocks",
      personalPresent: true,
      externalPresent: false,
      personalUpdatedAt: "2026-01-01T00:00:00.000Z",
      externalUpdatedAt: null,
      personalManaged: false,
      externalManaged: true,
    };
    state.putRelationshipState(relationship);
    expect(state.getRelationshipState("work", "personal-1", "personal-2", "blocks")).toEqual(relationship);
    expect(state.listRelationshipStates("work")).toEqual([relationship]);

    const parent = {
      externalWorkspaceKey: "work",
      personalIssueId: "personal-2",
      personalParentIssueId: "personal-1",
      externalParentIssueId: "work-1",
      personalUpdatedAt: "2026-01-01T00:00:00.000Z",
      externalUpdatedAt: "2026-01-01T00:00:01.000Z",
      personalManaged: false,
      externalManaged: true,
    };
    state.putParentState(parent);
    expect(state.getParentState("work", "personal-2")).toEqual(parent);
    state.close();
  });
});
