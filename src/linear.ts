import type {
  IssueRelationChange,
  IssueRelationSnapshot,
  IssueSnapshot,
  MilestoneSnapshot,
  ProjectSnapshot,
  ProjectStatus,
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

export type LinearMilestone = MilestoneSnapshot;

export type ExternalProjectLink = {
  workspaceKey: WorkspaceKey;
  projectId: string;
  projectUrl: string;
};

export type LinearProject = ProjectSnapshot & {
  externalLinks: ExternalProjectLink[];
};

export type IssueCreateInput = {
  title: string;
  description: string | null;
  statusName: string | null;
  dueDate: string | null;
  estimate: number | null;
  priority: number;
  assigneeEmail?: string | null;
  projectId?: string | null;
  projectMilestoneId?: string | null;
};

export type IssueUpdate = Partial<
  Pick<
    IssueSnapshot,
    "title" | "description" | "statusName" | "dueDate" | "estimate" | "priority"
  >
> & {
  assigneeEmail?: string | null;
  parentIssueId?: string | null;
  projectId?: string | null;
  projectMilestoneId?: string | null;
};

export type ProjectCreateInput = {
  name: string;
  description: string | null;
  statusName: string | null;
  priority: number;
  startDate: string | null;
  targetDate: string | null;
  leadAssigned: boolean;
  memberAssigned: boolean;
};

export type ProjectUpdate = Partial<Pick<
  ProjectSnapshot,
  "name" | "description" | "statusName" | "priority" | "startDate" | "targetDate"
>> & {
  leadAssigned?: boolean;
  memberAssigned?: boolean;
};

export type MilestoneCreateInput = Pick<
  MilestoneSnapshot,
  "projectId" | "name" | "description" | "targetDate" | "sortOrder"
>;

export type MilestoneUpdate = Partial<Pick<
  MilestoneSnapshot,
  "projectId" | "name" | "description" | "targetDate" | "sortOrder"
>>;

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

export type ProjectQuery = {
  teamName?: string;
  includeArchived?: boolean;
  includeLabels?: boolean;
  includeExternalLinks?: boolean;
};

export interface LinearWorkspace {
  readonly key: WorkspaceKey;
  readonly viewerId: string;
  readonly viewerEmail: string;

  listIssues(query: IssueQuery): Promise<LinearIssue[]>;
  getIssue(issueId: string, includeArchived?: boolean, includeRelationships?: boolean): Promise<LinearIssue | null>;
  listProjects(query: ProjectQuery): Promise<LinearProject[]>;
  getProject(projectId: string, includeArchived?: boolean): Promise<LinearProject | null>;
  listProjectStatuses(): Promise<ProjectStatus[]>;
  listStatusNames(teamName: string): Promise<Set<string>>;
  createIssue(input: IssueCreateInput, teamName: string): Promise<LinearIssue>;
  updateIssue(issueId: string, update: IssueUpdate): Promise<LinearIssue>;
  createProject(input: ProjectCreateInput, teamName: string): Promise<LinearProject>;
  updateProject(projectId: string, update: ProjectUpdate): Promise<LinearProject>;
  listProjectMilestones(projectId: string, includeArchived?: boolean): Promise<LinearMilestone[]>;
  getProjectMilestone(milestoneId: string, includeArchived?: boolean): Promise<LinearMilestone | null>;
  createProjectMilestone(input: MilestoneCreateInput): Promise<LinearMilestone>;
  updateProjectMilestone(milestoneId: string, update: MilestoneUpdate): Promise<LinearMilestone>;
  deleteProjectMilestone(milestoneId: string): Promise<void>;
  createIssueRelation(input: IssueRelationCreateInput): Promise<IssueRelationSnapshot>;
  deleteIssueRelation(relationId: string): Promise<void>;
  restoreIssue(issueId: string): Promise<LinearIssue>;
  ensureLabel(text: string): Promise<void>;
  addLabel(issueId: string, text: string): Promise<void>;
  removeLabel(issueId: string, text: string): Promise<void>;
  addPersonalLink(issueId: string, targetUrl: string, title: string): Promise<void>;
  addPersonalNotification(issueId: string, message: string): Promise<void>;
  ensureProjectLabel(text: string): Promise<void>;
  addProjectLabel(projectId: string, text: string): Promise<void>;
  removeProjectLabel(projectId: string, text: string): Promise<void>;
  addPersonalProjectLink(projectId: string, targetUrl: string, title: string): Promise<void>;
  addPersonalProjectNotification(projectId: string, message: string): Promise<void>;
}
