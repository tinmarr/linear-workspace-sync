type SyncKey = string & { readonly __syncKey: unique symbol };

const SEPARATOR = "\u0000";

function buildKey(...parts: string[]): SyncKey {
  return parts.join(SEPARATOR) as SyncKey;
}

export function issueMappingKey(externalWorkspaceKey: string, externalIssueId: string): SyncKey {
  return buildKey("issue", externalWorkspaceKey, externalIssueId);
}

export function projectMappingKey(externalWorkspaceKey: string, externalProjectId: string): SyncKey {
  return buildKey("project", externalWorkspaceKey, externalProjectId);
}

export function projectPairKey(
  externalWorkspaceKey: string,
  personalProjectId: string,
  externalProjectId: string,
): SyncKey {
  return buildKey(externalWorkspaceKey, personalProjectId, externalProjectId);
}

export function projectMilestoneCacheKey(projectId: string, includeArchived: boolean): SyncKey {
  return buildKey(projectId, includeArchived ? "archived" : "active");
}

export function relationshipKey(
  personalIssueId: string,
  personalRelatedIssueId: string,
  relationType: string,
): SyncKey {
  return buildKey(personalIssueId, personalRelatedIssueId, relationType);
}
