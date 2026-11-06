import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectSynchronizer } from "../src/project-sync.js";
import { SyncState } from "../src/state.js";
import { config, FakeWorkspace, project } from "./helpers.js";

async function fixture() {
  const appConfig = config(":memory:");
  const state = new SyncState(":memory:");
  const personal = new FakeWorkspace("personal", "me@example.com");
  const work = new FakeWorkspace("work", "me@example.com");
  const remote = project("work", { id: "e", url: "https://linear.app/work/project/e", name: "Project", statusName: "Backlog" });
  const local = project("personal", { id: "p", url: "https://linear.app/personal/project/p", name: "Project", statusName: "Backlog",
    externalLinks: [{ workspaceKey: "work", projectId: "e", projectUrl: remote.url }] });
  local.content = remote.content = "baseline";
  personal.projects.set(local.id, local);
  work.projects.set(remote.id, remote);
  const run = () => new ProjectSynchronizer(appConfig, personal, new Map([["work", work]]), state).syncPersonalProjects();
  await run();
  local.content = "personal draft";
  remote.content = "remote draft";
  await run();
  assert.equal(state.getProjectMapping("p", "work")?.conflict, true);
  return { state, personal, work, local, remote, run };
}

test("removing a project conflict label overwrites the remote with personal values", async () => {
  const f = await fixture();
  try {
    f.local.labelNames = f.local.labelNames.filter((label) => label !== "sync:conflict");
    await f.run();
    assert.equal(f.remote.content, "personal draft");
    assert.equal(f.state.getProjectMapping("p", "work")?.conflict, false);
    assert.equal(f.local.labelNames.includes("sync:conflict"), false);
    await f.run();
    assert.equal(f.remote.content, "personal draft");
    assert.equal(f.local.labelNames.includes("sync:conflict"), false);
  } finally { f.state.close(); }
});

test("keeping the project conflict label preserves both versions", async () => {
  const f = await fixture();
  try {
    await f.run();
    assert.equal(f.remote.content, "remote draft");
    assert.equal(f.local.content, "personal draft");
    assert.equal(f.state.getProjectMapping("p", "work")?.conflict, true);
    assert.equal(f.personal.projectComments.length, 1);
  } finally { f.state.close(); }
});

test("removing the project conflict label selects personal resources too", async () => {
  const f = await fixture();
  try {
    f.local.resources = [{ id: "local-resource", url: "https://example.com/local", title: "Personal link" }];
    f.remote.resources = [{ id: "remote-resource", url: "https://example.com/remote", title: "Remote link" }];
    f.local.labelNames = f.local.labelNames.filter((label) => label !== "sync:conflict");
    await f.run();
    assert.deepEqual(f.remote.resources.map(({ url, title }) => ({ url, title })),
      [{ url: "https://example.com/local", title: "Personal link" }]);
    assert.equal(f.state.getProjectMapping("p", "work")?.conflict, false);
  } finally { f.state.close(); }
});

test("a failed project overwrite preserves conflict state for retry", async () => {
  const f = await fixture();
  try {
    f.local.labelNames = f.local.labelNames.filter((label) => label !== "sync:conflict");
    const update = f.work.updateProject.bind(f.work);
    f.work.updateProject = async () => { throw new Error("remote unavailable"); };
    await f.run();
    assert.equal(f.remote.content, "remote draft");
    assert.equal(f.state.getProjectMapping("p", "work")?.conflict, true);
    f.work.updateProject = update;
    await f.run();
    assert.equal(f.remote.content, "personal draft");
    assert.equal(f.state.getProjectMapping("p", "work")?.conflict, false);
  } finally { f.state.close(); }
});
