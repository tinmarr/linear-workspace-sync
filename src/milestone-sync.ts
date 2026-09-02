import type {
  MilestoneField,
  MilestoneMappingRecord,
  MilestoneSnapshot,
  MilestoneSnapshotPair,
  WorkspaceConfig,
  WorkspaceKey,
} from "./domain.js";
import { MILESTONE_FIELDS } from "./domain.js";
import type {
  LinearMilestone,
  LinearProject,
  LinearWorkspace,
  MilestoneCreateInput,
  MilestoneUpdate,
} from "./linear.js";
import { SyncState } from "./state.js";

export type MilestoneSyncResult = {
  conflicts: number;
  broken: number;
};

export type MilestoneWorkspacePair = {
  externalConfig: WorkspaceConfig;
  external: LinearWorkspace;
};

export type MilestoneSyncSignals = {
  markConflict: (project: LinearProject, externalWorkspaceKey: WorkspaceKey, fields: string[]) => Promise<void>;
  markBroken: (
    project: LinearProject,
    externalWorkspaceKey: WorkspaceKey,
    fingerprint: string,
    message: string,
  ) => Promise<void>;
};

type MilestoneLocation = {
  personalProjectId: string;
  externalProjectId: string;
};

export class MilestoneSynchronizer {
  public constructor(
    private readonly personal: LinearWorkspace,
    private readonly state: SyncState,
    private readonly signals: MilestoneSyncSignals,
  ) {}

