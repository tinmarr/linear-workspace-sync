import type {
  AppConfig,
  IssueRelationSnapshot,
  IssueSnapshot,
} from "../src/domain.js";
import type {
  IssueCreateInput,
  IssueQuery,
  IssueRelationCreateInput,
  IssueUpdate,
  LinearIssue,
  LinearWorkspace,
} from "../src/linear.js";

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
  private relationSequence = 1;
  private clock = 1;

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

  public async getIssue(issueId: string, _includeArchived = false, _includeRelationships = false): Promise<LinearIssue | null> {
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
      updatedAt: this.timestamp(),
      parentIssueId: null,
      parentUpdatedAt: null,
      relations: [],
      relationChanges: [],
    };
    this.issues.set(id, issue);
    return structuredClone(issue);
  }

  public async updateIssue(issueId: string, update: IssueUpdate): Promise<LinearIssue> {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`Unknown issue ${issueId}`);
    const parentChanged = update.parentIssueId !== undefined && issue.parentIssueId !== update.parentIssueId;
    Object.assign(issue, update);
    issue.updatedAt = this.timestamp();
    if (parentChanged) issue.parentUpdatedAt = issue.updatedAt;
    return structuredClone(issue);
  }

  public async createIssueRelation(input: IssueRelationCreateInput): Promise<IssueRelationSnapshot> {
    const relation: IssueRelationSnapshot = {
      id: `${this.key}-relation-${this.relationSequence++}`,
      issueId: input.issueId,
      relatedIssueId: input.relatedIssueId,
      type: input.type,
      createdAt: this.timestamp(),
      updatedAt: this.timestamp(),
    };
    const source = this.issues.get(input.issueId);
    if (!source) throw new Error(`Unknown issue ${input.issueId}`);
    source.relations.push(relation);
    source.updatedAt = relation.updatedAt;
    source.relationChanges.push({
      relatedIdentifier: this.issues.get(input.relatedIssueId)?.identifier ?? input.relatedIssueId,
      action: "added",
      updatedAt: relation.updatedAt,
    });
    return structuredClone(relation);
  }

  public async deleteIssueRelation(relationId: string): Promise<void> {
    for (const source of this.issues.values()) {
      const index = source.relations.findIndex((relation) => relation.id === relationId);
      if (index < 0) continue;
      const [relation] = source.relations.splice(index, 1);
      source.updatedAt = this.timestamp();
      source.relationChanges.push({
        relatedIdentifier: this.issues.get(relation.relatedIssueId)?.identifier ?? relation.relatedIssueId,
        action: "removed",
        updatedAt: source.updatedAt,
      });
      return;
    }
    throw new Error(`Unknown issue relation ${relationId}`);
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

  public listRelationships(): IssueRelationSnapshot[] {
    return [...this.issues.values()]
      .flatMap((issue) => issue.relations)
      .map((relation) => structuredClone(relation));
  }

  private timestamp(): string {
    return new Date(this.clock++ * 1000).toISOString();
  }
}

export function issue(
  workspaceKey: string,
  values: Partial<IssueSnapshot>
    & Partial<Pick<LinearIssue, "parentIssueId" | "parentUpdatedAt" | "relations" | "relationChanges" | "updatedAt">>
    & Pick<IssueSnapshot, "id" | "identifier" | "url" | "title" | "statusName">,
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
    updatedAt: values.updatedAt ?? "2026-01-01T00:00:00.000Z",
    parentIssueId: values.parentIssueId ?? null,
    parentUpdatedAt: values.parentUpdatedAt ?? null,
    relations: values.relations ?? [],
    relationChanges: values.relationChanges ?? [],
  };
}

export function relation(
  workspaceKey: string,
  issueId: string,
  relatedIssueId: string,
  type: string,
): IssueRelationSnapshot {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id: `${workspaceKey}-relation-${issueId}-${relatedIssueId}-${type}`,
    issueId,
    relatedIssueId,
    type,
    createdAt: timestamp,
    updatedAt: timestamp,
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
