import type { LinearIssue, LinearWorkspace } from "./linear.js";
import type { IssueRelationSnapshot, MappingRecord } from "./domain.js";
import { logEvent } from "./log.js";
import { SyncState } from "./state.js";

type MappedIssue = {
  mapping: MappingRecord;
  personal: LinearIssue;
  external: LinearIssue;
};

type RelationEntry = {
  personalIssueId: string;
  personalRelatedIssueId: string;
  relationType: string;
  personal?: IssueRelationSnapshot;
  external?: IssueRelationSnapshot;
};

type Side = "personal" | "external";

export class RelationshipSynchronizer {
  public constructor(
    private readonly personal: LinearWorkspace,
    private readonly external: LinearWorkspace,
    private readonly state: SyncState,
    private readonly externalWorkspaceKey: string,
  ) {}

  public async run(
    personalIssues: Map<string, LinearIssue>,
    externalIssues: Map<string, LinearIssue>,
  ): Promise<void> {
    const errors: unknown[] = [];
    const mappedIssues = await this.loadMappedIssues(personalIssues, externalIssues, errors);
    const personalById = new Map(mappedIssues.map((item) => [item.personal.id, item]));
    const externalById = new Map(mappedIssues.map((item) => [item.external.id, item]));
    await this.syncNativeRelations(mappedIssues, personalById, externalById, errors);
    await this.syncParents(mappedIssues, personalById, externalById, errors);
    if (errors.length > 0) throw errors[0];
  }

  private async loadMappedIssues(
    personalIssues: Map<string, LinearIssue>,
    externalIssues: Map<string, LinearIssue>,
    errors: unknown[],
  ): Promise<MappedIssue[]> {
    const mapped: MappedIssue[] = [];
    for (const mapping of this.state.listMappings()) {
      if (!mapping.active || mapping.externalWorkspaceKey !== this.externalWorkspaceKey) continue;
      try {
        const personal = await this.personal.getIssue(mapping.personalIssueId, true, true)
          ?? personalIssues.get(mapping.personalIssueId);
        const external = await this.external.getIssue(mapping.externalIssueId, true, true)
          ?? externalIssues.get(mapping.externalIssueId);
        if (!personal || personal.archived || !external || external.archived) continue;
        mapped.push({ mapping, personal, external });
      } catch (error: unknown) {
        errors.push(error);
        this.recordFailure(mapping.personalIssueId, error);
      }
    }
    return mapped;
  }

  private async syncNativeRelations(
    mappedIssues: MappedIssue[],
    personalById: Map<string, MappedIssue>,
    externalById: Map<string, MappedIssue>,
    errors: unknown[],
  ): Promise<void> {
    const entries = new Map<string, RelationEntry>();
    for (const item of mappedIssues) {
      for (const relation of item.personal.relations) {
        const source = personalById.get(relation.issueId);
        const related = personalById.get(relation.relatedIssueId);
        if (!source || !related) continue;
        const key = this.relationKey(source.personal.id, related.personal.id, relation.type);
        const entry = entries.get(key) ?? {
          personalIssueId: source.personal.id,
          personalRelatedIssueId: related.personal.id,
          relationType: relation.type,
        };
        entry.personal = relation;
        entries.set(key, entry);
      }
      for (const relation of item.external.relations) {
        const source = externalById.get(relation.issueId);
        const related = externalById.get(relation.relatedIssueId);
        if (!source || !related) continue;
        const key = this.relationKey(source.personal.id, related.personal.id, relation.type);
        const entry = entries.get(key) ?? {
          personalIssueId: source.personal.id,
          personalRelatedIssueId: related.personal.id,
          relationType: relation.type,
        };
        entry.external = relation;
        entries.set(key, entry);
      }
    }
    for (const snapshot of this.state.listRelationshipStates(this.externalWorkspaceKey)) {
      const key = this.relationKey(snapshot.personalIssueId, snapshot.personalRelatedIssueId, snapshot.relationType);
      if (!entries.has(key) && personalById.has(snapshot.personalIssueId) && personalById.has(snapshot.personalRelatedIssueId)) {
        entries.set(key, {
          personalIssueId: snapshot.personalIssueId,
          personalRelatedIssueId: snapshot.personalRelatedIssueId,
          relationType: snapshot.relationType,
        });
      }
    }

    for (const entry of entries.values()) {
      const failureId = this.relationKey(entry.personalIssueId, entry.personalRelatedIssueId, entry.relationType);
      try {
        await this.syncNativeRelation(entry, personalById, externalById);
        this.state.clearFailure(this.failureScope(), failureId);
      } catch (error: unknown) {
        errors.push(error);
        this.recordFailure(failureId, error);
      }
    }
  }

