import type {
  AppConfig,
  ProjectField,
  ProjectMappingRecord,
  ProjectSnapshot,
  WorkspaceConfig,
  WorkspaceKey,
} from "./domain.js";
import { PROJECT_FIELDS as PROJECT_FIELD_NAMES } from "./domain.js";
import type {
  ExternalProjectLink,
  LinearIssue,
  LinearProject,
  LinearWorkspace,
  ProjectCreateInput,
  ProjectUpdate,
} from "./linear.js";
import { logEvent } from "./log.js";
import { SyncState } from "./state.js";

export type ProjectSyncResult = {
  createdInboundProjects: number;
  createdOutboundProjects: number;
  updatedMappings: number;
  conflicts: number;
  broken: number;
};

export type ProjectSyncContext = {
  personalProjects: Map<string, LinearProject>;
  processedMappingKeys: Set<string>;
  ignoredExternalProjectKeys: Set<string>;
};

export type ProjectWorkspacePair = {
  externalConfig: WorkspaceConfig;
  external: LinearWorkspace;
};

export class ProjectSynchronizer {
  public constructor(
    private readonly config: AppConfig,
    private readonly personal: LinearWorkspace,
    private readonly externals: Map<WorkspaceKey, LinearWorkspace>,
    private readonly state: SyncState,
  ) {}

  public async ensurePersonalLabels(): Promise<void> {
    for (const workspace of this.config.external) {
      if (workspace.routingLabel) await this.personal.ensureProjectLabel(workspace.routingLabel);
    }
    await this.personal.ensureProjectLabel(this.config.syncLabels.conflict);
    await this.personal.ensureProjectLabel(this.config.syncLabels.broken);
    await this.personal.ensureProjectLabel(this.config.syncLabels.externalUnavailable);
  }

  public async syncPersonalProjects(): Promise<{ context: ProjectSyncContext; result: ProjectSyncResult }> {
    const context: ProjectSyncContext = {
      personalProjects: new Map(),
      processedMappingKeys: new Set(),
      ignoredExternalProjectKeys: new Set(),
    };
    const result = this.emptyResult();
    const projects = await this.personal.listProjects({
      teamName: this.config.personal.teamName,
      includeArchived: false,
      includeLabels: true,
      includeExternalLinks: true,
    });
    for (const project of projects) {
      context.personalProjects.set(project.id, project);
      try {
        const outcome = await this.reconcilePersonalProject(project, context);
        this.addResult(result, outcome);
      } catch (error: unknown) {
        this.recordFailure(project.id, error);
      }
    }
    return { context, result };
  }

  public async ensureInboundProject(
    pair: ProjectWorkspacePair,
    externalProjectId: string,
    context: ProjectSyncContext,
  ): Promise<{ project: LinearProject | null; result: ProjectSyncResult }> {
    const result = this.emptyResult();
    const externalProject = await pair.external.getProject(externalProjectId, true);
    const projectKey = this.projectMappingKey(pair.externalConfig.key, externalProjectId);
    if (!externalProject || externalProject.archived) {
      context.ignoredExternalProjectKeys.add(projectKey);
      return { project: null, result };
    }
    const existing = this.state.findProjectMappingByExternal(pair.externalConfig.key, externalProject.id);
    if (existing) {
      const personalProject = context.personalProjects.get(existing.personalProjectId)
        ?? await this.personal.getProject(existing.personalProjectId, true);
      if (personalProject?.archived) {
        context.ignoredExternalProjectKeys.add(projectKey);
        return { project: null, result };
      }
      if (personalProject) {
        context.ignoredExternalProjectKeys.delete(projectKey);
        context.personalProjects.set(personalProject.id, personalProject);
        await this.ensurePersonalProjectLinkAndLabel(personalProject, pair, externalProject);
        const outcome = await this.processMapping(personalProject, pair, externalProject, false, context.processedMappingKeys);
        this.addResult(result, outcome);
        return { project: personalProject, result };
      }
    }

    const created = await this.createInboundPersonalProject(pair, externalProject);
    context.ignoredExternalProjectKeys.delete(projectKey);
    context.personalProjects.set(created.project.id, created.project);
    await this.ensurePersonalProjectLinkAndLabel(created.project, pair, externalProject);
    const replacementMapping: ProjectMappingRecord = {
      personalProjectId: created.project.id,
      externalWorkspaceKey: pair.externalConfig.key,
      externalProjectId: externalProject.id,
      personalProjectUrl: created.project.url,
      externalProjectUrl: externalProject.url,
      active: true,
      conflict: false,
      broken: false,
    };
    if (existing) {
      this.state.replaceProjectMapping(existing.personalProjectId, replacementMapping);
    } else {
      this.state.upsertProjectMapping(replacementMapping);
    }
    const outcome = await this.processMapping(created.project, pair, externalProject, true, context.processedMappingKeys);
    this.addResult(result, outcome);
    if (!created.statusMapped) {
      await this.markProjectBroken(
        created.project,
        pair.externalConfig.key,
        `unmapped-status:${externalProject.statusName}`,
        `No project status mapping exists for ${externalProject.statusName}.`,
      );
      result.broken++;
    }
    result.createdInboundProjects++;
    return { project: created.project, result };
  }

