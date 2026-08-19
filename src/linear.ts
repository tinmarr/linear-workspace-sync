import type {
  IssueRelationChange,
  IssueRelationSnapshot,
  IssueSnapshot,
  WorkspaceKey,
} from "./domain.js";

export type ExternalIssueLink = {
  workspaceKey: WorkspaceKey;
  issueId: string;
  issueUrl: string;
};

export type LinearIssue = IssueSnapshot & {
  externalLinks: ExternalIssueLink[];
  updatedAt: string;
  parentIssueId: string | null;
  parentUpdatedAt: string | null;
  relations: IssueRelationSnapshot[];
  relationChanges: IssueRelationChange[];
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
  parentIssueId?: string | null;
};

export type IssueRelationCreateInput = {
  issueId: string;
  relatedIssueId: string;
  type: string;
};

export type IssueQuery = {
  assignedToViewer?: boolean;
  teamName?: string;
  includeArchived?: boolean;
  includeLabels?: boolean;
  includeExternalLinks?: boolean;
  includeRelationships?: boolean;
  excludeCompleted?: boolean;
};

export interface LinearWorkspace {
  readonly key: WorkspaceKey;
  readonly viewerId: string;
  readonly viewerEmail: string;

  listIssues(query: IssueQuery): Promise<LinearIssue[]>;
  getIssue(issueId: string, includeArchived?: boolean, includeRelationships?: boolean): Promise<LinearIssue | null>;
  listStatusNames(teamName: string): Promise<Set<string>>;
  createIssue(input: IssueCreateInput, teamName: string): Promise<LinearIssue>;
  updateIssue(issueId: string, update: IssueUpdate): Promise<LinearIssue>;
  createIssueRelation(input: IssueRelationCreateInput): Promise<IssueRelationSnapshot>;
  deleteIssueRelation(relationId: string): Promise<void>;
  restoreIssue(issueId: string): Promise<LinearIssue>;
  ensureLabel(text: string): Promise<void>;
  addLabel(issueId: string, text: string): Promise<void>;
  removeLabel(issueId: string, text: string): Promise<void>;
  addPersonalLink(issueId: string, targetUrl: string, title: string): Promise<void>;
  addPersonalNotification(issueId: string, message: string): Promise<void>;
}
