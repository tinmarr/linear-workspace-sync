import { LinearClient, LinearDocument } from "@linear/sdk";
import type { AppConfig, WorkspaceConfig } from "./domain.js";
import type {
  ExternalIssueLink,
  IssueCreateInput,
  IssueQuery,
  IssueUpdate,
  LinearIssue,
  LinearWorkspace,
} from "./linear.js";
import { logEvent } from "./log.js";

type Connection<T> = {
  nodes: T[];
  pageInfo: { hasNextPage: boolean };
  fetchNext(): Promise<Connection<T>>;
};

type SdkIssue = Awaited<ReturnType<LinearClient["issue"]>>;
type SdkTeam = Awaited<ReturnType<LinearClient["team"]>>;
type SdkLabel = Awaited<ReturnType<LinearClient["issueLabels"]>>["nodes"][number];
type SdkAttachment = Awaited<ReturnType<LinearClient["attachments"]>>["nodes"][number];
type SdkViewer = Awaited<LinearClient["viewer"]>;

export async function all<T>(initial: Promise<Connection<T>>): Promise<T[]> {
  let page = await initial;
  const nodes = [...page.nodes];
  while (page.pageInfo.hasNextPage) {
    const previousPage = page;
    const previousLength = page.nodes.length;
    page = await page.fetchNext();
    // @linear/sdk mutates and returns the same connection from fetchNext(),
    // so only append the nodes added by that call. Support a replacement
    // connection as well for adapters that implement pagination differently.
    nodes.push(...(page === previousPage ? page.nodes.slice(previousLength) : page.nodes));
  }
  return nodes;
}

function exactOne<T>(nodes: T[], description: string): T {
  if (nodes.length !== 1) {
    throw new Error(`Expected exactly one ${description}, found ${nodes.length}`);
  }
  return nodes[0];
}

function issueIdentifierFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const index = parts.findIndex((part) => part === "issue");
    const identifier = index >= 0 ? parts[index + 1] : undefined;
    return identifier ? decodeURIComponent(identifier) : undefined;
  } catch {
    return undefined;
  }
}

function slugFromUrl(value: string): string | undefined {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    return parts[0] === "issue" ? undefined : parts[0];
  } catch {
    return undefined;
  }
}