  public async syncMappedProjects(context: ProjectSyncContext): Promise<ProjectSyncResult> {
    const result = this.emptyResult();
    for (const mapping of this.state.listProjectMappings()) {
      if (!mapping.active) continue;
      const pair = this.getPair(mapping.externalWorkspaceKey);
      if (!pair) continue;
      const processedKey = this.projectMappingKey(mapping.externalWorkspaceKey, mapping.externalProjectId);
      if (context.processedMappingKeys.has(processedKey)) continue;
      const personalProject = context.personalProjects.get(mapping.personalProjectId)
        ?? await this.personal.getProject(mapping.personalProjectId, true);
      const externalProject = await pair.external.getProject(mapping.externalProjectId, true);
      if (personalProject?.archived || externalProject?.archived) continue;
      if (!personalProject || !externalProject) {
        if (personalProject) {
          await this.markProjectExternalUnavailable(personalProject, mapping);
          result.broken++;
        }
        continue;
      }
      context.personalProjects.set(personalProject.id, personalProject);
      try {
        const outcome = await this.processMapping(personalProject, pair, externalProject, false, context.processedMappingKeys);
        this.addResult(result, outcome);
        this.state.clearFailure(pair.externalConfig.key, externalProject.id);
      } catch (error: unknown) {
        this.recordFailure(mapping.personalProjectId, error);
      }
    }
    return result;
  }

  public async syncIssueProjectMembership(
    personalIssues: Map<string, LinearIssue>,
    externalIssues: Map<string, LinearIssue>,
    externalWorkspaceKey: WorkspaceKey,
  ): Promise<void> {
    const external = this.externals.get(externalWorkspaceKey);
    if (!external) return;
    for (const mapping of this.state.listMappings()) {
      if (!mapping.active || mapping.externalWorkspaceKey !== externalWorkspaceKey) continue;
      const personalIssue = personalIssues.get(mapping.personalIssueId)
        ?? await this.personal.getIssue(mapping.personalIssueId, true);
      const externalIssue = externalIssues.get(mapping.externalIssueId)
        ?? await external.getIssue(mapping.externalIssueId, true);
      if (!personalIssue || personalIssue.archived || !externalIssue || externalIssue.archived) continue;
      try {
        await this.syncIssueProjectRelation(personalIssue, externalIssue, externalWorkspaceKey);
      } catch (error: unknown) {
        this.recordFailure(`issue-project:${mapping.personalIssueId}`, error);
      }
    }
  }

