import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReconciliationEngine } from "../src/reconcile.js";
import { SyncState } from "../src/state.js";
import { config, FakeWorkspace, issue } from "./helpers.js";

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
    expect(work.getIssueCalls).toBe(0);
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
});