  private async syncNativeRelation(
    entry: RelationEntry,
    personalById: Map<string, MappedIssue>,
    externalById: Map<string, MappedIssue>,
  ): Promise<void> {
    const personalSource = personalById.get(entry.personalIssueId)!;
    const personalTarget = personalById.get(entry.personalRelatedIssueId)!;
    const externalSource = externalById.get(personalSource.external.id)!;
    const externalTarget = externalById.get(personalTarget.external.id)!;
    const previous = this.state.getRelationshipState(
      this.externalWorkspaceKey,
      entry.personalIssueId,
      entry.personalRelatedIssueId,
      entry.relationType,
    );
    let personalPresent = Boolean(entry.personal);
    let externalPresent = Boolean(entry.external);
    let personalUpdatedAt = entry.personal?.updatedAt
      ?? this.missingRelationTimestamp(personalSource.personal, personalTarget.personal);
    let externalUpdatedAt = entry.external?.updatedAt
      ?? this.missingRelationTimestamp(externalSource.external, externalTarget.external);
    let personalManaged = previous?.personalManaged ?? false;
    let externalManaged = previous?.externalManaged ?? false;

    const personalChanged = previous
      ? this.changed(personalPresent, personalUpdatedAt, previous.personalPresent, previous.personalUpdatedAt)
      : false;
    const externalChanged = previous
      ? this.changed(externalPresent, externalUpdatedAt, previous.externalPresent, previous.externalUpdatedAt)
      : false;
    if (personalChanged) personalManaged = false;
    if (externalChanged) externalManaged = false;

    let winner: Side | undefined;
    if (!previous) {
      if (personalPresent !== externalPresent) {
        winner = personalPresent ? "personal" : "external";
      } else if (personalPresent && externalPresent) {
        winner = this.latestSide(personalUpdatedAt, externalUpdatedAt);
      }
    } else if (personalChanged || externalChanged) {
      winner = personalChanged && externalChanged
        ? this.latestSide(personalUpdatedAt, externalUpdatedAt)
        : personalChanged ? "personal" : "external";
    }

    if (winner === "personal" && personalPresent !== externalPresent) {
      if (personalPresent && !externalPresent) {
        const created = await this.external.createIssueRelation({
          issueId: externalSource.external.id,
          relatedIssueId: externalTarget.external.id,
          type: entry.relationType,
        });
        externalPresent = true;
        externalUpdatedAt = created.updatedAt;
        externalManaged = true;
        externalSource.external.relations.push(created);
      } else if (!personalPresent && externalPresent && externalManaged && entry.external) {
        await this.external.deleteIssueRelation(entry.external.id);
        externalPresent = false;
        externalUpdatedAt = externalSource.external.updatedAt;
        externalManaged = false;
        externalSource.external.relations = externalSource.external.relations.filter((relation) => relation.id !== entry.external!.id);
      }
    } else if (winner === "external" && personalPresent !== externalPresent) {
      if (externalPresent && !personalPresent) {
        const created = await this.personal.createIssueRelation({
          issueId: personalSource.personal.id,
          relatedIssueId: personalTarget.personal.id,
          type: entry.relationType,
        });
        personalPresent = true;
        personalUpdatedAt = created.updatedAt;
        personalManaged = true;
        personalSource.personal.relations.push(created);
      } else if (!externalPresent && personalPresent && personalManaged && entry.personal) {
        await this.personal.deleteIssueRelation(entry.personal.id);
        personalPresent = false;
        personalUpdatedAt = personalSource.personal.updatedAt;
        personalManaged = false;
        personalSource.personal.relations = personalSource.personal.relations.filter((relation) => relation.id !== entry.personal!.id);
      }
    }

    this.state.putRelationshipState({
      externalWorkspaceKey: this.externalWorkspaceKey,
      personalIssueId: entry.personalIssueId,
      personalRelatedIssueId: entry.personalRelatedIssueId,
      relationType: entry.relationType,
      personalPresent,
      externalPresent,
      personalUpdatedAt,
      externalUpdatedAt,
      personalManaged,
      externalManaged,
    });
  }