  private async reconcilePersonalProject(
    personalProject: LinearProject,
    context: ProjectSyncContext,
  ): Promise<ProjectSyncResult> {
    const result = this.emptyResult();
    const links = personalProject.externalLinks;
    const linkedWorkspaces = new Set<WorkspaceKey>();
    for (const link of links) {
      if (linkedWorkspaces.has(link.workspaceKey)) {
        await this.markProjectBroken(personalProject, link.workspaceKey, "multiple-external-links", "Multiple external project links for one workspace make this mapping ambiguous.");
        result.broken++;
        continue;
      }
      linkedWorkspaces.add(link.workspaceKey);
      const pair = this.getPair(link.workspaceKey);
      if (!pair) {
        await this.markProjectBroken(personalProject, link.workspaceKey, "unknown-linked-workspace", "The linked external project workspace is not configured.");
        result.broken++;
        continue;
      }
      const externalProject = await pair.external.getProject(link.projectId, true);
      if (!externalProject || externalProject.archived) continue;
      const existing = this.state.findProjectMappingByExternal(pair.externalConfig.key, externalProject.id);
      if (existing && existing.personalProjectId !== personalProject.id) {
        await this.markProjectConflict(personalProject, pair.externalConfig.key, ["mapping"]);
        result.conflicts++;
        continue;
      }
      await this.ensurePersonalProjectLinkAndLabel(personalProject, pair, externalProject);
      this.state.upsertProjectMapping(this.toMapping(personalProject, pair.externalConfig, externalProject));
      const outcome = await this.processMapping(personalProject, pair, externalProject, false, context.processedMappingKeys);
      this.addResult(result, outcome);
      result.updatedMappings++;
    }

    const routingMatches = this.config.external.filter((workspace) =>
      workspace.routingLabel
      && personalProject.labelNames.includes(workspace.routingLabel)
      && !linkedWorkspaces.has(workspace.key),
    );
    for (const target of routingMatches) {
      const pair = this.getPair(target.key);
      if (!pair) {
        await this.markProjectBroken(personalProject, target.key, "missing-external-client", "The configured external project workspace is unavailable.");
        result.broken++;
        continue;
      }
      const existing = this.state.getProjectMapping(personalProject.id, target.key);
      if (existing) {
        const externalProject = await pair.external.getProject(existing.externalProjectId, true);
        if (!externalProject || externalProject.archived) continue;
        const outcome = await this.processMapping(personalProject, pair, externalProject, false, context.processedMappingKeys);
        this.addResult(result, outcome);
        result.updatedMappings++;
        continue;
      }

      const status = await this.projectStatusForCreation(personalProject, pair.external);
      const created = await pair.external.createProject({
        ...this.toCreateInput(personalProject),
        statusName: status.statusName,
      }, target.teamName);
      await this.ensurePersonalProjectLinkAndLabel(personalProject, pair, created);
      this.state.upsertProjectMapping(this.toMapping(personalProject, target, created));
      const outcome = await this.processMapping(personalProject, pair, created, true, context.processedMappingKeys);
      this.addResult(result, outcome);
      if (!status.mapped) {
        await this.markProjectBroken(
          personalProject,
          target.key,
          `unmapped-status:${personalProject.statusName}`,
          `No project status mapping exists for ${personalProject.statusName}.`,
        );
        result.broken++;
      }
      result.createdOutboundProjects++;
    }
    return result;
  }

