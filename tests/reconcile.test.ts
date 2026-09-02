import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReconciliationEngine } from "../src/reconcile.js";
import { SyncState } from "../src/state.js";
import { config, FakeWorkspace, issue, project, relation } from "./helpers.js";

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
  it("creates an external project from a personal project routing label", async () => {
    const { appConfig, personal, work, state, engine } = setup();
    appConfig.external[0].personalLabels = ["frv:work"];
    personal.projects.set("personal-project", project("personal", {
      id: "personal-project",
      url: "https://linear.app/personal/project/personal-project",
      name: "Personal project",
      statusName: "Backlog",
      labelNames: ["sync:work"],
      description: "Project description",
      priority: 2,
      startDate: "2026-01-01",
      targetDate: "2026-03-01",
      leadAssigned: true,
      memberAssigned: true,
    }));

    const result = await engine.run(true);

    expect(result.createdOutboundProjects).toBe(1);
    expect([...work.projects.values()]).toEqual([expect.objectContaining({
      name: "Personal project",
      description: "Project description",
      priority: 2,
      startDate: "2026-01-01",
      targetDate: "2026-03-01",
      leadAssigned: true,
      memberAssigned: true,
    })]);
    expect(personal.projects.get("personal-project")?.labelNames).toEqual(["sync:work", "frv:work"]);
    expect([...work.projects.values()][0].labelNames).toEqual([]);
    expect(personal.projectLinks).toHaveLength(1);
    expect(state.findProjectMappingByExternal("work", [...work.projects.keys()][0])?.personalProjectId)
      .toBe("personal-project");
    state.close();
  });

  it("brings in an external project when an eligible inbound issue belongs to it", async () => {
    const { appConfig, personal, work, state, engine } = setup();
    appConfig.external[0].personalLabels = ["frv:work"];
    work.projects.set("work-project", project("work", {
      id: "work-project",
      url: "https://linear.app/work/project/work-project",
      name: "External project",
      statusName: "In Progress",
      statusType: "started",
      leadAssigned: true,
      memberAssigned: true,
    }));
    work.issues.set("work-1", issue("work", {
      id: "work-1",
      identifier: "WORK-1",
      url: "https://linear.app/work/issue/WORK-1",
      title: "External task",
      statusName: "Todo",
      assigneeEmail: "me@example.com",
      projectId: "work-project",
    }));

    const result = await engine.run(true);

    expect(result.createdInboundProjects).toBe(1);
    const personalProject = [...personal.projects.values()][0];
    expect(personalProject).toEqual(expect.objectContaining({
      name: "External project",
      statusName: "In Progress",
      leadAssigned: true,
      memberAssigned: true,
    }));
    expect(personalProject.labelNames).toEqual(["sync:work", "frv:work"]);
    expect(work.projects.get("work-project")?.labelNames).toEqual([]);
    expect([...personal.issues.values()][0].projectId).toBe(personalProject.id);
    expect(personal.projectLinks).toHaveLength(1);
    expect(state.findProjectMappingByExternal("work", "work-project")?.personalProjectId)
      .toBe(personalProject.id);
    state.close();
  });

  it("brings in a project when a linked personal issue is eligible for synchronization", async () => {
    const { personal, work, state, engine } = setup();
    work.projects.set("work-project", project("work", {
      id: "work-project",
      url: "https://linear.app/work/project/work-project",
      name: "Linked project",
      statusName: "Backlog",
    }));
    work.issues.set("work-1", issue("work", {
      id: "work-1",
      identifier: "WORK-1",
      url: "https://linear.app/work/issue/WORK-1",
      title: "Linked issue",
      statusName: "Todo",
      projectId: "work-project",
    }));
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Linked issue",
      statusName: "Todo",
      externalLinks: [{
        workspaceKey: "work",
        issueId: "work-1",
        issueUrl: "https://linear.app/work/issue/WORK-1",
      }],
    }));

    await engine.run(true);

    expect(personal.projects).toHaveLength(1);
    expect(state.findProjectMappingByExternal("work", "work-project")).toBeDefined();
    state.close();
  });

  it("synchronizes mapped project fields and current-user roles independently", async () => {
    const { personal, work, state, engine } = setup();
    personal.projects.set("personal-project", project("personal", {
      id: "personal-project",
      url: "https://linear.app/personal/project/personal-project",
      name: "Original project",
      statusName: "Backlog",
      description: "Original description",
      leadAssigned: false,
      memberAssigned: false,
      externalLinks: [{
        workspaceKey: "work",
        projectId: "work-project",
        projectUrl: "https://linear.app/work/project/work-project",
      }],
    }));
    work.projects.set("work-project", project("work", {
      id: "work-project",
      url: "https://linear.app/work/project/work-project",
      name: "Original project",
      statusName: "Backlog",
      description: "Original description",
    }));

    await engine.run(true);
    personal.projects.get("personal-project")!.name = "Personal rename";
    personal.projects.get("personal-project")!.leadAssigned = true;
    await engine.run(false);

    expect(work.projects.get("work-project")).toEqual(expect.objectContaining({
      name: "Personal rename",
      leadAssigned: true,
    }));

    work.projects.get("work-project")!.description = "External description";
    work.projects.get("work-project")!.memberAssigned = true;
    await engine.run(false);

    expect(personal.projects.get("personal-project")).toEqual(expect.objectContaining({
      description: "External description",
      memberAssigned: true,
    }));
    expect(state.listProjectMappings()).toHaveLength(1);
    state.close();
  });

  it("uses an explicit project link before a project routing label", async () => {
    const { personal, work, state, engine } = setup();
    work.projects.set("linked-project", project("work", {
      id: "linked-project",
      url: "https://linear.app/work/project/linked-project",
      name: "Linked project",
      statusName: "Backlog",
    }));
    personal.projects.set("personal-project", project("personal", {
      id: "personal-project",
      url: "https://linear.app/personal/project/personal-project",
      name: "Personal project",
      statusName: "Backlog",
      labelNames: ["sync:work"],
      externalLinks: [{
        workspaceKey: "work",
        projectId: "linked-project",
        projectUrl: "https://linear.app/work/project/linked-project",
      }],
    }));

    await engine.run(true);

    expect(work.projects).toHaveLength(1);
    expect(state.findProjectMappingByExternal("work", "linked-project")?.personalProjectId)
      .toBe("personal-project");
    state.close();
  });

  it("synchronizes issue project membership only after both projects are mapped", async () => {
    const { personal, work, state, engine } = setup();
    personal.projects.set("personal-project", project("personal", {
      id: "personal-project",
      url: "https://linear.app/personal/project/personal-project",
      name: "Shared project",
      statusName: "Backlog",
      externalLinks: [{
        workspaceKey: "work",
        projectId: "work-project",
        projectUrl: "https://linear.app/work/project/work-project",
      }],
    }));
    work.projects.set("work-project", project("work", {
      id: "work-project",
      url: "https://linear.app/work/project/work-project",
      name: "Shared project",
      statusName: "Backlog",
    }));
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Shared task",
      statusName: "Todo",
      externalLinks: [{
        workspaceKey: "work",
        issueId: "work-1",
        issueUrl: "https://linear.app/work/issue/WORK-1",
      }],
    }));
    work.issues.set("work-1", issue("work", {
      id: "work-1",
      identifier: "WORK-1",
      url: "https://linear.app/work/issue/WORK-1",
      title: "Shared task",
      statusName: "Todo",
    }));

    await engine.run(true);
    personal.issues.get("personal-1")!.projectId = "personal-project";
    await engine.run(false);

    expect(work.issues.get("work-1")?.projectId).toBe("work-project");

    personal.issues.get("personal-1")!.projectId = null;
    await engine.run(false);

    expect(work.issues.get("work-1")?.projectId).toBeNull();

    personal.issues.get("personal-1")!.projectId = "personal-project";
    await engine.run(false);

    expect(work.issues.get("work-1")?.projectId).toBe("work-project");

    work.issues.get("work-1")!.projectId = null;
    await engine.run(false);

    expect(personal.issues.get("personal-1")?.projectId).toBe("personal-project");
    state.close();
  });

  it("leaves issue project membership alone when a current project is unmapped", async () => {
    const { personal, work, state, engine } = setup();
    personal.projects.set("mapped-project", project("personal", {
      id: "mapped-project",
      url: "https://linear.app/personal/project/mapped-project",
      name: "Mapped project",
      statusName: "Backlog",
      externalLinks: [{
        workspaceKey: "work",
        projectId: "work-project",
        projectUrl: "https://linear.app/work/project/work-project",
      }],
    }));
    personal.projects.set("local-project", project("personal", {
      id: "local-project",
      url: "https://linear.app/personal/project/local-project",
      name: "Local project",
      statusName: "Backlog",
    }));
    work.projects.set("work-project", project("work", {
      id: "work-project",
      url: "https://linear.app/work/project/work-project",
      name: "Mapped project",
      statusName: "Backlog",
    }));
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Shared task",
      statusName: "Todo",
      projectId: "local-project",
      externalLinks: [{
        workspaceKey: "work",
        issueId: "work-1",
        issueUrl: "https://linear.app/work/issue/WORK-1",
      }],
    }));
    work.issues.set("work-1", issue("work", {
      id: "work-1",
      identifier: "WORK-1",
      url: "https://linear.app/work/issue/WORK-1",
      title: "Shared task",
      statusName: "Todo",
      projectId: "work-project",
    }));

    await engine.run(true);

    expect(personal.issues.get("personal-1")?.projectId).toBe("local-project");
    expect(work.issues.get("work-1")?.projectId).toBe("work-project");
    state.close();
  });

  it("maps one personal project independently to multiple external workspaces", async () => {
    const directory = mkdtempSync(join(tmpdir(), "linear-sync-project-many-"));
    const appConfig = config(join(directory, "state.db"));
    appConfig.external.push({
      key: "startup",
      name: "Startup",
      apiKeyEnv: "STARTUP",
      workspaceName: "Startup",
      workspaceSlug: "startup",
      teamName: "Startup",
      routingLabel: "sync:startup",
      personalLabels: [],
      statusMappings: {},
    });
    const personal = new FakeWorkspace("personal", "me@example.com");
    const work = new FakeWorkspace("work", "me@example.com");
    const startup = new FakeWorkspace("startup", "me@example.com");
    const state = new SyncState(appConfig.databasePath);
    const engine = new ReconciliationEngine(
      appConfig,
      personal,
      new Map([["work", work], ["startup", startup]]),
      state,
    );
    personal.projects.set("personal-project", project("personal", {
      id: "personal-project",
      url: "https://linear.app/personal/project/personal-project",
      name: "Shared project",
      statusName: "Backlog",
      labelNames: ["sync:work", "sync:startup"],
    }));

    await engine.run(true);

    expect(work.projects).toHaveLength(1);
    expect(startup.projects).toHaveLength(1);
    expect(state.listProjectMappings()).toHaveLength(2);
    state.close();
  });

  it("keeps project synchronization active after an issue stops qualifying", async () => {
    const { personal, work, state, engine } = setup();
    personal.projects.set("personal-project", project("personal", {
      id: "personal-project",
      url: "https://linear.app/personal/project/personal-project",
      name: "Original project",
      statusName: "Backlog",
      labelNames: ["sync:work"],
    }));
    personal.issues.set("personal-1", issue("personal", {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Routed task",
      statusName: "Todo",
      labelNames: ["sync:work"],
      projectId: "personal-project",
    }));

    await engine.run(true);
    personal.issues.get("personal-1")!.labelNames = [];
    personal.issues.get("personal-1")!.externalLinks = [];
    [...work.issues.values()][0].assigneeEmail = null;
    personal.projects.get("personal-project")!.name = "Project edited after issue removal";
    await engine.run(false);

    const externalProject = [...work.projects.values()][0];
    expect(externalProject.name).toBe("Project edited after issue removal");
    expect(state.listProjectMappings()[0].active).toBe(true);
    expect(state.listMappings()[0].active).toBe(false);
    state.close();
  });

  it("ignores archived projects silently", async () => {
    const { personal, work, state, engine } = setup();
    personal.projects.set("personal-project", project("personal", {
      id: "personal-project",
      url: "https://linear.app/personal/project/personal-project",
      name: "Archived project",
      statusName: "Backlog",
      externalLinks: [{
        workspaceKey: "work",
        projectId: "work-project",
        projectUrl: "https://linear.app/work/project/work-project",
      }],
    }));
    work.projects.set("work-project", project("work", {
      id: "work-project",
      url: "https://linear.app/work/project/work-project",
      name: "Archived project",
      statusName: "Backlog",
    }));

    await engine.run(true);
    work.projects.get("work-project")!.archived = true;
    await engine.run(false);

    expect(personal.projects.get("personal-project")?.labelNames).not.toContain("sync:external-unavailable");
    expect(personal.projectComments).toEqual([]);
    expect(state.listProjectMappings()[0].active).toBe(true);
    state.close();
  });

  it("does not assign an inbound issue to an archived project", async () => {
    const { personal, work, state, engine } = setup();
    personal.projects.set("personal-project", project("personal", {
      id: "personal-project",
      url: "https://linear.app/personal/project/personal-project",
      name: "Archived project",
      statusName: "Backlog",
      externalLinks: [{
        workspaceKey: "work",
        projectId: "work-project",
        projectUrl: "https://linear.app/work/project/work-project",
      }],
    }));
    work.projects.set("work-project", project("work", {
      id: "work-project",
      url: "https://linear.app/work/project/work-project",
      name: "Archived project",
      statusName: "Backlog",
    }));

    await engine.run(true);
    work.projects.get("work-project")!.archived = true;
    work.issues.set("work-1", issue("work", {
      id: "work-1",
      identifier: "WORK-1",
      url: "https://linear.app/work/issue/WORK-1",
      title: "Archived project task",
      statusName: "Todo",
      assigneeEmail: "me@example.com",
      projectId: "work-project",
    }));

    await engine.run(false);

    expect([...personal.issues.values()][0]?.projectId).toBeNull();
    expect(personal.projectComments).toEqual([]);
    state.close();
  });

  it("flags concurrent project field edits without overwriting either side", async () => {
    const { personal, work, state, engine } = setup();
    personal.projects.set("personal-project", project("personal", {
      id: "personal-project",
      url: "https://linear.app/personal/project/personal-project",
      name: "Original project",
      statusName: "Backlog",
      externalLinks: [{
        workspaceKey: "work",
        projectId: "work-project",
        projectUrl: "https://linear.app/work/project/work-project",
      }],
    }));
    work.projects.set("work-project", project("work", {
      id: "work-project",
      url: "https://linear.app/work/project/work-project",
      name: "Original project",
      statusName: "Backlog",
    }));

    await engine.run(true);
    personal.projects.get("personal-project")!.name = "Personal edit";
    work.projects.get("work-project")!.name = "External edit";
    await engine.run(false);

    expect(personal.projects.get("personal-project")?.name).toBe("Personal edit");
    expect(work.projects.get("work-project")?.name).toBe("External edit");
    expect(personal.projects.get("personal-project")?.labelNames).toContain("sync:conflict");
    expect(personal.projectComments).toHaveLength(1);
    expect(state.listProjectMappings()[0].conflict).toBe(true);
    state.close();
  });

  it("maps project statuses by canonical lifecycle type before exact name", async () => {
    const { personal, work, state, engine } = setup();
    personal.projects.set("personal-project", project("personal", {
      id: "personal-project",
      url: "https://linear.app/personal/project/personal-project",
      name: "Shared project",
      statusName: "Backlog",
      statusType: "backlog",
      externalLinks: [{
        workspaceKey: "work",
        projectId: "work-project",
        projectUrl: "https://linear.app/work/project/work-project",
      }],
    }));
    work.projects.set("work-project", project("work", {
      id: "work-project",
      url: "https://linear.app/work/project/work-project",
      name: "Shared project",
      statusName: "Backlog",
      statusType: "backlog",
    }));

    await engine.run(true);
    work.projects.get("work-project")!.statusName = "Started";
    work.projects.get("work-project")!.statusType = "started";
    await engine.run(false);

    expect(personal.projects.get("personal-project")?.statusName).toBe("In Progress");
    expect(personal.projects.get("personal-project")?.labelNames).not.toContain("sync:broken");
    state.close();
  });

  it("falls back to exact project status names when lifecycle types differ", async () => {
    const { personal, work, state, engine } = setup();
    personal.listProjectStatuses = async () => [
      { name: "Backlog", type: "backlog" },
      { name: "Custom", type: "personal-custom" },
    ];
    work.listProjectStatuses = async () => [
      { name: "Backlog", type: "backlog" },
      { name: "Custom", type: "external-custom" },
    ];
    personal.projects.set("personal-project", project("personal", {
      id: "personal-project",
      url: "https://linear.app/personal/project/personal-project",
      name: "Shared project",
      statusName: "Backlog",
      externalLinks: [{
        workspaceKey: "work",
        projectId: "work-project",
        projectUrl: "https://linear.app/work/project/work-project",
      }],
    }));
    work.projects.set("work-project", project("work", {
      id: "work-project",
      url: "https://linear.app/work/project/work-project",
      name: "Shared project",
      statusName: "Backlog",
    }));

    await engine.run(true);
    work.projects.get("work-project")!.statusName = "Custom";
    work.projects.get("work-project")!.statusType = "external-custom";
    await engine.run(false);

    expect(personal.projects.get("personal-project")?.statusName).toBe("Custom");
    expect(personal.projects.get("personal-project")?.labelNames).not.toContain("sync:broken");
    state.close();
  });

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
