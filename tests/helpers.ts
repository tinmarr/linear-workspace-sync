import type { AppConfig, IssueSnapshot } from "../src/domain.js";
import type { IssueCreateInput, IssueQuery, IssueUpdate, LinearIssue, LinearWorkspace } from "../src/linear.js";

export class FakeWorkspace implements LinearWorkspace {
  public readonly viewerId: string;
  public readonly viewerEmail: string;
  public readonly issues = new Map<string, LinearIssue>();
  public readonly labels = new Set<string>();
  public readonly comments: Array<{ issueId: string; body: string }> = [];
  public readonly links: Array<{ issueId: string; url: string }> = [];
  public readonly listQueries: IssueQuery[] = [];
  public getIssueCalls = 0;
  private nextIssue = 1;

  public constructor(
    public readonly key: string,
    viewerEmail: string,
    private readonly statuses = new Set(["Todo", "In Progress", "Done"]),
  ) {
    this.viewerId = `${key}-viewer`;
    this.viewerEmail = viewerEmail;
  }

  public async listIssues(query: IssueQuery): Promise<LinearIssue[]> {
    this.listQueries.push(query);
    return [...this.issues.values()]
      .filter((issue) => !issue.archived)
      .filter((issue) => !query.assignedToViewer || issue.assigneeEmail === this.viewerEmail)
      .map((issue) => structuredClone(issue));
  }

  public async getIssue(issueId: string): Promise<LinearIssue | null> {
    this.getIssueCalls++;
    const issue = this.issues.get(issueId) ?? [...this.issues.values()].find((item) => item.identifier === issueId);
    return issue ? structuredClone(issue) : null;
  }

  public async listStatusNames(): Promise<Set<string>> {
    return new Set(this.statuses);
  }

  public async createIssue(input: IssueCreateInput): Promise<LinearIssue> {
    const id = `${this.key}-issue-${this.nextIssue++}`;
    const identifier = `${this.key.toUpperCase()}-${this.nextIssue}`;
    const issue: LinearIssue = {
      id,
      identifier,
      url: `https://linear.app/${this.key}/issue/${identifier}`,
      workspaceKey: this.key,
      title: input.title,
      description: input.description,
      statusName: input.statusName ?? "Todo",
      dueDate: input.dueDate,
      estimate: input.estimate,
      priority: input.priority,
      assigneeEmail: input.assigneeEmail ?? null,
      archived: false,
      labelNames: [],
      externalLinks: [],
    };
    this.issues.set(id, issue);
    return structuredClone(issue);
  }

  public async updateIssue(issueId: string, update: IssueUpdate): Promise<LinearIssue> {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`Unknown issue ${issueId}`);
    Object.assign(issue, update);
    return structuredClone(issue);
  }

  public async restoreIssue(issueId: string): Promise<LinearIssue> {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`Unknown issue ${issueId}`);
    issue.archived = false;
    return structuredClone(issue);
  }

  public async ensureLabel(text: string): Promise<void> {
    this.labels.add(text);
  }

  public async addLabel(issueId: string, text: string): Promise<void> {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`Unknown issue ${issueId}`);
    if (!issue.labelNames.includes(text)) issue.labelNames.push(text);
    this.labels.add(text);
  }

  public async removeLabel(issueId: string, text: string): Promise<void> {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`Unknown issue ${issueId}`);
    if (!issue.labelNames.includes(text)) {
      throw new Error(`Label not on issue: ${text}`);
    }
    issue.labelNames = issue.labelNames.filter((label) => label !== text);
  }

  public async addPersonalLink(issueId: string, targetUrl: string): Promise<void> {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`Unknown issue ${issueId}`);
    this.links.push({ issueId, url: targetUrl });
    const target = targetUrl.match(/linear\.app\/([^/]+)\/issue\/([^/]+)/);
    if (target) {
      issue.externalLinks.push({
        workspaceKey: target[1],
        issueId: target[2],
        issueUrl: targetUrl,
      });
    }
  }

  public async addPersonalNotification(issueId: string, body: string): Promise<void> {
    this.comments.push({ issueId, body });
  }
}

export function issue(
  workspaceKey: string,
  values: Partial<IssueSnapshot> & Pick<IssueSnapshot, "id" | "identifier" | "url" | "title" | "statusName">,
): LinearIssue {
  return {
    id: values.id,
    identifier: values.identifier,
    url: values.url,
    workspaceKey,
    title: values.title,
    description: values.description ?? null,
    statusName: values.statusName,
    dueDate: values.dueDate ?? null,
    estimate: values.estimate ?? null,
    priority: values.priority ?? 0,
    assigneeEmail: values.assigneeEmail ?? null,
    archived: values.archived ?? false,
    labelNames: values.labelNames ?? [],
    externalLinks: [],
  };
}

export function config(databasePath: string): AppConfig {
  return {
    pollIntervalSeconds: 300,
    databasePath,
    notificationAccessTokenEnv: "LINEAR_NOTIFICATION_ACCESS_TOKEN",
    personal: {
      key: "personal",
      name: "Personal",
      apiKeyEnv: "PERSONAL",
      workspaceName: "Personal",
      teamName: "Personal",
      personalLabels: [],
      statusMappings: {},
    },
    external: [
      {
        key: "work",
        name: "Work",
        apiKeyEnv: "WORK",
        workspaceName: "Work",
        workspaceSlug: "work",
        teamName: "Work",
        routingLabel: "sync:work",
        personalLabels: [],
        statusMappings: {},
      },
    ],
    syncLabels: {
      conflict: "sync:conflict",
      broken: "sync:broken",
      externalUnavailable: "sync:external-unavailable",
    },
  };
}