  private async processMapping(
    personalProject: LinearProject,
    pair: ProjectWorkspacePair,
    externalProject: LinearProject,
    created: boolean,
    processedMappingKeys: Set<string>,
  ): Promise<ProjectSyncResult> {
    const result = this.emptyResult();
    await this.ensurePersonalProjectLinkAndLabel(personalProject, pair, externalProject);
    const mapping = this.state.getProjectMapping(personalProject.id, pair.externalConfig.key);
    if (!mapping) this.state.upsertProjectMapping(this.toMapping(personalProject, pair.externalConfig, externalProject));
    const currentPersonal = this.toSnapshot(personalProject);
    const currentExternal = this.toSnapshot(externalProject);
    const previous = this.state.getProjectSnapshot(personalProject.id, pair.externalConfig.key);
    if (!previous || created) {
      this.state.putProjectSnapshot(currentPersonal, pair.externalConfig.key);
      this.state.putProjectSnapshot(currentExternal, pair.externalConfig.key);
      processedMappingKeys.add(this.projectMappingKey(pair.externalConfig.key, externalProject.id));
      return result;
    }

    const statusErrors = await this.projectStatusMappingErrors(currentPersonal, currentExternal, pair);
    for (const statusError of statusErrors) {
      await this.markProjectBroken(
        personalProject,
        pair.externalConfig.key,
        `unmapped-status:${statusError}`,
        `No project status mapping exists for ${statusError}.`,
      );
      result.broken++;
    }

    const conflicts = PROJECT_FIELD_NAMES.filter((field) =>
      this.changedOnBothSides(field, previous, currentPersonal, currentExternal)
      && !this.projectValuesConverged(field, currentPersonal, currentExternal),
    );
    if (conflicts.length > 0) {
      await this.markProjectConflict(personalProject, pair.externalConfig.key, conflicts);
      processedMappingKeys.add(this.projectMappingKey(pair.externalConfig.key, externalProject.id));
      result.conflicts++;
      return result;
    }

    const personalChanges: ProjectUpdate = {};
    const externalChanges: ProjectUpdate = {};
    for (const field of PROJECT_FIELD_NAMES) {
      const personalChanged = !this.projectFieldEqual(field, currentPersonal, previous);
      const externalChanged = !this.projectFieldEqual(field, currentExternal, previous);
      if (personalChanged && !externalChanged) {
        const mapped = await this.mapProjectField(field, currentPersonal, pair.external);
        Object.assign(externalChanges, mapped);
      } else if (externalChanged && !personalChanged) {
        const mapped = await this.mapProjectField(field, currentExternal, this.personal);
        Object.assign(personalChanges, mapped);
      }
    }
    const externalStatusError = await this.validateProjectStatus(externalChanges.statusName, pair.external);
    if (externalStatusError) {
      await this.markProjectBroken(personalProject, pair.externalConfig.key, `unmapped-status:${externalStatusError}`, `No project status mapping exists for ${externalStatusError}.`);
      delete externalChanges.statusName;
      result.broken++;
    }
    const personalStatusError = await this.validateProjectStatus(personalChanges.statusName, this.personal);
    if (personalStatusError) {
      await this.markProjectBroken(personalProject, pair.externalConfig.key, `unmapped-status:${personalStatusError}`, `No project status mapping exists for ${personalStatusError}.`);
      delete personalChanges.statusName;
      result.broken++;
    }
    if (Object.keys(externalChanges).length > 0) Object.assign(externalProject, await pair.external.updateProject(externalProject.id, externalChanges));
    if (Object.keys(personalChanges).length > 0) Object.assign(personalProject, await this.personal.updateProject(personalProject.id, personalChanges));
    this.state.putProjectSnapshot(this.toSnapshot(personalProject), pair.externalConfig.key);
    this.state.putProjectSnapshot(this.toSnapshot(externalProject), pair.externalConfig.key);
    this.state.clearProjectConflict(personalProject.id, pair.externalConfig.key);
    await this.removeProjectLabelIfPresent(personalProject, this.config.syncLabels.conflict);
    this.state.clearProjectNotifications(personalProject.id, pair.externalConfig.key, "conflict");
    if (result.broken === 0) {
      await this.removeProjectLabelIfPresent(personalProject, this.config.syncLabels.broken);
      this.state.setProjectBroken(personalProject.id, pair.externalConfig.key, false);
    }
    processedMappingKeys.add(this.projectMappingKey(pair.externalConfig.key, externalProject.id));
    return result;
  }

