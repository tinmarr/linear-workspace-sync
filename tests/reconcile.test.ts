import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReconciliationEngine } from "../src/reconcile.js";
import { SyncState } from "../src/state.js";
import { config, FakeWorkspace, issue, relation } from "./helpers.js";

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "linear-sync-"));
  const appConfig = config(join(directory, "state.db"));
  const personal = new FakeWorkspace("personal", "me@example.com");
  const work = new FakeWorkspace("work", "me@example.com");
  const state = new SyncState(appConfig.databasePath);
  const engine = new ReconciliationEngine(appConfig, personal, new Map([["work", work]]), state);
  return { appConfig, personal, work, state, engine };
}

describe("reconciliation", () => {
  it("excludes completed issues from initial discovery only", async () => {
    const { personal, work, state, engine } = setup();

    await engine.run(true);
    expect(personal.listQueries[0].excludeCompleted).toBe(true);
    expect(work.listQueries[0].excludeCompleted).toBe(true);

    await engine.run(false);
    expect(personal.listQueries[1].excludeCompleted).toBe(false);
    expect(work.listQueries[1].excludeCompleted).toBe(false);
    state.close();
  });

  it("reconciles every configured external workspace", async () => {
    const directory = mkdtempSync(join(tmpdir(), "linear-sync-many-"));
    const appConfig = config(join(directory, "state.db"));
    const externalKeys = ["work", "startup", "side"];
    appConfig.external = externalKeys.map((key) => ({
      key,
      name: key,
      apiKeyEnv: `${key.toUpperCase()}_KEY`,
      workspaceName: key,
      workspaceSlug: key,
      teamName: key,
      routingLabel: `sync:${key}`,
      personalLabels: [`frv:${key}`],
      statusMappings: {},
    }));
    const personal = new FakeWorkspace("personal", "me@example.com");
    const externals = new Map(externalKeys.map((key) => [key, new FakeWorkspace(key, "me@example.com")]));
    for (const key of externalKeys) {
      externals.get(key)!.issues.set(`${key}-1`, issue(key, {
        id: `${key}-1`,
        identifier: `${key.toUpperCase()}-1`,
        url: `https://linear.app/${key}/issue/${key.toUpperCase()}-1`,
        title: `${key} task`,
        statusName: "Todo",
        assigneeEmail: "me@example.com",
      }));
    }
    const state = new SyncState(appConfig.databasePath);
    const engine = new ReconciliationEngine(appConfig, personal, externals, state);

    await engine.run(true);

    expect(personal.issues.size).toBe(3);
    expect(personal.links).toHaveLength(3);
    for (const key of externalKeys) {
      expect([...personal.issues.values()].some((item) => item.labelNames.includes(`sync:${key}`))).toBe(true);
      expect([...personal.issues.values()].some((item) => item.labelNames.includes(`frv:${key}`))).toBe(true);
      expect(externals.get(key)!.comments).toEqual([]);
      expect([...externals.get(key)!.issues.values()][0].labelNames).toEqual([]);
    }
    state.close();
  });

  it("creates inbound personal issues without changing external sync signals", async () => {
    const { appConfig, personal, work, state, engine } = setup();
    appConfig.external[0].personalLabels = ["frv:work"];
    work.issues.set("work-1", issue("work", {
      id: "work-1",
      identifier: "WORK-1",
      url: "https://linear.app/work/issue/WORK-1",
      title: "External task",
      statusName: "Todo",
      assigneeEmail: "me@example.com",
    }));

    const result = await engine.run(true);

    expect(result.createdInbound).toBe(1);
    expect(personal.issues.size).toBe(1);
    expect([...personal.issues.values()][0].labelNames).toContain("sync:work");
    expect([...personal.issues.values()][0].labelNames).toContain("frv:work");
    expect(personal.links).toHaveLength(1);
    expect(work.issues.get("work-1")?.labelNames).toEqual([]);
    expect(work.comments).toEqual([]);
    expect(work.getIssueCalls).toBe(1);
    expect(state.isInitialized()).toBe(true);
    state.close();
  });

  it("adds configured personal labels to existing mappings", async () => {
    const { appConfig, personal, work, state, engine } = setup();
    appConfig.external[0].personalLabels = ["frv:work"];
    work.issues.set("work-1", issue("work", {
      id: "work-1",
      identifier: "WORK-1",
      url: "https://linear.app/work/issue/WORK-1",
      title: "Existing external task",
      statusName: "Todo",
      assigneeEmail: "me@example.com",
    }));
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Existing personal task",
      statusName: "Todo",
      labelNames: ["sync:work"],
    }));
    personal.issues.get("personal-1")!.externalLinks.push({
      workspaceKey: "work",
      issueId: "work-1",
      issueUrl: "https://linear.app/work/issue/WORK-1",
    });

    await engine.run(true);

    expect(personal.issues.get("personal-1")?.labelNames).toContain("frv:work");
    expect(work.issues.get("work-1")?.labelNames).not.toContain("frv:work");
    state.close();
  });

  it("assigns outbound issues to the authenticated user in both workspaces", async () => {
    const { personal, work, state, engine } = setup();
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Personal task",
      statusName: "Todo",
      labelNames: ["sync:work"],
    }));

    const result = await engine.run(true);

    expect(result.createdOutbound).toBe(1);
    expect([...work.issues.values()][0].assigneeEmail).toBe("me@example.com");
    expect(personal.issues.get("personal-1")?.assigneeEmail).toBe("me@example.com");
    state.close();
  });

  it("uses a personal link before routing labels or issue creation", async () => {
    const { personal, work, state, engine } = setup();
    work.issues.set("work-1", issue("work", {
      id: "work-1",
      identifier: "WORK-1",
      url: "https://linear.app/work/issue/WORK-1",
      title: "Existing external task",
      statusName: "Todo",
    }));
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Existing personal task",
      statusName: "Todo",
    }));
    personal.issues.get("personal-1")!.externalLinks.push({
      workspaceKey: "work",
      issueId: "work-1",
      issueUrl: "https://linear.app/work/issue/WORK-1",
    });

    await engine.run(true);

    expect(work.issues.size).toBe(1);
    expect(personal.issues.get("personal-1")?.labelNames).toContain("sync:work");
    expect(state.findMappingByExternal("work", "work-1")?.personalIssueId).toBe("personal-1");
    state.close();
  });

  it("flags concurrent core-field edits without overwriting either side", async () => {
    const { personal, work, state, engine } = setup();
    work.issues.set("work-1", issue("work", {
      id: "work-1",
      identifier: "WORK-1",
      url: "https://linear.app/work/issue/WORK-1",
      title: "Original",
      statusName: "Todo",
    }));
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Original",
      statusName: "Todo",
    }));
    personal.issues.get("personal-1")!.externalLinks.push({
      workspaceKey: "work",
      issueId: "work-1",
      issueUrl: "https://linear.app/work/issue/WORK-1",
    });
    await engine.run(true);
    personal.issues.get("personal-1")!.title = "Personal edit";
    work.issues.get("work-1")!.title = "External edit";

    const result = await engine.run(false);

    expect(personal.issues.get("personal-1")?.title).toBe("Personal edit");
    expect(work.issues.get("work-1")?.title).toBe("External edit");
    expect(personal.issues.get("personal-1")?.labelNames).toContain("sync:conflict");
    expect(personal.comments).toHaveLength(1);
    state.close();
  });

  it("reflects external unassignment into personal without changing external assignment", async () => {
    const { personal, work, state, engine } = setup();
    work.issues.set("work-1", issue("work", {
      id: "work-1",
      identifier: "WORK-1",
      url: "https://linear.app/work/issue/WORK-1",
      title: "Assigned task",
      statusName: "Todo",
      assigneeEmail: "me@example.com",
    }));
    await engine.run(true);
    const personalIssue = [...personal.issues.values()][0];
    expect(personalIssue.assigneeEmail).toBe("me@example.com");
    work.issues.get("work-1")!.assigneeEmail = null;

    await engine.run(false);

    expect(personal.issues.get(personalIssue.id)?.assigneeEmail).toBeNull();
    expect(work.issues.get("work-1")?.assigneeEmail).toBeNull();
    state.close();
  });

  it("does not write personal sync signals to an external issue after repeated inbound failures", async () => {
    const { work, state, engine } = setup();
    work.issues.set("work-1", issue("work", {
      id: "work-1",
      identifier: "WORK-1",
      url: "https://linear.app/work/issue/WORK-1",
      title: "Unavailable task",
      statusName: "Todo",
      assigneeEmail: "me@example.com",
    }));
    work.createIssue = async () => {
      throw new Error("personal creation failed");
    };

    await engine.run(true);
    await engine.run(false);
    await engine.run(false);

    expect(work.issues.get("work-1")?.labelNames).toEqual([]);
    expect(work.comments).toEqual([]);
    state.close();
  });

  it("keeps a broken marker when an explicit status mapping is unavailable", async () => {
    const { appConfig, personal, work, state, engine } = setup();
    appConfig.external[0].statusMappings = { Todo: "Missing" };
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Mapped task",
      statusName: "Todo",
      labelNames: ["sync:work"],
    }));

    await engine.run(true);
    await engine.run(false);

    expect(work.issues.values().next().value?.statusName).toBe("Todo");
    expect(personal.issues.get("personal-1")?.labelNames).toContain("sync:broken");
    state.close();
  });

  it("copies a native issue relationship when both endpoints are synced", async () => {
    const { personal, work, state, engine } = setup();
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "First task",
      statusName: "Todo",
      labelNames: ["sync:work"],
      relations: [relation("personal", "personal-1", "personal-2", "blocks")],
    }));
    personal.issues.set("personal-2", issue("personal", {
      id: "personal-2",
      identifier: "PER-2",
      url: "https://linear.app/personal/issue/PER-2",
      title: "Second task",
      statusName: "Todo",
      labelNames: ["sync:work"],
    }));

    await engine.run(true);

    const created = [...work.issues.values()];
    expect(created).toHaveLength(2);
    expect(work.listRelationships()).toEqual([expect.objectContaining({
      issueId: created.find((item) => item.title === "First task")?.id,
      relatedIssueId: created.find((item) => item.title === "Second task")?.id,
      type: "blocks",
    })]);
    state.close();
  });

  it("copies a parent-child relationship when both issues are synced", async () => {
    const { personal, work, state, engine } = setup();
    personal.issues.set("personal-parent", issue("personal", {
      id: "personal-parent",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Parent task",
      statusName: "Todo",
      labelNames: ["sync:work"],
    }));
    personal.issues.set("personal-child", issue("personal", {
      id: "personal-child",
      identifier: "PER-2",
      url: "https://linear.app/personal/issue/PER-2",
      title: "Child task",
      statusName: "Todo",
      labelNames: ["sync:work"],
      parentIssueId: "personal-parent",
    }));

    await engine.run(true);

    const parent = [...work.issues.values()].find((item) => item.title === "Parent task");
    const child = [...work.issues.values()].find((item) => item.title === "Child task");
    expect(child?.parentIssueId).toBe(parent?.id);
    state.close();
  });

  it("copies an external relationship into the personal workspace", async () => {
    const { personal, work, state, engine } = setup();
    work.issues.set("work-1", issue("work", {
      id: "work-1",
      identifier: "WORK-1",
      url: "https://linear.app/work/issue/WORK-1",
      title: "External first task",
      statusName: "Todo",
      assigneeEmail: "me@example.com",
      relations: [relation("work", "work-1", "work-2", "similar")],
    }));
    work.issues.set("work-2", issue("work", {
      id: "work-2",
      identifier: "WORK-2",
      url: "https://linear.app/work/issue/WORK-2",
      title: "External second task",
      statusName: "Todo",
      assigneeEmail: "me@example.com",
    }));

    await engine.run(true);

    expect(personal.listRelationships()).toEqual([expect.objectContaining({
      type: "similar",
    })]);
    state.close();
  });

  it("copies an external parent relationship even without timestamps", async () => {
    const { personal, work, state, engine } = setup();
    work.issues.set("work-parent", issue("work", {
      id: "work-parent",
      identifier: "WORK-1",
      url: "https://linear.app/work/issue/WORK-1",
      title: "External parent",
      statusName: "Todo",
      assigneeEmail: "me@example.com",
    }));
    work.issues.set("work-child", issue("work", {
      id: "work-child",
      identifier: "WORK-2",
      url: "https://linear.app/work/issue/WORK-2",
      title: "External child",
      statusName: "Todo",
      assigneeEmail: "me@example.com",
      parentIssueId: "work-parent",
    }));

    await engine.run(true);

    const parent = [...personal.issues.values()].find((item) => item.title === "External parent");
    const child = [...personal.issues.values()].find((item) => item.title === "External child");
    expect(child?.parentIssueId).toBe(parent?.id);
    state.close();
  });

  it("leaves a relationship alone when its related issue is not synced", async () => {
    const { personal, work, state, engine } = setup();
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Synced task",
      statusName: "Todo",
      labelNames: ["sync:work"],
      relations: [relation("personal", "personal-1", "personal-local", "related")],
    }));
    personal.issues.set("personal-local", issue("personal", {
      id: "personal-local",
      identifier: "PER-2",
      url: "https://linear.app/personal/issue/PER-2",
      title: "Local task",
      statusName: "Todo",
    }));

    await engine.run(true);

    expect(work.issues.size).toBe(1);
    expect(work.listRelationships()).toEqual([]);
    state.close();
  });

  it("creates a related issue when its personal sync label opts it in", async () => {
    const { appConfig, personal, work, state, engine } = setup();
    appConfig.external[0].routingLabel = "sync:work";
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Synced task",
      statusName: "Todo",
      labelNames: ["sync:work"],
      relations: [relation("personal", "personal-1", "personal-related", "related")],
    }));
    personal.issues.set("personal-related", issue("personal", {
      id: "personal-related",
      identifier: "PER-2",
      url: "https://linear.app/personal/issue/PER-2",
      title: "Opted-in related task",
      statusName: "Todo",
      labelNames: ["sync:work"],
    }));

    await engine.run(true);

    expect(work.issues).toHaveLength(2);
    expect(work.listRelationships()).toHaveLength(1);
    state.close();
  });

  it("removes a previously mirrored relationship when the latest edit removes it", async () => {
    const { personal, work, state, engine } = setup();
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "First task",
      statusName: "Todo",
      labelNames: ["sync:work"],
      relations: [relation("personal", "personal-1", "personal-2", "blocks")],
    }));
    personal.issues.set("personal-2", issue("personal", {
      id: "personal-2",
      identifier: "PER-2",
      url: "https://linear.app/personal/issue/PER-2",
      title: "Second task",
      statusName: "Todo",
      labelNames: ["sync:work"],
    }));
    await engine.run(true);
    const mirrored = work.listRelationships()[0];

    await personal.deleteIssueRelation(personal.listRelationships()[0].id);
    await engine.run(false);

    expect(work.listRelationships()).toEqual([]);
    expect(mirrored).toBeDefined();
    state.close();
  });

  it("keeps the relationship when the external side was edited later", async () => {
    const { personal, work, state, engine } = setup();
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "First task",
      statusName: "Todo",
      labelNames: ["sync:work"],
      relations: [relation("personal", "personal-1", "personal-2", "blocks")],
    }));
    personal.issues.set("personal-2", issue("personal", {
      id: "personal-2",
      identifier: "PER-2",
      url: "https://linear.app/personal/issue/PER-2",
      title: "Second task",
      statusName: "Todo",
      labelNames: ["sync:work"],
    }));
    await engine.run(true);

    await personal.deleteIssueRelation(personal.listRelationships()[0].id);
    const externalRelation = work.issues.get(work.listRelationships()[0].issueId)!.relations[0];
    externalRelation.updatedAt = "2026-02-01T00:00:00.000Z";
    work.issues.get(externalRelation.issueId)!.updatedAt = externalRelation.updatedAt;

    await engine.run(false);

    expect(personal.listRelationships()).toHaveLength(1);
    expect(work.listRelationships()).toHaveLength(1);
    state.close();
  });
});
