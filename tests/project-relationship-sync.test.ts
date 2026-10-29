import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncProjectRelationships } from "../src/project-relationship-sync.js";
import { SyncState } from "../src/state.js";
import { FakeWorkspace, project } from "./helpers.js";

function setup() {
  const state = new SyncState(join(mkdtempSync(join(tmpdir(), "project-relations-")), "state.db"));
  const personal = new FakeWorkspace("personal", "me@example.com");
  const work = new FakeWorkspace("work", "me@example.com");
  for (const suffix of ["a", "b"]) {
    const personalId = `p-${suffix}`;
    const externalId = `w-${suffix}`;
    const personalUrl = `https://linear.app/personal/project/${personalId}`;
    const externalUrl = `https://linear.app/work/project/${externalId}`;
    personal.projects.set(personalId, project("personal", { id: personalId, url: personalUrl, name: suffix, statusName: "Backlog" }));
    work.projects.set(externalId, project("work", { id: externalId, url: externalUrl, name: suffix, statusName: "Backlog" }));
    state.upsertProjectMapping({ personalProjectId: personalId, externalWorkspaceKey: "work", externalProjectId: externalId,
      personalProjectUrl: personalUrl, externalProjectUrl: externalUrl, active: true, broken: false, conflict: false });
  }
  const run = async () => syncProjectRelationships(personal, work, state, "work", await personal.listProjectRelations());
  return { personal, work, state, run };
}

describe("project relationships", () => {
  it("copies dependencies between mapped projects and propagates managed deletion", async () => {
    const { personal, work, state, run } = setup();
    const relation = await work.createProjectRelation({ projectId: "w-a", relatedProjectId: "w-b", type: "blocks", anchorType: "project", relatedAnchorType: "project" });
    await work.createProjectRelation({ projectId: "w-a", relatedProjectId: "unmapped", type: "blocks", anchorType: "project", relatedAnchorType: "project" });
    await run();
    expect([...personal.projectRelations.values()]).toEqual([expect.objectContaining({ projectId: "p-a", relatedProjectId: "p-b", type: "blocks" })]);
    await run();
    expect(personal.projectRelations.size).toBe(1);
    await work.deleteProjectRelation(relation.id);
    await run();
    expect(personal.projectRelations.size).toBe(0);
    state.close();
  });

  it("copies milestone anchored relationships only when milestones are mapped", async () => {
    const { personal, work, state, run } = setup();
    await personal.createProjectRelation({ projectId: "p-a", relatedProjectId: "p-b", type: "blocks", anchorType: "milestone", relatedAnchorType: "project", projectMilestoneId: "pm" });
    await run();
    expect(work.projectRelations.size).toBe(0);
    state.upsertMilestoneMapping({ personalProjectId: "p-a", externalProjectId: "w-a", externalWorkspaceKey: "work", personalMilestoneId: "pm", externalMilestoneId: "wm", active: true, conflict: false, broken: false });
    await run();
    expect([...work.projectRelations.values()]).toEqual([expect.objectContaining({ projectId: "w-a", relatedProjectId: "w-b", projectMilestoneId: "wm", anchorType: "milestone" })]);
    state.close();
  });
});