  private async syncIssueProjectRelation(
    personalIssue: LinearIssue,
    externalIssue: LinearIssue,
    externalWorkspaceKey: WorkspaceKey,
  ): Promise<void> {
    const external = this.externals.get(externalWorkspaceKey);
    if (!external) return;
    const previous = this.state.getProjectMembershipState(externalWorkspaceKey, personalIssue.id);
    const personalProjectMapping = personalIssue.projectId
      ? this.state.getProjectMapping(personalIssue.projectId, externalWorkspaceKey)
      : undefined;
    const externalProjectMapping = externalIssue.projectId
      ? this.state.findProjectMappingByExternal(externalWorkspaceKey, externalIssue.projectId)
      : undefined;
    if (personalIssue.projectId && !personalProjectMapping?.active) return;
    if (externalIssue.projectId && !externalProjectMapping?.active) return;
    if (personalIssue.projectId) {
      const personalProject = await this.personal.getProject(personalIssue.projectId, true);
      if (!personalProject || personalProject.archived) return;
    }
    if (externalIssue.projectId) {
      const externalProject = await external.getProject(externalIssue.projectId, true);
      if (!externalProject || externalProject.archived) return;
    }
    const personalMappedExternalId = personalProjectMapping?.active ? personalProjectMapping.externalProjectId : undefined;
    const externalMappedPersonalId = externalProjectMapping?.active ? externalProjectMapping.personalProjectId : undefined;
    if (personalMappedExternalId) {
      const mappedExternalProject = await external.getProject(personalMappedExternalId, true);
      if (!mappedExternalProject || mappedExternalProject.archived) return;
    }
    if (externalMappedPersonalId) {
      const mappedPersonalProject = await this.personal.getProject(externalMappedPersonalId, true);
      if (!mappedPersonalProject || mappedPersonalProject.archived) return;
    }
    const personalChanged = previous
      ? this.relationshipChanged(personalIssue.projectId, personalIssue.updatedAt, previous.personalProjectId, previous.personalUpdatedAt)
      : false;
    const externalChanged = previous
      ? this.relationshipChanged(externalIssue.projectId, externalIssue.updatedAt, previous.externalProjectId, previous.externalUpdatedAt)
      : false;

    const corresponding = personalMappedExternalId === (externalIssue.projectId ?? null)
      || externalMappedPersonalId === (personalIssue.projectId ?? null);
    let side: "personal" | "external" | undefined;
    if (personalChanged && externalChanged && !corresponding) {
      side = this.latestSide(personalIssue.updatedAt, externalIssue.updatedAt);
    } else if (personalChanged && !externalChanged) {
      side = "personal";
    } else if (externalChanged && !personalChanged) {
      side = "external";
    } else if (!previous) {
      side = personalIssue.projectId ? "personal" : externalIssue.projectId ? "external" : undefined;
    }

    let personalManaged = previous?.personalManaged ?? false;
    let externalManaged = previous?.externalManaged ?? false;
    if (personalChanged) personalManaged = false;
    if (externalChanged) externalManaged = false;
    if (side === "personal" && (personalMappedExternalId || externalManaged)) {
      const desiredExternalProjectId = personalMappedExternalId ?? null;
      if (externalIssue.projectId !== desiredExternalProjectId) {
        Object.assign(externalIssue, await this.externals.get(externalWorkspaceKey)!.updateIssue(externalIssue.id, {
          projectId: desiredExternalProjectId,
        }));
      }
      externalManaged = desiredExternalProjectId !== null;
    }
    if (side === "external" && (externalMappedPersonalId || personalManaged)) {
      const desiredPersonalProjectId = externalMappedPersonalId ?? null;
      if (personalIssue.projectId !== desiredPersonalProjectId) {
        Object.assign(personalIssue, await this.personal.updateIssue(personalIssue.id, {
          projectId: desiredPersonalProjectId,
        }));
      }
      personalManaged = desiredPersonalProjectId !== null;
    }

    this.state.putProjectMembershipState({
      externalWorkspaceKey,
      personalIssueId: personalIssue.id,
      personalProjectId: personalIssue.projectId,
      externalProjectId: externalIssue.projectId,
      personalUpdatedAt: personalIssue.updatedAt,
      externalUpdatedAt: externalIssue.updatedAt,
      personalManaged,
      externalManaged,
    });
  }

  private async createInboundPersonalProject(
    pair: ProjectWorkspacePair,
    externalProject: LinearProject,
  ): Promise<{ project: LinearProject; statusMapped: boolean }> {
    const status = await this.mapProjectStatus(externalProject, this.personal);
    const project = await this.personal.createProject({
      ...this.toCreateInput(externalProject),
      statusName: status.statusName,
    }, this.config.personal.teamName);
    return { project, statusMapped: status.mapped };
  }

  private toCreateInput(project: ProjectSnapshot): ProjectCreateInput {
    return {
      name: project.name,
      description: project.description,
      statusName: project.statusName,
      priority: project.priority,
      startDate: project.startDate,
      targetDate: project.targetDate,
      leadAssigned: project.leadAssigned,
      memberAssigned: project.memberAssigned,
    };
  }

  private async projectStatusForCreation(
    project: LinearProject,
    target: LinearWorkspace,
  ): Promise<{ statusName: string | null; mapped: boolean }> {
    return this.mapProjectStatus(project, target);
  }

  private async mapProjectStatus(
    source: ProjectSnapshot,
    target: LinearWorkspace,
  ): Promise<{ statusName: string | null; mapped: boolean }> {
    const statuses = await target.listProjectStatuses();
    const canonical = source.statusType
      ? statuses.filter((status) => status.type === source.statusType)
      : [];
    if (canonical.length === 1) return { statusName: canonical[0].name, mapped: true };
    const exact = statuses.filter((status) => status.name === source.statusName);
    return exact.length === 1
      ? { statusName: exact[0].name, mapped: true }
      : { statusName: null, mapped: false };
  }

