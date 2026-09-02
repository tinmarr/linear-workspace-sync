import { describe, expect, it } from "vitest";
import { SdkLinearWorkspace, all } from "../src/sdk-adapter.js";
import { config } from "./helpers.js";

describe("SDK pagination", () => {
  it("does not duplicate nodes when fetchNext mutates the connection", async () => {
    const page = {
      nodes: ["first", "second"],
      pageInfo: { hasNextPage: true },
      fetchNext: async () => {
        page.nodes.push("third");
        page.pageInfo.hasNextPage = false;
        return page;
      },
    };

    await expect(all(Promise.resolve(page))).resolves.toEqual(["first", "second", "third"]);
  });
});

describe("SDK issue hydration", () => {
  it("shares label, attachment, state, and viewer lookups across a list", async () => {
    const appConfig = config(":memory:");
    let issueLabelQueries = 0;
    let attachmentQueries = 0;
    let stateQueries = 0;
    let exactIssueQueries = 0;
    let observedFilter: unknown;
    const connection = <T>(nodes: T[]) => ({
      nodes,
      pageInfo: { hasNextPage: false },
      fetchNext: async () => connection([]),
    });
    const issue = {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Task",
      description: null,
      dueDate: null,
      estimate: null,
      priority: 0,
      archivedAt: null,
      trashed: false,
      labelIds: ["label-routing"],
      stateId: "state-todo",
      assigneeId: "viewer",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      parentId: null,
      relations: async () => connection([]),
      inverseRelations: async () => connection([]),
      history: async () => connection([]),
      labels: () => {
        throw new Error("per-issue label lookup should not run");
      },
      attachments: () => {
        throw new Error("per-issue attachment lookup should not run");
      },
      assignee: () => {
        throw new Error("viewer assignee lookup should not run");
      },
    };
    const team = {
      id: "team-personal",
      name: "Personal",
      states: async () => {
        stateQueries++;
        return connection([{ id: "state-todo", name: "Todo", archivedAt: null }]);
      },
      labels: async () => connection([]),
    };
    const client = {
      issues: async ({ filter }: { filter: unknown }) => {
        observedFilter = filter;
        return connection([issue]);
      },
      teams: async () => connection([team]),
      issueLabels: async () => {
        issueLabelQueries++;
        return connection([{ id: "label-routing", name: "sync:work", archivedAt: null, teamId: "team-personal" }]);
      },
      attachments: async () => {
        attachmentQueries++;
        return connection([{
          issueId: "personal-1",
          url: "https://linear.app/work/issue/WORK-1",
        }]);
      },
      issue: async () => {
        exactIssueQueries++;
        throw new Error("cached issue should not be fetched");
      },
    };
    const Workspace = SdkLinearWorkspace as unknown as new (...args: any[]) => SdkLinearWorkspace;
    const workspace = new Workspace(
      "personal",
      appConfig.personal,
      client,
      { id: "viewer", email: "me@example.com", url: "https://linear.app/personal" },
      appConfig.external,
    );

    const issues = await workspace.listIssues({
      teamName: "Personal",
      includeLabels: true,
      includeExternalLinks: true,
      excludeCompleted: true,
    });
    const cached = await workspace.getIssue("PER-1");

    expect(issues[0]).toMatchObject({
      statusName: "Todo",
      assigneeEmail: "me@example.com",
      labelNames: ["sync:work"],
      externalLinks: [{
        workspaceKey: "work",
        issueId: "WORK-1",
      }],
    });
    expect(cached).toBe(issues[0]);
    expect(issueLabelQueries).toBe(1);
    expect(attachmentQueries).toBe(1);
    expect(stateQueries).toBe(1);
    expect(exactIssueQueries).toBe(0);
    expect(observedFilter).toMatchObject({ completedAt: { null: true } });
  });

  it("hydrates native relationships once and exposes relation mutations", async () => {
    const appConfig = config(":memory:");
    const connection = <T>(nodes: T[]) => ({
      nodes,
      pageInfo: { hasNextPage: false },
      fetchNext: async () => connection([]),
    });
    const relation = {
      id: "relation-1",
      issueId: "personal-1",
      relatedIssueId: "personal-2",
      type: "related",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const inverseRelation = {
      id: "relation-2",
      issueId: "personal-3",
      relatedIssueId: "personal-1",
      type: "blocks",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-03T00:00:00.000Z"),
    };
    const createdRelation = {
      id: "relation-3",
      issueId: "personal-1",
      relatedIssueId: "personal-4",
      type: "duplicate",
      createdAt: new Date("2026-01-04T00:00:00.000Z"),
      updatedAt: new Date("2026-01-04T00:00:00.000Z"),
    };
    const sourceIssue = {
      id: "personal-1",
      identifier: "PER-1",
      url: "https://linear.app/personal/issue/PER-1",
      title: "Task",
      description: null,
      dueDate: null,
      estimate: null,
      priority: 0,
      archivedAt: null,
      trashed: false,
      labelIds: [],
      stateId: "state-todo",
      assigneeId: null,
      updatedAt: new Date("2026-01-04T00:00:00.000Z"),
      parentId: "personal-parent",
      relations: async () => connection([relation]),
      inverseRelations: async () => connection([relation, inverseRelation]),
      history: async () => connection([{
        updatedAt: new Date("2026-01-03T00:00:00.000Z"),
        fromParentId: null,
        toParentId: "personal-parent",
        relationChanges: [{ type: "removed", identifier: "PER-3" }],
      }]),
    };
    const createdInputs: unknown[] = [];
    const deletedIds: string[] = [];
    const team = {
      id: "team-personal",
      name: "Personal",
      states: async () => connection([{ id: "state-todo", name: "Todo", archivedAt: null }]),
      labels: async () => connection([]),
    };
    const client = {
      issue: async () => sourceIssue,
      teams: async () => connection([team]),
      issueLabels: async () => connection([]),
      attachments: async () => connection([]),
      createIssueRelation: async (input: unknown) => {
        createdInputs.push(input);
        return { issueRelation: Promise.resolve(createdRelation) };
      },
      deleteIssueRelation: async (relationId: string) => {
        deletedIds.push(relationId);
        return { success: true };
      },
    };
    const Workspace = SdkLinearWorkspace as unknown as new (...args: any[]) => SdkLinearWorkspace;
    const workspace = new Workspace(
      "personal",
      appConfig.personal,
      client,
      { id: "viewer", email: "me@example.com", url: "https://linear.app/personal" },
      appConfig.external,
    );

    const hydrated = await workspace.getIssue("PER-1", false, true);
    const created = await workspace.createIssueRelation({
      issueId: "personal-1",
      relatedIssueId: "personal-4",
      type: "duplicate",
    });
    await workspace.deleteIssueRelation("relation-3");

    expect(hydrated?.relations).toEqual([
      expect.objectContaining({ id: "relation-1", updatedAt: "2026-01-02T00:00:00.000Z" }),
      expect.objectContaining({ id: "relation-2", issueId: "personal-3" }),
    ]);
    expect(hydrated?.parentUpdatedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(hydrated?.relationChanges).toEqual([{
      relatedIdentifier: "PER-3",
      action: "removed",
      updatedAt: "2026-01-03T00:00:00.000Z",
    }]);
    expect(created).toEqual(expect.objectContaining({ id: "relation-3", type: "duplicate" }));
    expect(createdInputs).toEqual([{
      issueId: "personal-1",
      relatedIssueId: "personal-4",
      type: "duplicate",
    }]);
    expect(deletedIds).toEqual(["relation-3"]);
  });
});

describe("SDK notification client", () => {
  it("uses the injected app client for comments and the human client for sync operations", async () => {
    const appConfig = config(":memory:");
    const humanComments: unknown[] = [];
    const appComments: unknown[] = [];
    const humanCalls: string[] = [];
    const connection = <T>(nodes: T[]) => ({
      nodes,
      pageInfo: { hasNextPage: false },
      fetchNext: async () => connection([]),
    });
    const humanClient = {
      createComment: async (input: unknown) => {
        humanComments.push(input);
      },
      teams: async () => connection([{ id: "team-personal", name: "Personal" }]),
      issueLabels: async () => connection([{
        id: "label-sync-work",
        name: "sync:work",
        archivedAt: null,
        teamId: "team-personal",
      }]),
      issueAddLabel: async () => {
        humanCalls.push("issueAddLabel");
      },
    };
    const appClient = {
      createComment: async (input: unknown) => {
        appComments.push(input);
      },
    };
    const Workspace = SdkLinearWorkspace as unknown as new (...args: any[]) => SdkLinearWorkspace;
    const workspace = new Workspace(
      "personal",
      appConfig.personal,
      humanClient,
      {
        id: "human-viewer",
        email: "me@example.com",
        url: "https://linear.app/personal/profile/me",
      },
      appConfig.external,
      appClient,
    );

    await workspace.addPersonalNotification("personal-1", "A sync conflict needs your attention.");
    await workspace.addLabel("personal-1", "sync:work");

    expect(appComments).toEqual([{
      issueId: "personal-1",
      body: "https://linear.app/personal/profile/me A sync conflict needs your attention.",
    }]);
    expect(humanComments).toEqual([]);
    expect(humanCalls).toEqual(["issueAddLabel"]);
  });
});

describe("SDK project hydration and mutations", () => {
  it("hydrates project status, roles, labels, links, and project mutations", async () => {
    const appConfig = config(":memory:");
    const connection = <T>(nodes: T[]) => ({
      nodes,
      pageInfo: { hasNextPage: false },
      fetchNext: async () => connection([]),
    });
    const project = {
      id: "personal-project",
      url: "https://linear.app/personal/project/personal-project",
      name: "Shared project",
      description: "Description",
      priority: 2,
      startDate: "2026-01-01",
      targetDate: "2026-03-01",
      archivedAt: null,
      trashed: false,
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      leadId: "viewer",
      status: Promise.resolve({ name: "In Progress", type: "started" }),
      members: () => connection([{ id: "viewer" }]),
      labels: () => connection([{ name: "sync:work", archivedAt: null }]),
      externalLinks: () => connection([{
        url: "https://linear.app/work/project/work-project",
      }]),
    };
    const team = {
      id: "team-personal",
      name: "Personal",
      states: async () => connection([]),
      labels: async () => connection([]),
    };
    const createdInputs: unknown[] = [];
    const updatedInputs: unknown[] = [];
    const client = {
      projects: async () => connection([project]),
      project: async () => project,
      projectStatuses: async () => connection([
        { id: "status-started", name: "In Progress", type: "started", archivedAt: null },
        { id: "status-backlog", name: "Backlog", type: "backlog", archivedAt: null },
      ]),
      teams: async () => connection([team]),
      createProject: async (input: unknown) => {
        createdInputs.push(input);
        return { project: Promise.resolve(project) };
      },
      updateProject: async (_id: string, input: unknown) => {
        updatedInputs.push(input);
        return { project: Promise.resolve(project) };
      },
      projectLabels: async () => connection([{ id: "project-label", name: "sync:work", archivedAt: null }]),
      projectAddLabel: async () => undefined,
      projectRemoveLabel: async () => undefined,
      createEntityExternalLink: async () => undefined,
    };
    const Workspace = SdkLinearWorkspace as unknown as new (...args: any[]) => SdkLinearWorkspace;
    const workspace = new Workspace(
      "personal",
      appConfig.personal,
      client,
      { id: "viewer", email: "me@example.com", url: "https://linear.app/personal" },
      appConfig.external,
    );

    const projects = await workspace.listProjects({
      teamName: "Personal",
      includeLabels: true,
      includeExternalLinks: true,
    });
    const created = await workspace.createProject({
      name: "Created project",
      description: null,
      statusName: "In Progress",
      priority: 2,
      startDate: null,
      targetDate: null,
      leadAssigned: true,
      memberAssigned: true,
    }, "Personal");
    await workspace.updateProject("personal-project", {
      name: "Renamed project",
      leadAssigned: false,
      memberAssigned: false,
    });
    await workspace.ensureProjectLabel("sync:work");
    await workspace.addPersonalProjectLink("personal-project", "https://linear.app/work/project/work-project", "Work project");

    expect(projects[0]).toMatchObject({
      statusName: "In Progress",
      statusType: "started",
      leadAssigned: true,
      memberAssigned: true,
      labelNames: ["sync:work"],
      externalLinks: [{ workspaceKey: "work", projectId: "work-project" }],
    });
    expect(created.name).toBe("Shared project");
    expect(createdInputs).toEqual([expect.objectContaining({
      teamIds: ["team-personal"],
      statusId: "status-started",
      leadId: "viewer",
      memberIds: ["viewer"],
    })]);
    expect(updatedInputs).toEqual([expect.objectContaining({
      name: "Renamed project",
      leadId: null,
      memberIds: [],
    })]);
  });
});