  public async syncProject(
    personalProject: LinearProject,
    externalProject: LinearProject,
    pair: MilestoneWorkspacePair,
  ): Promise<MilestoneSyncResult> {
    const result = this.emptyResult();
    const [personalMilestones, externalMilestones] = await Promise.all([
      this.personal.listProjectMilestones(personalProject.id, true),
      pair.external.listProjectMilestones(externalProject.id, true),
    ]);
    const currentPersonal = new Map(
      personalMilestones.filter((milestone) => !milestone.archived).map((milestone) => [milestone.id, milestone]),
    );
    const currentExternal = new Map(
      externalMilestones.filter((milestone) => !milestone.archived).map((milestone) => [milestone.id, milestone]),
    );
    const handledPersonal = new Set<string>();
    const handledExternal = new Set<string>();
    const relevantMappings = this.state.listMilestoneMappings(pair.externalConfig.key).filter((mapping) =>
      mapping.personalProjectId === personalProject.id
      || mapping.externalProjectId === externalProject.id
      || currentPersonal.has(mapping.personalMilestoneId)
      || currentExternal.has(mapping.externalMilestoneId),
    );

    for (const mapping of relevantMappings) {
      const personalMilestone = currentPersonal.get(mapping.personalMilestoneId)
        ?? await this.personal.getProjectMilestone(mapping.personalMilestoneId, true);
      const externalMilestone = currentExternal.get(mapping.externalMilestoneId)
        ?? await pair.external.getProjectMilestone(mapping.externalMilestoneId, true);
      if (!mapping.active && (!personalMilestone || personalMilestone.archived || !externalMilestone || externalMilestone.archived)) {
        continue;
      }
      if (!personalMilestone || personalMilestone.archived || !externalMilestone || externalMilestone.archived) {
        if (personalMilestone) handledPersonal.add(personalMilestone.id);
        if (externalMilestone) handledExternal.add(externalMilestone.id);
        if (mapping.active) {
          if (personalMilestone && !personalMilestone.archived) {
            await this.personal.deleteProjectMilestone(personalMilestone.id);
          }
          if (externalMilestone && !externalMilestone.archived) {
            await pair.external.deleteProjectMilestone(externalMilestone.id);
          }
        }
        this.state.deleteMilestoneMapping(mapping.personalMilestoneId, pair.externalConfig.key);
        continue;
      }

      const location = await this.reconcileLocation(personalMilestone, externalMilestone, mapping, pair);
      if (!location) {
        if (mapping.active) {
          this.state.upsertMilestoneMapping({ ...mapping, active: false });
        }
        handledPersonal.add(personalMilestone.id);
        handledExternal.add(externalMilestone.id);
        continue;
      }

      const currentMapping: MilestoneMappingRecord = {
        ...mapping,
        personalProjectId: location.personalProjectId,
        externalProjectId: location.externalProjectId,
        active: true,
      };
      this.state.upsertMilestoneMapping(currentMapping);
      handledPersonal.add(personalMilestone.id);
      handledExternal.add(externalMilestone.id);
      const outcome = await this.syncMappedMilestone(
        personalMilestone,
        externalMilestone,
        currentMapping,
        pair,
        personalProject,
      );
      result.conflicts += outcome.conflicts;
      result.broken += outcome.broken;
    }

    const personalByName = this.groupUnmatchedByName(currentPersonal, handledPersonal);
    const externalByName = this.groupUnmatchedByName(currentExternal, handledExternal);
    const names = new Set([...personalByName.keys(), ...externalByName.keys()]);
    for (const name of names) {
      const personalCandidates = personalByName.get(name) ?? [];
      const externalCandidates = externalByName.get(name) ?? [];
      if (personalCandidates.length > 1 || externalCandidates.length > 1) {
        await this.signals.markBroken(
          personalProject,
          pair.externalConfig.key,
          `ambiguous-milestone-name:${name}`,
          `Multiple project milestones named ${name} prevent safe synchronization.`,
        );
        result.broken++;
        continue;
      }
      if (personalCandidates.length === 1 && externalCandidates.length === 1) {
        const outcome = await this.establishMapping(
          personalCandidates[0],
          externalCandidates[0],
          pair,
          personalProject,
        );
        result.conflicts += outcome.conflicts;
        result.broken += outcome.broken;
        continue;
      }
      if (personalCandidates.length === 1) {
        const externalMilestone = await pair.external.createProjectMilestone(
          this.toCreateInput(personalCandidates[0], externalProject.id),
        );
        const outcome = await this.establishMapping(
          personalCandidates[0],
          externalMilestone,
          pair,
          personalProject,
        );
        result.conflicts += outcome.conflicts;
        result.broken += outcome.broken;
        continue;
      }
      if (externalCandidates.length === 1) {
        const personalMilestone = await this.personal.createProjectMilestone(
          this.toCreateInput(externalCandidates[0], personalProject.id),
        );
        const outcome = await this.establishMapping(
          personalMilestone,
          externalCandidates[0],
          pair,
          personalProject,
        );
        result.conflicts += outcome.conflicts;
        result.broken += outcome.broken;
      }
    }
    return result;
  }

  private async establishMapping(
    personalMilestone: LinearMilestone,
    externalMilestone: LinearMilestone,
    pair: MilestoneWorkspacePair,
    personalProject: LinearProject,
  ): Promise<MilestoneSyncResult> {
    const result = this.emptyResult();
    const personalMapping = this.state.getMilestoneMapping(personalMilestone.id, pair.externalConfig.key);
    const externalMapping = this.state.findMilestoneMappingByExternal(pair.externalConfig.key, externalMilestone.id);
    if (
      (personalMapping && personalMapping.externalMilestoneId !== externalMilestone.id)
      || (externalMapping && externalMapping.personalMilestoneId !== personalMilestone.id)
    ) {
      await this.signals.markBroken(
        personalProject,
        pair.externalConfig.key,
        `milestone-mapping-collision:${personalMilestone.id}:${externalMilestone.id}`,
        `A project milestone is already mapped to a different counterpart.`,
      );
      result.broken++;
      return result;
    }
    const mapping: MilestoneMappingRecord = {
      personalProjectId: personalMilestone.projectId,
      externalWorkspaceKey: pair.externalConfig.key,
      externalProjectId: externalMilestone.projectId,
      personalMilestoneId: personalMilestone.id,
      externalMilestoneId: externalMilestone.id,
      active: true,
      conflict: false,
      broken: false,
    };
    this.state.upsertMilestoneMapping(mapping);
    const outcome = await this.syncMappedMilestone(
      personalMilestone,
      externalMilestone,
      mapping,
      pair,
      personalProject,
    );
    result.conflicts += outcome.conflicts;
    result.broken += outcome.broken;
    return result;
  }

