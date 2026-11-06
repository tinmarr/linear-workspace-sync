import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ReconciliationEngine } from "../src/reconcile.js";
import { SyncState } from "../src/state.js";
import { config, FakeWorkspace, project } from "./helpers.js";

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "linear-sync-"));
  const appConfig = config(join(directory, "state.db"));
  const personal = new FakeWorkspace("personal", "me@example.com");
  const work = new FakeWorkspace("work", "me@example.com");
  const state = new SyncState(appConfig.databasePath);
  const engine = new ReconciliationEngine(appConfig, personal, new Map([["work", work]]), state);
  return { appConfig, personal, work, state, engine };
}

for (const variant of ["same-url", "alias", "alias-first", "different-project"]) {
  test(`handles multiple project links: ${variant}`, async () => {
    const { personal, work, state, engine } = setup();
    const target = project("work", {
      id: "target", url: "https://linear.app/work/project/target", name: "Shared project", statusName: "Backlog",
    });
    work.projects.set("target", target);
    work.projects.set("alias", { ...target });
    work.projects.set("other", { ...target, id: "other", url: "https://linear.app/work/project/other" });
    const secondId = variant === "same-url" ? "target" : variant === "alias" || variant === "alias-first" ? "alias" : "other";
    personal.projects.set("personal-project", project("personal", {
      id: "personal-project", url: "https://linear.app/personal/project/personal-project", name: "Shared project", statusName: "Backlog",
      externalLinks: [
        { id: "keep-link", workspaceKey: "work", projectId: "target", projectUrl: target.url },
        { id: "duplicate-link", workspaceKey: "work", projectId: secondId, projectUrl: `https://linear.app/work/project/${secondId}` },
      ],
    }));
    if (variant === "alias-first") personal.projects.get("personal-project")!.externalLinks.reverse();
    try {
      const result = await engine.run(true);
      assert.equal(result.broken, variant === "different-project" ? 1 : 0);
      assert.equal(personal.projects.get("personal-project")?.externalLinks.length, variant === "different-project" ? 2 : 1);
      assert.equal(state.getProjectMapping("personal-project", "work")?.broken, variant === "different-project" ? undefined : false);
      assert.equal(personal.projects.get("personal-project")?.labelNames.includes("sync:broken"), variant === "different-project");
    } finally { state.close(); }
  });
}