  private async mapProjectField(
    field: ProjectField,
    source: ProjectSnapshot,
    target: LinearWorkspace,
  ): Promise<ProjectUpdate> {
    if (field !== "statusName") return { [field]: source[field] } as ProjectUpdate;
    const mapped = await this.mapProjectStatus(source, target);
    return { statusName: mapped.statusName ?? source.statusName };
  }

  private async projectStatusMappingErrors(
    personal: ProjectSnapshot,
    external: ProjectSnapshot,
    pair: ProjectWorkspacePair,
  ): Promise<string[]> {
    const errors: string[] = [];
    const externalStatus = await this.mapProjectStatus(personal, pair.external);
    if (!externalStatus.mapped) errors.push(`${personal.statusName} -> ${external.statusName}`);
    const personalStatus = await this.mapProjectStatus(external, this.personal);
    if (!personalStatus.mapped) errors.push(`${external.statusName} -> ${personal.statusName}`);
    return errors;
  }

  private async validateProjectStatus(statusName: string | undefined, workspace: LinearWorkspace): Promise<string | undefined> {
    if (!statusName) return undefined;
    const statuses = await workspace.listProjectStatuses();
    return statuses.some((status) => status.name === statusName) ? undefined : statusName;
  }

  private changedOnBothSides(
    field: ProjectField,
    previous: ProjectSnapshot,
    personal: ProjectSnapshot,
    external: ProjectSnapshot,
  ): boolean {
    return !this.projectFieldEqual(field, personal, previous) && !this.projectFieldEqual(field, external, previous);
  }

  private projectValuesConverged(field: ProjectField, personal: ProjectSnapshot, external: ProjectSnapshot): boolean {
    if (field === "statusName") {
      return personal.statusName === external.statusName
        || Boolean(personal.statusType && personal.statusType === external.statusType);
    }
    return personal[field] === external[field];
  }

  private projectFieldEqual(field: ProjectField, left: ProjectSnapshot, right: ProjectSnapshot): boolean {
    return left[field] === right[field];
  }

  private toSnapshot(project: LinearProject): ProjectSnapshot {
    return {
      id: project.id,
      url: project.url,
      workspaceKey: project.workspaceKey,
      name: project.name,
      description: project.description,
      statusName: project.statusName,
      statusType: project.statusType,
      priority: project.priority,
      startDate: project.startDate,
      targetDate: project.targetDate,
      leadAssigned: project.leadAssigned,
      memberAssigned: project.memberAssigned,
      archived: project.archived,
      labelNames: project.labelNames,
      updatedAt: project.updatedAt,
    };
  }

  private toMapping(
    personalProject: LinearProject,
    externalConfig: WorkspaceConfig,
    externalProject: LinearProject,
  ): ProjectMappingRecord {
    return {
      personalProjectId: personalProject.id,
      externalWorkspaceKey: externalConfig.key,
      externalProjectId: externalProject.id,
      personalProjectUrl: personalProject.url,
      externalProjectUrl: externalProject.url,
      active: true,
      conflict: false,
      broken: false,
    };
  }

  private async ensurePersonalProjectLinkAndLabel(
    personalProject: LinearProject,
    pair: ProjectWorkspacePair,
    externalProject: LinearProject,
  ): Promise<void> {
    if (pair.externalConfig.routingLabel && !personalProject.labelNames.includes(pair.externalConfig.routingLabel)) {
      await this.personal.addProjectLabel(personalProject.id, pair.externalConfig.routingLabel);
      personalProject.labelNames.push(pair.externalConfig.routingLabel);
    }
    const hasLink = this.projectLinkMatches(personalProject.externalLinks, pair.externalConfig.key, externalProject);
    if (!hasLink) {
      await this.personal.addPersonalProjectLink(personalProject.id, externalProject.url, `${pair.externalConfig.name} ${externalProject.name}`);
      personalProject.externalLinks.push({
        workspaceKey: pair.externalConfig.key,
        projectId: externalProject.id,
        projectUrl: externalProject.url,
      });
    }
  }

  private projectLinkMatches(
    links: ExternalProjectLink[],
    workspaceKey: WorkspaceKey,
    externalProject: LinearProject,
  ): boolean {
    return links.some((link) => link.workspaceKey === workspaceKey
      && (link.projectId === externalProject.id || link.projectUrl === externalProject.url));
  }

