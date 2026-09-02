export type WorkspaceKey = string;

export type IssueRelationSnapshot = {
  id: string;
  issueId: string;
  relatedIssueId: string;
  type: string;
  createdAt: string;
  updatedAt: string;
};

export type IssueRelationChange = {
  relatedIdentifier: string;
  action: "added" | "removed";
  updatedAt: string;
};

export type RelationshipSyncState = {
  externalWorkspaceKey: WorkspaceKey;
  personalIssueId: string;
  personalRelatedIssueId: string;
  relationType: string;
  personalPresent: boolean;
  externalPresent: boolean;
  personalUpdatedAt: string | null;
  externalUpdatedAt: string | null;
  personalManaged: boolean;
  externalManaged: boolean;
};

export type ParentSyncState = {
  externalWorkspaceKey: WorkspaceKey;
  personalIssueId: string;
  personalParentIssueId: string | null;
  externalParentIssueId: string | null;
  personalUpdatedAt: string | null;
  externalUpdatedAt: string | null;
  personalManaged: boolean;
  externalManaged: boolean;
};

export const DEFAULT_NOTIFICATION_ACCESS_TOKEN_ENV = "LINEAR_NOTIFICATION_ACCESS_TOKEN";

export type SyncLabelNames = {
  conflict: string;
  broken: string;
  externalUnavailable: string;
};

export type WorkspaceConfig = {
  key: WorkspaceKey;
  name: string;
  apiKeyEnv: string;
  workspaceName: string;
  workspaceSlug?: string;
  teamName: string;
  routingLabel?: string;
  personalLabels: string[];
  statusMappings: Record<string, string>;
};

export type AppConfig = {
  pollIntervalSeconds: number;
  databasePath: string;
  notificationAccessTokenEnv?: string;
  personal: WorkspaceConfig;
  external: WorkspaceConfig[];
  syncLabels: SyncLabelNames;
};

export type IssueSnapshot = {
  id: string;
  identifier: string;
  url: string;
  workspaceKey: WorkspaceKey;
  title: string;
  description: string | null;
  statusName: string;
  dueDate: string | null;
  estimate: number | null;
  priority: number;
  assigneeEmail: string | null;
  archived: boolean;
  labelNames: string[];
  projectId: string | null;
  projectMilestoneId: string | null;
};

export type ProjectStatus = {
  name: string;
  type: string;
};

export type ProjectSnapshot = {
  id: string;
  url: string;
  workspaceKey: WorkspaceKey;
  name: string;
  description: string | null;
  statusName: string;
  statusType: string;
  priority: number;
  startDate: string | null;
  targetDate: string | null;
  leadAssigned: boolean;
  memberAssigned: boolean;
  archived: boolean;
  labelNames: string[];
  updatedAt: string;
};

export type MilestoneSnapshot = {
  id: string;
  projectId: string;
  workspaceKey: WorkspaceKey;
  name: string;
  description: string | null;
  targetDate: string | null;
  sortOrder: number;
  archived: boolean;
  updatedAt: string;
};

export type MilestoneMappingRecord = {
  personalProjectId: string;
  externalWorkspaceKey: WorkspaceKey;
  externalProjectId: string;
  personalMilestoneId: string;
  externalMilestoneId: string;
  active: boolean;
  conflict: boolean;
  broken: boolean;
};

export type MilestoneSnapshotPair = {
  personal: MilestoneSnapshot;
  external: MilestoneSnapshot;
};

export type ProjectMappingRecord = {
  personalProjectId: string;
  externalWorkspaceKey: WorkspaceKey;
  externalProjectId: string;
  personalProjectUrl: string;
  externalProjectUrl: string;
  active: boolean;
  conflict: boolean;
  broken: boolean;
};

export type ProjectMembershipSyncState = {
  externalWorkspaceKey: WorkspaceKey;
  personalIssueId: string;
  personalProjectId: string | null;
  externalProjectId: string | null;
  personalMilestoneId: string | null;
  externalMilestoneId: string | null;
  personalUpdatedAt: string | null;
  externalUpdatedAt: string | null;
  personalManaged: boolean;
  externalManaged: boolean;
};

export type MappingRecord = {
  personalIssueId: string;
  externalWorkspaceKey: WorkspaceKey;
  externalIssueId: string;
  personalIssueUrl: string;
  externalIssueUrl: string;
  active: boolean;
  conflict: boolean;
  broken: boolean;
};

export type CoreField =
  | "title"
  | "description"
  | "statusName"
  | "dueDate"
  | "estimate"
  | "priority";

export type ProjectField =
  | "name"
  | "description"
  | "statusName"
  | "priority"
  | "startDate"
  | "targetDate"
  | "leadAssigned"
  | "memberAssigned";

export const CORE_FIELDS: readonly CoreField[] = [
  "title",
  "description",
  "statusName",
  "dueDate",
  "estimate",
  "priority",
];

export const PROJECT_FIELDS: readonly ProjectField[] = [
  "name",
  "description",
  "statusName",
  "priority",
  "startDate",
  "targetDate",
  "leadAssigned",
  "memberAssigned",
];

export type MilestoneField = "name" | "description" | "targetDate" | "sortOrder";

export const MILESTONE_FIELDS: readonly MilestoneField[] = [
  "name",
  "description",
  "targetDate",
  "sortOrder",
];