  private async syncParents(
    mappedIssues: MappedIssue[],
    personalById: Map<string, MappedIssue>,
    externalById: Map<string, MappedIssue>,
    errors: unknown[],
  ): Promise<void> {
    for (const child of mappedIssues) {
      try {
        const personalParent = child.personal.parentIssueId
          ? personalById.get(child.personal.parentIssueId)
          : undefined;
        const externalParent = child.external.parentIssueId
          ? externalById.get(child.external.parentIssueId)
          : undefined;
        if ((child.personal.parentIssueId && !personalParent) || (child.external.parentIssueId && !externalParent)) {
          continue;
        }
        const personalParentId = personalParent?.personal.id ?? null;
        const externalParentId = externalParent?.mapping.externalIssueId ?? null;
        const externalParentPersonalId = externalParent?.mapping.personalIssueId ?? null;
        const previous = this.state.getParentState(this.externalWorkspaceKey, child.personal.id);
        const personalUpdatedAt = child.personal.parentUpdatedAt;
        const externalUpdatedAt = child.external.parentUpdatedAt;
        const personalChanged = previous
          ? this.parentChanged(personalParentId, personalUpdatedAt, previous.personalParentIssueId, previous.personalUpdatedAt)
          : false;
        const externalChanged = previous
          ? this.parentChanged(externalParentId, externalUpdatedAt, previous.externalParentIssueId, previous.externalUpdatedAt)
          : false;
        let personalManaged = previous?.personalManaged ?? false;
        let externalManaged = previous?.externalManaged ?? false;
        if (personalChanged) personalManaged = false;
        if (externalChanged) externalManaged = false;

        let winner: Side | undefined;
        if (!previous) {
          if (personalParentId !== externalParentPersonalId) {
            winner = personalParentId && !externalParentPersonalId
              ? "personal"
              : !personalParentId && externalParentPersonalId
                ? "external"
                : this.latestSide(personalUpdatedAt, externalUpdatedAt);
          }
        } else if (personalChanged || externalChanged) {
          winner = personalChanged && externalChanged
            ? this.latestSide(personalUpdatedAt, externalUpdatedAt)
            : personalChanged ? "personal" : "external";
        }

        let desiredPersonalParentId = personalParentId;
        let desiredExternalParentId = externalParentId;
        if (winner === "personal") {
          desiredPersonalParentId = personalParentId;
          desiredExternalParentId = personalParentId
            ? personalById.get(personalParentId)!.mapping.externalIssueId
            : null;
        } else if (winner === "external") {
          desiredExternalParentId = externalParentId;
          desiredPersonalParentId = externalParentId
            ? externalById.get(externalParentId)!.mapping.personalIssueId
            : null;
        }

        if (winner && desiredPersonalParentId !== personalParentId
          && (desiredPersonalParentId !== null || personalManaged)) {
          const updated = await this.personal.updateIssue(child.personal.id, {
            parentIssueId: desiredPersonalParentId,
          });
          Object.assign(child.personal, updated);
          personalManaged = desiredPersonalParentId !== null;
        }
        if (winner && desiredExternalParentId !== externalParentId
          && (desiredExternalParentId !== null || externalManaged)) {
          const updated = await this.external.updateIssue(child.external.id, {
            parentIssueId: desiredExternalParentId,
          });
          Object.assign(child.external, updated);
          externalManaged = desiredExternalParentId !== null;
        }

        this.state.putParentState({
          externalWorkspaceKey: this.externalWorkspaceKey,
          personalIssueId: child.personal.id,
          personalParentIssueId: child.personal.parentIssueId
            ? personalById.get(child.personal.parentIssueId)?.personal.id ?? null
            : null,
          externalParentIssueId: child.external.parentIssueId,
          personalUpdatedAt: child.personal.parentUpdatedAt,
          externalUpdatedAt: child.external.parentUpdatedAt,
          personalManaged,
          externalManaged,
        });
        this.state.clearFailure(this.failureScope(), child.personal.id);
      } catch (error: unknown) {
        errors.push(error);
        this.recordFailure(child.personal.id, error);
      }
    }
  }

  private failureScope(): string {
    return `relationship:${this.externalWorkspaceKey}`;
  }

  private recordFailure(issueId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const count = this.state.recordFailure(this.failureScope(), issueId, message);
    logEvent("relationship_sync_failure", {
      level: "error",
      workspace: this.externalWorkspaceKey,
      issueId,
      count,
      error: message,
    });
  }

  private relationKey(personalIssueId: string, personalRelatedIssueId: string, relationType: string): string {
    return `${personalIssueId}\u0000${personalRelatedIssueId}\u0000${relationType}`;
  }

  private changed(
    present: boolean,
    updatedAt: string | null,
    previousPresent: boolean,
    previousUpdatedAt: string | null,
  ): boolean {
    if (present !== previousPresent) return true;
    return present && updatedAt !== previousUpdatedAt && Boolean(updatedAt || previousUpdatedAt);
  }

  private parentChanged(
    parentIssueId: string | null,
    updatedAt: string | null,
    previousParentIssueId: string | null,
    previousUpdatedAt: string | null,
  ): boolean {
    if (parentIssueId !== previousParentIssueId) return true;
    return updatedAt !== previousUpdatedAt && Boolean(updatedAt || previousUpdatedAt);
  }

  private latestSide(personalUpdatedAt: string | null, externalUpdatedAt: string | null): Side {
    if (!personalUpdatedAt && !externalUpdatedAt) return "personal";
    if (!externalUpdatedAt) return "personal";
    if (!personalUpdatedAt) return "external";
    return personalUpdatedAt >= externalUpdatedAt ? "personal" : "external";
  }

  private missingRelationTimestamp(source: LinearIssue, target: LinearIssue): string | null {
    const changes = [
      ...source.relationChanges.filter((change) => change.action === "removed" && change.relatedIdentifier === target.identifier),
      ...target.relationChanges.filter((change) => change.action === "removed" && change.relatedIdentifier === source.identifier),
    ];
    return changes.map((change) => change.updatedAt).sort().at(-1) ?? source.updatedAt;
  }
}