  private async syncMappedMilestone(
    personalMilestone: LinearMilestone,
    externalMilestone: LinearMilestone,
    mapping: MilestoneMappingRecord,
    pair: MilestoneWorkspacePair,
    personalProject: LinearProject,
  ): Promise<MilestoneSyncResult> {
    const result = this.emptyResult();
    const previous = this.state.getMilestoneSnapshot(mapping.personalMilestoneId, pair.externalConfig.key);
    const current = {
      personal: this.toSnapshot(personalMilestone),
      external: this.toSnapshot(externalMilestone),
    } satisfies MilestoneSnapshotPair;
    if (!previous) {
      this.state.putMilestoneSnapshot(mapping.personalMilestoneId, pair.externalConfig.key, current);
      return result;
    }

    const conflicts = MILESTONE_FIELDS.filter((field) =>
      this.changedOnBothSides(field, previous, current)
      && current.personal[field] !== current.external[field],
    );
    if (conflicts.length > 0) {
      const fields = conflicts.map((field) => `milestone:${personalMilestone.name}:${field}`);
      await this.signals.markConflict(personalProject, pair.externalConfig.key, fields);
      this.state.upsertMilestoneMapping({ ...mapping, conflict: true });
      result.conflicts++;
      return result;
    }

    const personalChanges: MilestoneUpdate = {};
    const externalChanges: MilestoneUpdate = {};
    for (const field of MILESTONE_FIELDS) {
      const personalChanged = !this.fieldEqual(field, current.personal, previous.personal);
      const externalChanged = !this.fieldEqual(field, current.external, previous.external);
      if (personalChanged && !externalChanged) {
        Object.assign(externalChanges, { [field]: current.personal[field] });
      } else if (externalChanged && !personalChanged) {
        Object.assign(personalChanges, { [field]: current.external[field] });
      }
    }
    if (Object.keys(externalChanges).length > 0) {
      Object.assign(externalMilestone, await pair.external.updateProjectMilestone(externalMilestone.id, externalChanges));
    }
    if (Object.keys(personalChanges).length > 0) {
      Object.assign(personalMilestone, await this.personal.updateProjectMilestone(personalMilestone.id, personalChanges));
    }
    this.state.putMilestoneSnapshot(mapping.personalMilestoneId, pair.externalConfig.key, {
      personal: this.toSnapshot(personalMilestone),
      external: this.toSnapshot(externalMilestone),
    });
    this.state.upsertMilestoneMapping({ ...mapping, conflict: false, broken: false });
    return result;
  }

