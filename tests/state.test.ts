import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SyncState } from "../src/state.js";

describe("sync state", () => {
  it("upgrades legacy project membership state with milestone columns", () => {
    const directory = mkdtempSync(join(tmpdir(), "linear-sync-legacy-state-"));
    const databasePath = join(directory, "state.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE project_membership_snapshots (
        external_workspace_key TEXT NOT NULL,
        personal_issue_id TEXT NOT NULL,
        personal_project_id TEXT,
        external_project_id TEXT,
        personal_updated_at TEXT,
        external_updated_at TEXT,
        personal_managed INTEGER NOT NULL,
        external_managed INTEGER NOT NULL,
        PRIMARY KEY (external_workspace_key, personal_issue_id)
      )
    `);
    legacy.close();

    const membership = {
      externalWorkspaceKey: "work",
      personalIssueId: "personal-issue",
      personalProjectId: "personal-project",
      externalProjectId: "work-project",
      personalMilestoneId: "personal-milestone",
      externalMilestoneId: "work-milestone",
      personalUpdatedAt: "2026-01-01T00:00:00.000Z",
      externalUpdatedAt: "2026-01-01T00:00:00.000Z",
      personalManaged: true,
      externalManaged: true,
    };
    const state = new SyncState(databasePath);
    state.putProjectMembershipState(membership);
    expect(state.getProjectMembershipState("work", "personal-issue")).toEqual(membership);
    state.close();

    const migrated = new Database(databasePath);
    const columns = migrated.prepare("PRAGMA table_info(project_membership_snapshots)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("personal_milestone_id");
    expect(columns.map((column) => column.name)).toContain("external_milestone_id");
    migrated.close();

    const rerun = new SyncState(databasePath);
    expect(rerun.getProjectMembershipState("work", "personal-issue")).toEqual(membership);
    rerun.close();
  });

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

  it("stores project mappings, snapshots, and project membership state", () => {
    const directory = mkdtempSync(join(tmpdir(), "linear-sync-project-state-"));
    const state = new SyncState(join(directory, "state.db"));
    const mapping = {
      personalProjectId: "personal-project",
      externalWorkspaceKey: "work",
      externalProjectId: "work-project",
      personalProjectUrl: "https://linear.app/personal/project/personal-project",
      externalProjectUrl: "https://linear.app/work/project/work-project",
      active: true,
      conflict: false,
      broken: false,
    };
    state.upsertProjectMapping(mapping);
    expect(state.getProjectMapping("personal-project", "work")).toEqual(mapping);
    expect(state.findProjectMappingByExternal("work", "work-project")).toEqual(mapping);

    const snapshot = {
      id: "personal-project",
      url: mapping.personalProjectUrl,
      workspaceKey: "personal",
      name: "Shared project",
      description: null,
      statusName: "Backlog",
      statusType: "backlog",
      priority: 0,
      startDate: null,
      targetDate: null,
      leadAssigned: true,
      memberAssigned: false,
      archived: false,
      labelNames: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    state.putProjectSnapshot(snapshot, "work");
    expect(state.getProjectSnapshot("personal-project", "work")).toEqual(snapshot);

    const membership = {
      externalWorkspaceKey: "work",
      personalIssueId: "personal-issue",
      personalProjectId: "personal-project",
      externalProjectId: "work-project",
      personalMilestoneId: "personal-milestone",
      externalMilestoneId: "work-milestone",
      personalUpdatedAt: "2026-01-01T00:00:00.000Z",
      externalUpdatedAt: "2026-01-01T00:00:00.000Z",
      personalManaged: true,
      externalManaged: true,
    };
    state.putProjectMembershipState(membership);
    expect(state.getProjectMembershipState("work", "personal-issue")).toEqual(membership);
    expect(state.listProjectMembershipStates("work")).toEqual([membership]);

    const milestoneMapping = {
      personalProjectId: "personal-project",
      externalWorkspaceKey: "work",
      externalProjectId: "work-project",
      personalMilestoneId: "personal-milestone",
      externalMilestoneId: "work-milestone",
      active: true,
      conflict: false,
      broken: false,
    };
    state.upsertMilestoneMapping(milestoneMapping);
    expect(state.getMilestoneMapping("personal-milestone", "work")).toEqual(milestoneMapping);
    expect(state.findMilestoneMappingByExternal("work", "work-milestone")).toEqual(milestoneMapping);

    const milestoneSnapshot = {
      personal: {
        id: "personal-milestone",
        projectId: "personal-project",
        workspaceKey: "personal",
        name: "Launch",
        description: null,
        targetDate: "2026-03-01",
        sortOrder: 1,
        archived: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      external: {
        id: "work-milestone",
        projectId: "work-project",
        workspaceKey: "work",
        name: "Launch",
        description: null,
        targetDate: "2026-03-01",
        sortOrder: 1,
        archived: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    state.putMilestoneSnapshot("personal-milestone", "work", milestoneSnapshot);
    expect(state.getMilestoneSnapshot("personal-milestone", "work")).toEqual(milestoneSnapshot);
    state.close();
  });
});
