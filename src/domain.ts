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

export const CORE_FIELDS: readonly CoreField[] = [
  "title",
  "description",
  "statusName",
  "dueDate",
  "estimate",
  "priority",
];
