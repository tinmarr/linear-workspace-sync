import type { IssueSnapshot, WorkspaceKey } from "./domain.js";

export type ExternalIssueLink = {
  workspaceKey: WorkspaceKey;
  issueId: string;
  issueUrl: string;
};

export type LinearIssue = IssueSnapshot & {
  externalLinks: ExternalIssueLink[];
};

export type IssueCreateInput = {
  title: string;
  description: string | null;
  statusName: string | null;
  dueDate: string | null;
  estimate: number | null;
  priority: number;
  assigneeEmail?: string | null;
};

export type IssueUpdate = Partial<
  Pick<
    IssueSnapshot,
    "title" | "description" | "statusName" | "dueDate" | "estimate" | "priority"
  >
> & {
  assigneeEmail?: string | null;
};

export type IssueQuery = {
  assignedToViewer?: boolean;
  teamName?: string;
  includeArchived?: boolean;
  includeLabels?: boolean;
  includeExternalLinks?: boolean;
  excludeCompleted?: boolean;
};

export interface LinearWorkspace {
  readonly key: WorkspaceKey;
  readonly viewerId: string;
  readonly viewerEmail: string;

  listIssues(query: IssueQuery): Promise<LinearIssue[]>;
  getIssue(issueId: string, includeArchived?: boolean): Promise<LinearIssue | null>;
  listStatusNames(teamName: string): Promise<Set<string>>;
  createIssue(input: IssueCreateInput, teamName: string): Promise<LinearIssue>;
  updateIssue(issueId: string, update: IssueUpdate): Promise<LinearIssue>;
  restoreIssue(issueId: string): Promise<LinearIssue>;
  ensureLabel(text: string): Promise<void>;
  addLabel(issueId: string, text: string): Promise<void>;
  removeLabel(issueId: string, text: string): Promise<void>;
  addPersonalLink(issueId: string, targetUrl: string, title: string): Promise<void>;
  addPersonalNotification(issueId: string, message: string): Promise<void>;
}