  private async markProjectConflict(
    personalProject: LinearProject,
    externalWorkspaceKey: WorkspaceKey,
    fields: string[],
  ): Promise<void> {
    await this.addProjectLabelIfMissing(personalProject, this.config.syncLabels.conflict);
    this.state.setProjectConflict(personalProject.id, externalWorkspaceKey);
    const fingerprint = fields.slice().sort().join(",");
    if (this.state.shouldNotifyProject(personalProject.id, externalWorkspaceKey, "conflict", fingerprint)) {
      await this.personal.addPersonalProjectNotification(personalProject.id, `A project sync conflict needs your attention for: ${fields.join(", ")}.`);
    }
  }

  private async markProjectBroken(
    personalProject: LinearProject,
    externalWorkspaceKey: WorkspaceKey,
    fingerprint: string,
    message: string,
  ): Promise<void> {
    await this.addProjectLabelIfMissing(personalProject, this.config.syncLabels.broken);
    if (externalWorkspaceKey !== "personal") this.state.setProjectBroken(personalProject.id, externalWorkspaceKey, true);
    if (this.state.shouldNotifyProject(personalProject.id, externalWorkspaceKey, "broken", fingerprint)) {
      await this.personal.addPersonalProjectNotification(personalProject.id, message);
    }
  }

  private async markProjectExternalUnavailable(
    personalProject: LinearProject,
    mapping: ProjectMappingRecord,
  ): Promise<void> {
    await this.addProjectLabelIfMissing(personalProject, this.config.syncLabels.externalUnavailable);
    this.state.setProjectBroken(personalProject.id, mapping.externalWorkspaceKey, true);
    if (this.state.shouldNotifyProject(personalProject.id, mapping.externalWorkspaceKey, "external-unavailable", mapping.externalProjectId)) {
      await this.personal.addPersonalProjectNotification(personalProject.id, "The mapped external project is archived or unavailable.");
    }
  }

  private async addProjectLabelIfMissing(project: LinearProject, label: string): Promise<void> {
    if (project.labelNames.includes(label)) return;
    await this.personal.addProjectLabel(project.id, label);
    project.labelNames.push(label);
  }

  private async removeProjectLabelIfPresent(project: LinearProject, label: string): Promise<void> {
    if (!project.labelNames.includes(label)) return;
    await this.personal.removeProjectLabel(project.id, label);
    project.labelNames = project.labelNames.filter((name) => name !== label);
  }

  private relationshipChanged(
    currentProjectId: string | null,
    currentUpdatedAt: string,
    previousProjectId: string | null,
    previousUpdatedAt: string | null,
  ): boolean {
    if (currentProjectId !== previousProjectId) return true;
    return Boolean(currentUpdatedAt && previousUpdatedAt && currentUpdatedAt !== previousUpdatedAt);
  }

  private latestSide(personalUpdatedAt: string, externalUpdatedAt: string): "personal" | "external" {
    return personalUpdatedAt >= externalUpdatedAt ? "personal" : "external";
  }

  private getPair(externalWorkspaceKey: WorkspaceKey): ProjectWorkspacePair | undefined {
    const externalConfig = this.config.external.find((workspace) => workspace.key === externalWorkspaceKey);
    const external = this.externals.get(externalWorkspaceKey);
    return externalConfig && external ? { externalConfig, external } : undefined;
  }

  private projectMappingKey(externalWorkspaceKey: WorkspaceKey, externalProjectId: string): string {
    return `${externalWorkspaceKey}\u0000${externalProjectId}`;
  }

  private emptyResult(): ProjectSyncResult {
    return {
      createdInboundProjects: 0,
      createdOutboundProjects: 0,
      updatedMappings: 0,
      conflicts: 0,
      broken: 0,
    };
  }

  private addResult(target: ProjectSyncResult, source: ProjectSyncResult): void {
    target.createdInboundProjects += source.createdInboundProjects;
    target.createdOutboundProjects += source.createdOutboundProjects;
    target.updatedMappings += source.updatedMappings;
    target.conflicts += source.conflicts;
    target.broken += source.broken;
  }

  private recordFailure(projectId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const count = this.state.recordFailure("project", projectId, message);
    logEvent("project_sync_failure", { level: "error", projectId, count, error: message });
  }
}
