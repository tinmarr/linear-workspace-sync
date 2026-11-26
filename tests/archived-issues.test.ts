import assert from "node:assert/strict";
import { test } from "node:test";
import { ReconciliationEngine } from "../src/reconcile.js";
import { SyncState } from "../src/state.js";
import { config, FakeWorkspace, issue } from "./helpers.js";

for (const assigned of [false, true]) {
  test(`an archived personal issue stays archived when its counterpart is ${assigned ? "assigned" : "unassigned"}`, async () => {
    const state = new SyncState(":memory:");
    try {
      const personal = new FakeWorkspace("personal", "me@personal.example");
      const external = new FakeWorkspace("work", "me@work.example");
      const personalIssue = issue("personal", {
        id: "p", identifier: "ME-1", url: "https://example.test/p",
        title: "Completed work", statusName: "Done", archived: true,
      });
      const externalIssue = issue("work", {
        id: "e", identifier: "WORK-1", url: "https://example.test/e",
        title: "Completed work", statusName: "Done",
        assigneeEmail: assigned ? external.viewerEmail : null,
      });
      personal.issues.set(personalIssue.id, personalIssue);
      external.issues.set(externalIssue.id, externalIssue);
      state.upsertMapping({
        personalIssueId: personalIssue.id,
        externalWorkspaceKey: "work",
        externalIssueId: externalIssue.id,
        personalIssueUrl: personalIssue.url,
        externalIssueUrl: externalIssue.url,
        active: true,
        conflict: false,
        broken: false,
      });
      const mappings = state.listMappings();
      const expectedPersonal = structuredClone(personalIssue);
      const expectedExternal = structuredClone(externalIssue);
      const engine = new ReconciliationEngine(config(":memory:"), personal, new Map([["work", external]]), state);

      await engine.run(false);

      assert.deepEqual([...personal.issues.values()], [expectedPersonal]);
      assert.deepEqual([...external.issues.values()], [expectedExternal]);
      assert.deepEqual(state.listMappings(), mappings);
      assert.deepEqual(personal.comments, []);
    } finally {
      state.close();
    }
  });
}