function normalizedDate(value: string | Date | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

export class SdkLinearWorkspace implements LinearWorkspace {
  public readonly viewerId: string;
  public readonly viewerEmail: string;
  private readonly viewerUrl: string;
  private readonly labelIds = new Map<string, string>();
  private readonly teams = new Map<string, SdkTeam>();
  private readonly teamPromises = new Map<string, Promise<SdkTeam>>();
  private readonly stateIds = new Map<string, string>();
  private readonly stateNames = new Map<string, Map<string, string>>();
  private readonly statePromises = new Map<string, Promise<Map<string, string>>>();
  private readonly userIds = new Map<string, string>();
  private readonly userEmailsById = new Map<string, string | null>();
  private readonly userEmailPromises = new Map<string, Promise<string | null>>();
  private readonly issueCache = new Map<string, LinearIssue>();
  private labelCatalog?: Promise<SdkLabel[]>;
  private labelNamesById?: Map<string, string>;
  private attachmentCatalog?: Promise<SdkAttachment[]>;

  private constructor(
    public readonly key: string,
    private readonly config: WorkspaceConfig,
    private readonly client: LinearClient,
    viewer: SdkViewer,
    private readonly linkTargets: WorkspaceConfig[],
  ) {
    this.viewerId = viewer.id;
    this.viewerEmail = viewer.email;
    this.viewerUrl = viewer.url;
  }

  public static async create(
    config: WorkspaceConfig,
    linkTargets: WorkspaceConfig[],
  ): Promise<SdkLinearWorkspace> {
    logEvent("linear_client_creating", { workspace: config.name, key: config.key });
    const apiKey = process.env[config.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Missing API key environment variable: ${config.apiKeyEnv}`);
    }
    const client = new LinearClient({ apiKey });
    logEvent("linear_viewer_fetching", { workspace: config.name, key: config.key });
    const viewer = await client.viewer;
    logEvent("linear_client_ready", { workspace: config.name, key: config.key });
    return new SdkLinearWorkspace(config.key, config, client, viewer, linkTargets);
  }

  public async listIssues(query: IssueQuery): Promise<LinearIssue[]> {
    logEvent("linear_issue_query_starting", {
      workspace: this.config.name,
      key: this.key,
      assignedToViewer: query.assignedToViewer ?? false,
      team: query.teamName,
    });
    const filter: LinearDocument.IssueFilter = {
      archivedAt: { null: true },
      ...(query.excludeCompleted ? { completedAt: { null: true } } : {}),
      ...(query.teamName ? { team: { name: { eq: query.teamName } } } : {}),
      ...(query.assignedToViewer ? { assignee: { isMe: { eq: true } } } : {}),
    };
    const issues = await all(this.client.issues({ filter, includeArchived: false, first: 100 }));
    logEvent("linear_issue_query_received", { workspace: this.config.name, count: issues.length });
    const result = await Promise.all(
      issues
        .filter((issue) => !issue.archivedAt && !issue.trashed)
        .map((issue) => this.toLinearIssue(issue, {
          includeLabels: query.includeLabels ?? this.linkTargets.length > 0,
          includeExternalLinks: query.includeExternalLinks ?? this.linkTargets.length > 0,
        })),
    );
    for (const issue of result) {
      this.cacheIssue(issue);
    }
    logEvent("linear_issue_query_completed", { workspace: this.config.name, count: result.length });
    return result;
  }

  public async getIssue(issueId: string, includeArchived = false): Promise<LinearIssue | null> {
    logEvent("linear_issue_fetching", {
      workspace: this.config.name,
      issueId,
      includeArchived,
    });
    const cached = this.issueCache.get(issueId);
    if (cached && (includeArchived || !cached.archived)) {
      logEvent("linear_issue_fetch_cached", { workspace: this.config.name, identifier: cached.identifier });
      return cached;
    }
    try {
      const issue = await this.client.issue(issueId);
      if (!includeArchived && issue.archivedAt) {
        logEvent("linear_issue_archived", { workspace: this.config.name, issueId });
        return null;
      }
      const result = await this.toLinearIssue(issue);
      this.cacheIssue(result);
      logEvent("linear_issue_fetched", { workspace: this.config.name, identifier: result.identifier });
      return result;
    } catch (error: unknown) {
      if (this.isNotFound(error)) {
        logEvent("linear_issue_not_found", { workspace: this.config.name, issueId });
        return null;
      }
      throw error;
    }
  }

  public async listStatusNames(teamName: string): Promise<Set<string>> {
    const states = await this.loadStateNames(teamName);
    return new Set(states.values());
  }

  public async createIssue(input: IssueCreateInput, teamName: string): Promise<LinearIssue> {
    logEvent("linear_issue_creation_starting", { workspace: this.config.name, team: teamName });
    const team = await this.resolveTeam(teamName);
    const stateId = input.statusName ? await this.resolveStateId(teamName, input.statusName) : undefined;
    const assigneeId = input.assigneeEmail ? await this.resolveUserId(input.assigneeEmail) : undefined;
    const payload = await this.client.createIssue({
      teamId: team.id,
      title: input.title,
      description: input.description ?? undefined,
      dueDate: input.dueDate ?? undefined,
      estimate: input.estimate ?? undefined,
      priority: input.priority,
      stateId,
      assigneeId,
    });
    const issue = await payload.issue;
    if (!issue) throw new Error("Linear returned no issue after createIssue");
    logEvent("linear_issue_created", { workspace: this.config.name, identifier: issue.identifier });
    const result = await this.toLinearIssue(issue);
    this.cacheIssue(result);
    return result;
  }

  public async updateIssue(issueId: string, update: IssueUpdate): Promise<LinearIssue> {
    logEvent("linear_issue_update_starting", { workspace: this.config.name, issueId, fields: Object.keys(update) });
    const input: LinearDocument.IssueUpdateInput = {};
    if (update.title !== undefined) input.title = update.title;
    if (update.description !== undefined) input.description = update.description;
    if (update.dueDate !== undefined) input.dueDate = update.dueDate;
    if (update.estimate !== undefined) input.estimate = update.estimate;
    if (update.priority !== undefined) input.priority = update.priority;
    if (update.statusName !== undefined) {
      input.stateId = await this.resolveStateId(this.config.teamName, update.statusName);
    }
    if (update.assigneeEmail !== undefined) {
      input.assigneeId = update.assigneeEmail === null ? null : await this.resolveUserId(update.assigneeEmail);
    }
    const payload = await this.client.updateIssue(issueId, input);
    const issue = await payload.issue;
    if (!issue) throw new Error(`Linear returned no issue after updateIssue(${issueId})`);
    logEvent("linear_issue_updated", { workspace: this.config.name, identifier: issue.identifier, fields: Object.keys(update) });
    const result = await this.toLinearIssue(issue);
    this.cacheIssue(result);
    return result;
  }

  public async restoreIssue(issueId: string): Promise<LinearIssue> {
    const payload = await (await this.client.issue(issueId)).unarchive();
    const issue = await payload.entity;
    if (!issue) throw new Error(`Linear returned no issue after unarchive(${issueId})`);
    const result = await this.toLinearIssue(issue);
    this.cacheIssue(result);
    return result;
  }

  public async ensureLabel(text: string): Promise<void> {
    logEvent("linear_label_ensuring", { workspace: this.config.name, label: text });
    try {
      await this.resolveLabelId(text);
      logEvent("linear_label_ready", { workspace: this.config.name, label: text });
    } catch (error: unknown) {
      if (!(error instanceof Error) || !error.message.includes("found 0")) throw error;
      logEvent("linear_label_creating", { workspace: this.config.name, label: text, team: this.config.teamName });
      const team = await this.resolveTeam(this.config.teamName);
      const payload = await this.client.createIssueLabel({ name: text, teamId: team.id, color: "#6B7280" });
      const label = await payload.issueLabel;
      if (!label) throw new Error(`Linear returned no label after creating ${text}`);
      this.labelIds.set(text, label.id);
      logEvent("linear_label_created", { workspace: this.config.name, label: text });
    }
  }

  public async addLabel(issueId: string, text: string): Promise<void> {
    logEvent("linear_label_adding", { workspace: this.config.name, issueId, label: text });
    await this.client.issueAddLabel(issueId, await this.resolveLabelId(text));
  }

  public async removeLabel(issueId: string, text: string): Promise<void> {
    logEvent("linear_label_removing", { workspace: this.config.name, issueId, label: text });
    await this.client.issueRemoveLabel(issueId, await this.resolveLabelId(text));
  }

  public async addPersonalLink(issueId: string, targetUrl: string, title: string): Promise<void> {
    logEvent("linear_personal_link_adding", { workspace: this.config.name, issueId, title });
    await this.client.createAttachment({ issueId, url: targetUrl, title });
  }

  public async addPersonalNotification(issueId: string, message: string): Promise<void> {
    logEvent("linear_personal_notification_adding", { workspace: this.config.name, issueId });
    await this.client.createComment({ issueId, body: `${this.viewerUrl} ${message}` });
    logEvent("linear_personal_notification_added", { workspace: this.config.name, issueId });
  }

  private async toLinearIssue(
    issue: SdkIssue,
    options: { includeLabels?: boolean; includeExternalLinks?: boolean } = {},
  ): Promise<LinearIssue> {
    logEvent("linear_issue_hydration_starting", { workspace: this.config.name, identifier: issue.identifier });
    const includeLabels = options.includeLabels ?? this.linkTargets.length > 0;
    const includeExternalLinks = options.includeExternalLinks ?? this.linkTargets.length > 0;
    const [statusName, assigneeEmail, labelNames, externalLinks] = await Promise.all([
      this.statusNameForIssue(issue),
      this.assigneeEmailForIssue(issue),
      includeLabels ? this.labelNamesForIssue(issue) : Promise.resolve([]),
      includeExternalLinks ? this.externalLinksForIssue(issue.id) : Promise.resolve([]),
    ]);
    const result = {
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      workspaceKey: this.key,
      title: issue.title,
      description: issue.description ?? null,
      statusName,
      dueDate: normalizedDate(issue.dueDate),
      estimate: issue.estimate ?? null,
      priority: issue.priority,
      assigneeEmail,
      archived: Boolean(issue.archivedAt || issue.trashed),
      labelNames,
      externalLinks,
    };
    logEvent("linear_issue_hydration_completed", {
      workspace: this.config.name,
      identifier: issue.identifier,
      labels: labelNames.length,
      attachments: externalLinks.length,
    });
    return result;
  }

  private extractExternalLinks(urls: string[]): ExternalIssueLink[] {
    const links: ExternalIssueLink[] = [];
    for (const url of urls) {
      const slug = slugFromUrl(url);
      const identifier = issueIdentifierFromUrl(url);
      const target = this.linkTargets.find((workspace) => workspace.workspaceSlug === slug);
      if (target && identifier) links.push({ workspaceKey: target.key, issueId: identifier, issueUrl: url });
    }
    return links;
  }

  private async resolveTeam(teamName: string): Promise<SdkTeam> {
    const cached = this.teams.get(teamName);
    if (cached) return cached;
    const inFlight = this.teamPromises.get(teamName);
    if (inFlight) return inFlight;
    logEvent("linear_team_resolving", { workspace: this.config.name, team: teamName });
    const promise = (async () => {
      const teams = await all(this.client.teams({ filter: { name: { eq: teamName } }, includeArchived: false, first: 100 }));
      const team = exactOne(teams.filter((candidate) => !candidate.archivedAt && candidate.name === teamName), `team named ${teamName}`);
      this.teams.set(teamName, team);
      logEvent("linear_team_resolved", { workspace: this.config.name, team: teamName });
      return team;
    })();
    this.teamPromises.set(teamName, promise);
    try {
      return await promise;
    } finally {
      if (this.teamPromises.get(teamName) === promise) this.teamPromises.delete(teamName);
    }
  }

  private async resolveStateId(teamName: string, stateName: string): Promise<string> {
    const key = `${teamName}:${stateName}`;
    const cached = this.stateIds.get(key);
    if (cached) return cached;
    logEvent("linear_state_resolving", { workspace: this.config.name, team: teamName, state: stateName });
    const states = await this.loadStateNames(teamName);
    const matches = [...states.entries()]
      .filter(([, name]) => name === stateName)
      .map(([id]) => ({ id, name: stateName }));
    const state = exactOne(matches, `workflow state named ${stateName}`);
    this.stateIds.set(key, state.id);
    logEvent("linear_state_resolved", { workspace: this.config.name, team: teamName, state: stateName });
    return state.id;
  }

  private async resolveLabelId(text: string): Promise<string> {
    const cached = this.labelIds.get(text);
    if (cached) return cached;
    logEvent("linear_label_resolving", { workspace: this.config.name, label: text, team: this.config.teamName });
    const team = await this.resolveTeam(this.config.teamName);
    const catalog = await this.loadLabelCatalog();
    const catalogMatches = catalog.filter((candidate) =>
      !candidate.archivedAt
      && candidate.name === text
      && (!candidate.teamId || candidate.teamId === team.id),
    );
    if (catalogMatches.length === 1) {
      const label = catalogMatches[0];
      this.labelIds.set(text, label.id);
      logEvent("linear_label_resolved", { workspace: this.config.name, label: text });
      return label.id;
    }
    const labels = await all(team.labels({ filter: { name: { eq: text } }, includeArchived: false, first: 100 }));
    const label = exactOne(labels.filter((candidate) => !candidate.archivedAt && candidate.name === text), `label named ${text}`);
    this.labelIds.set(text, label.id);
    logEvent("linear_label_resolved", { workspace: this.config.name, label: text });
    return label.id;
  }

  private async resolveUserId(email: string): Promise<string> {
    if (email === this.viewerEmail) {
      this.userIds.set(email, this.viewerId);
      return this.viewerId;
    }
    const cached = this.userIds.get(email);
    if (cached) return cached;
    logEvent("linear_user_resolving", { workspace: this.config.name });
    const users = await all(this.client.users({ filter: { email: { eq: email } }, includeArchived: false, first: 100 }));
    const user = exactOne(users.filter((candidate) => !candidate.archivedAt && candidate.email === email), "configured assignee");
    this.userIds.set(email, user.id);
    logEvent("linear_user_resolved", { workspace: this.config.name });
    return user.id;
  }

  private async loadStateNames(teamName: string): Promise<Map<string, string>> {
    const cached = this.stateNames.get(teamName);
    if (cached) {
      logEvent("linear_status_query_cached", { workspace: this.config.name, team: teamName, count: cached.size });
      return cached;
    }
    const inFlight = this.statePromises.get(teamName);
    if (inFlight) return inFlight;
    logEvent("linear_status_query_starting", { workspace: this.config.name, team: teamName });
    const promise = (async () => {
      const team = await this.resolveTeam(teamName);
      const states = await all(team.states({ includeArchived: false, first: 100 }));
      const names = new Map(states.filter((state) => !state.archivedAt).map((state) => [state.id, state.name]));
      this.stateNames.set(teamName, names);
      logEvent("linear_status_query_completed", { workspace: this.config.name, team: teamName, count: names.size });
      return names;
    })();
    this.statePromises.set(teamName, promise);
    try {
      return await promise;
    } finally {
      if (this.statePromises.get(teamName) === promise) this.statePromises.delete(teamName);
    }
  }

  private async statusNameForIssue(issue: SdkIssue): Promise<string> {
    const names = await this.loadStateNames(this.config.teamName);
    const cachedName = names.get(issue.stateId ?? "");
    if (cachedName) return cachedName;
    const state = issue.state ? await issue.state : undefined;
    return state?.name ?? "";
  }

  private async assigneeEmailForIssue(issue: SdkIssue): Promise<string | null> {
    const assigneeId = issue.assigneeId;
    if (!assigneeId) return null;
    if (assigneeId === this.viewerId) return this.viewerEmail;
    if (this.userEmailsById.has(assigneeId)) return this.userEmailsById.get(assigneeId) ?? null;
    const inFlight = this.userEmailPromises.get(assigneeId);
    if (inFlight) return inFlight;
    const promise = (async () => {
      const assignee = issue.assignee ? await issue.assignee : undefined;
      const email = assignee?.email ?? null;
      this.userEmailsById.set(assigneeId, email);
      return email;
    })();
    this.userEmailPromises.set(assigneeId, promise);
    try {
      return await promise;
    } finally {
      if (this.userEmailPromises.get(assigneeId) === promise) this.userEmailPromises.delete(assigneeId);
    }
  }

  private async labelNamesForIssue(issue: SdkIssue): Promise<string[]> {
    const labels = await this.loadLabelCatalog();
    this.labelNamesById ??= new Map(
      labels.filter((label) => !label.archivedAt).map((label) => [label.id, label.name]),
    );
    return issue.labelIds.flatMap((id) => {
      const name = this.labelNamesById!.get(id);
      return name ? [name] : [];
    });
  }

  private async loadLabelCatalog(): Promise<SdkLabel[]> {
    if (this.labelCatalog) return this.labelCatalog;
    const promise = (async () => {
      logEvent("linear_label_catalog_fetching", { workspace: this.config.name });
      const labels = await all(this.client.issueLabels({ includeArchived: false, first: 100 }));
      logEvent("linear_label_catalog_received", { workspace: this.config.name, count: labels.length });
      return labels;
    })();
    this.labelCatalog = promise;
    try {
      return await promise;
    } catch (error) {
      if (this.labelCatalog === promise) this.labelCatalog = undefined;
      throw error;
    }
  }

  private async externalLinksForIssue(issueId: string): Promise<ExternalIssueLink[]> {
    const attachments = await this.loadAttachmentCatalog();
    return attachments
      .filter((attachment) => attachment.issueId === issueId)
      .flatMap((attachment) => this.extractExternalLinks([attachment.url]));
  }

  private async loadAttachmentCatalog(): Promise<SdkAttachment[]> {
    if (this.attachmentCatalog) return this.attachmentCatalog;
    const promise = (async () => {
      logEvent("linear_attachment_catalog_fetching", { workspace: this.config.name });
      const urlFilters = this.linkTargets
        .map((target) => target.workspaceSlug)
        .filter((slug): slug is string => Boolean(slug))
        .map((slug) => ({ url: { contains: `/${slug}/issue/` } }));
      const filter = urlFilters.length === 1
        ? urlFilters[0]
        : urlFilters.length > 1
          ? { or: urlFilters }
          : undefined;
      const attachments = await all(this.client.attachments({ filter, includeArchived: false, first: 100 }));
      logEvent("linear_attachment_catalog_received", { workspace: this.config.name, count: attachments.length });
      return attachments;
    })();
    this.attachmentCatalog = promise;
    try {
      return await promise;
    } catch (error) {
      if (this.attachmentCatalog === promise) this.attachmentCatalog = undefined;
      throw error;
    }
  }

  private cacheIssue(issue: LinearIssue): void {
    this.issueCache.set(issue.id, issue);
    this.issueCache.set(issue.identifier, issue);
  }

  private isNotFound(error: unknown): boolean {
    return error instanceof Error && /not found|does not exist|unknown/i.test(error.message);
  }
}

export async function createSdkWorkspaces(config: AppConfig): Promise<{
  personal: SdkLinearWorkspace;
  externals: Map<string, SdkLinearWorkspace>;
}> {
  const personal = await SdkLinearWorkspace.create(config.personal, config.external);
  const externalEntries = await Promise.all(
    config.external.map(async (workspace) => [workspace.key, await SdkLinearWorkspace.create(workspace, [])] as const),
  );
  return { personal, externals: new Map(externalEntries) };
}
