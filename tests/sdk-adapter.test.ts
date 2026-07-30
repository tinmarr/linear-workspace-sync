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
});