  private async reconcileLocation(
    personalMilestone: LinearMilestone,
    externalMilestone: LinearMilestone,
    mapping: MilestoneMappingRecord,
    pair: MilestoneWorkspacePair,
  ): Promise<MilestoneLocation | undefined> {
    const personalMoved = personalMilestone.projectId !== mapping.personalProjectId;
    const externalMoved = externalMilestone.projectId !== mapping.externalProjectId;
    const personalDestination = this.state.getProjectMapping(personalMilestone.projectId, pair.externalConfig.key);
    const externalDestination = this.state.findProjectMappingByExternal(pair.externalConfig.key, externalMilestone.projectId);
    if (personalMoved && !personalDestination?.active) return undefined;
    if (externalMoved && !externalDestination?.active) return undefined;
    const personalMapped = personalDestination?.active
      && personalDestination.externalProjectId === externalMilestone.projectId;
    const externalMapped = externalDestination?.active
      && externalDestination.personalProjectId === personalMilestone.projectId;
    if (personalMapped && externalMapped) {
      return {
        personalProjectId: personalMilestone.projectId,
        externalProjectId: externalMilestone.projectId,
      };
    }
    if (personalDestination?.active && externalDestination?.active) {
      if (personalMilestone.updatedAt >= externalMilestone.updatedAt) {
        const updatedExternal = await pair.external.updateProjectMilestone(externalMilestone.id, {
          projectId: personalDestination.externalProjectId,
        });
        Object.assign(externalMilestone, updatedExternal);
        return {
          personalProjectId: personalMilestone.projectId,
          externalProjectId: personalDestination.externalProjectId,
        };
      }
      const updatedPersonal = await this.personal.updateProjectMilestone(personalMilestone.id, {
        projectId: externalDestination.personalProjectId,
      });
      Object.assign(personalMilestone, updatedPersonal);
      return {
        personalProjectId: externalDestination.personalProjectId,
        externalProjectId: externalMilestone.projectId,
      };
    }
    if (personalDestination?.active) {
      const updatedExternal = await pair.external.updateProjectMilestone(externalMilestone.id, {
        projectId: personalDestination.externalProjectId,
      });
      Object.assign(externalMilestone, updatedExternal);
      return {
        personalProjectId: personalMilestone.projectId,
        externalProjectId: personalDestination.externalProjectId,
      };
    }
    if (externalDestination?.active) {
      const updatedPersonal = await this.personal.updateProjectMilestone(personalMilestone.id, {
        projectId: externalDestination.personalProjectId,
      });
      Object.assign(personalMilestone, updatedPersonal);
      return {
        personalProjectId: externalDestination.personalProjectId,
        externalProjectId: externalMilestone.projectId,
      };
    }
    if (mapping.personalProjectId === personalMilestone.projectId && mapping.externalProjectId === externalMilestone.projectId) {
      return {
        personalProjectId: personalMilestone.projectId,
        externalProjectId: externalMilestone.projectId,
      };
    }
    return undefined;
  }

  private groupUnmatchedByName(
    milestones: Map<string, LinearMilestone>,
    handled: Set<string>,
  ): Map<string, LinearMilestone[]> {
    const grouped = new Map<string, LinearMilestone[]>();
    for (const milestone of milestones.values()) {
      if (handled.has(milestone.id)) continue;
      const values = grouped.get(milestone.name) ?? [];
      values.push(milestone);
      grouped.set(milestone.name, values);
    }
    return grouped;
  }

  private toCreateInput(milestone: LinearMilestone, projectId: string): MilestoneCreateInput {
    return {
      projectId,
      name: milestone.name,
      description: milestone.description,
      targetDate: milestone.targetDate,
      sortOrder: milestone.sortOrder,
    };
  }

  private toSnapshot(milestone: LinearMilestone): MilestoneSnapshot {
    return {
      id: milestone.id,
      projectId: milestone.projectId,
      workspaceKey: milestone.workspaceKey,
      name: milestone.name,
      description: milestone.description,
      targetDate: milestone.targetDate,
      sortOrder: milestone.sortOrder,
      archived: milestone.archived,
      updatedAt: milestone.updatedAt,
    };
  }

  private changedOnBothSides(
    field: MilestoneField,
    previous: MilestoneSnapshotPair,
    current: MilestoneSnapshotPair,
  ): boolean {
    return !this.fieldEqual(field, current.personal, previous.personal)
      && !this.fieldEqual(field, current.external, previous.external);
  }

  private fieldEqual(field: MilestoneField, left: MilestoneSnapshot, right: MilestoneSnapshot): boolean {
    return left[field] === right[field];
  }

  private emptyResult(): MilestoneSyncResult {
    return { conflicts: 0, broken: 0 };
  }
}
