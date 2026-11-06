import type { ProjectMappingRecord } from "./domain.js";
import type { LinearWorkspace, ProjectRelation, ProjectRelationInput } from "./linear.js";
import { SyncState } from "./state.js";
import { logEvent } from "./log.js";

type Saved = {
  input: ProjectRelationInput;
  externalProjectId: string;
  externalRelatedProjectId: string;
  personal?: ProjectRelation;
  external?: ProjectRelation;
  personalManaged: boolean;
  externalManaged: boolean;
};

type Entry = { input: ProjectRelationInput; personal?: ProjectRelation; external?: ProjectRelation; previous?: Saved };

export async function syncProjectRelationships(
  personal: LinearWorkspace,
  external: LinearWorkspace,
  state: SyncState,
  workspace: string,
  personalRelations: ProjectRelation[],
): Promise<void> {
  const mappings: ProjectMappingRecord[] = [];
  const projectVersions = new Map<string, { personal: string; external: string }>();
  for (const mapping of state.listProjectMappings()) {
    if (!mapping.active || mapping.externalWorkspaceKey !== workspace) continue;
    const [left, right] = await Promise.all([
      personal.getProject(mapping.personalProjectId, true), external.getProject(mapping.externalProjectId, true),
    ]);
    if (left && right && !left.archived && !right.archived) {
      mappings.push(mapping);
      projectVersions.set(mapping.personalProjectId, { personal: left.updatedAt, external: right.updatedAt });
    }
  }
  if (mappings.length < 2) return;
  const byPersonal = new Map(mappings.map((m) => [m.personalProjectId, m]));
  const byExternal = new Map(mappings.map((m) => [m.externalProjectId, m]));
  const milestones = state.listMilestoneMappings(workspace).filter((m) => m.active && !m.broken && !m.conflict);
  const milestonePersonal = new Map(milestones.map((m) => [m.personalMilestoneId, m]));
  const milestoneExternal = new Map(milestones.map((m) => [m.externalMilestoneId, m]));
  const normalize = (relation: ProjectRelation, side: "personal" | "external"): ProjectRelationInput | undefined => {
    const source = (side === "personal" ? byPersonal : byExternal).get(relation.projectId);
    const target = (side === "personal" ? byPersonal : byExternal).get(relation.relatedProjectId);
    if (!source || !target) return;
    const milestoneMap = side === "personal" ? milestonePersonal : milestoneExternal;
    const sourceMilestone = relation.projectMilestoneId ? milestoneMap.get(relation.projectMilestoneId) : undefined;
    const targetMilestone = relation.relatedProjectMilestoneId ? milestoneMap.get(relation.relatedProjectMilestoneId) : undefined;
    if ((relation.projectMilestoneId && (!sourceMilestone || sourceMilestone.personalProjectId !== source.personalProjectId))
      || (relation.relatedProjectMilestoneId && (!targetMilestone || targetMilestone.personalProjectId !== target.personalProjectId))) return;
    return { projectId: source.personalProjectId, relatedProjectId: target.personalProjectId, type: relation.type,
      anchorType: relation.anchorType, relatedAnchorType: relation.relatedAnchorType,
      ...(sourceMilestone ? { projectMilestoneId: sourceMilestone.personalMilestoneId } : {}),
      ...(targetMilestone ? { relatedProjectMilestoneId: targetMilestone.personalMilestoneId } : {}) };
  };
  const keyFor = (input: ProjectRelationInput) => JSON.stringify([input.projectId, input.relatedProjectId, input.type,
    input.anchorType, input.relatedAnchorType, input.projectMilestoneId ?? null, input.relatedProjectMilestoneId ?? null]);
  const entries = new Map<string, Entry>();
  for (const [side, relations] of [["personal", personalRelations], ["external", await external.listProjectRelations()]] as const) {
    for (const relation of relations) {
      const input = normalize(relation, side);
      if (!input) continue;
      const key = keyFor(input);
      const entry = entries.get(key) ?? { input };
      entry[side] = relation;
      entries.set(key, entry);
    }
  }
  for (const row of state.listProjectRelationshipStates(workspace)) {
    const previous = JSON.parse(row.value) as Saved;
    if (byPersonal.get(previous.input.projectId)?.externalProjectId !== previous.externalProjectId
      || byPersonal.get(previous.input.relatedProjectId)?.externalProjectId !== previous.externalRelatedProjectId) continue;
    const sourceMilestone = previous.input.projectMilestoneId && milestonePersonal.get(previous.input.projectMilestoneId);
    const targetMilestone = previous.input.relatedProjectMilestoneId && milestonePersonal.get(previous.input.relatedProjectMilestoneId);
    if ((previous.input.projectMilestoneId && (!sourceMilestone || sourceMilestone.personalProjectId !== previous.input.projectId))
      || (previous.input.relatedProjectMilestoneId && (!targetMilestone || targetMilestone.personalProjectId !== previous.input.relatedProjectId))) continue;
    const entry = entries.get(row.key) ?? { input: previous.input };
    entry.previous = previous;
    entries.set(row.key, entry);
  }
  const errors: unknown[] = [];
  for (const [key, entry] of entries) {
    try {
      let { personal: left, external: right } = entry;
      const previous = entry.previous;
      let personalManaged = previous?.personalManaged ?? false;
      let externalManaged = previous?.externalManaged ?? false;
      const leftChanged = previous ? Boolean(left) !== Boolean(previous.personal) || Boolean(left && previous.personal && left.updatedAt !== previous.personal.updatedAt) : false;
      const rightChanged = previous ? Boolean(right) !== Boolean(previous.external) || Boolean(right && previous.external && right.updatedAt !== previous.external.updatedAt) : false;
      if (leftChanged) personalManaged = false;
      if (rightChanged) externalManaged = false;
      let winner: "personal" | "external" | undefined;
      if (!previous && Boolean(left) !== Boolean(right)) winner = left ? "personal" : "external";
      else if (previous && (leftChanged || rightChanged)) {
        if (leftChanged && rightChanged) winner = (left?.updatedAt ?? projectVersions.get(entry.input.projectId)?.personal ?? "") >= (right?.updatedAt ?? projectVersions.get(entry.input.projectId)?.external ?? "") ? "personal" : "external";
        else winner = leftChanged ? "personal" : "external";
      }
      const externalInput: ProjectRelationInput = { ...entry.input,
        projectId: byPersonal.get(entry.input.projectId)!.externalProjectId,
        relatedProjectId: byPersonal.get(entry.input.relatedProjectId)!.externalProjectId,
        ...(entry.input.projectMilestoneId ? { projectMilestoneId: milestonePersonal.get(entry.input.projectMilestoneId)!.externalMilestoneId } : {}),
        ...(entry.input.relatedProjectMilestoneId ? { relatedProjectMilestoneId: milestonePersonal.get(entry.input.relatedProjectMilestoneId)!.externalMilestoneId } : {}),
      };
      if (winner === "personal" && left && !right) { right = await external.createProjectRelation(externalInput); externalManaged = true; }
      else if (winner === "external" && right && !left) { left = await personal.createProjectRelation(entry.input); personalRelations.push(left); personalManaged = true; }
      else if (winner === "personal" && !left && right && externalManaged) { await external.deleteProjectRelation(right.id); right = undefined; externalManaged = false; }
      else if (winner === "external" && !right && left && personalManaged) { await personal.deleteProjectRelation(left.id); const index = personalRelations.findIndex((relation) => relation.id === left!.id); if (index >= 0) personalRelations.splice(index, 1); left = undefined; personalManaged = false; }
      state.putProjectRelationshipState(workspace, key, JSON.stringify({ input: entry.input, externalProjectId: externalInput.projectId, externalRelatedProjectId: externalInput.relatedProjectId, personal: left, external: right, personalManaged, externalManaged } satisfies Saved));
    } catch (error: unknown) {
      errors.push(error);
      logEvent("project_relationship_sync_failure", {
        level: "error", workspace, projectId: entry.input.projectId,
        relatedProjectId: entry.input.relatedProjectId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (typeof error === "object" && error !== null && "status" in error && error.status === 429) break;
    }
  }
  if (errors.length) throw errors[0];
}
