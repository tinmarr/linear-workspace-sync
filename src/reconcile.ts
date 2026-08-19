import type {
  AppConfig,
  CoreField,
  IssueSnapshot,
  MappingRecord,
  WorkspaceConfig,
  WorkspaceKey,
} from "./domain.js";
import { CORE_FIELDS } from "./domain.js";
import type { ExternalIssueLink, IssueCreateInput, IssueUpdate, LinearIssue, LinearWorkspace } from "./linear.js";
import { logEvent } from "./log.js";
import { RelationshipSynchronizer } from "./relationship-sync.js";
import { SyncState } from "./state.js";

type WorkspacePair = {
  externalConfig: WorkspaceConfig;
  external: LinearWorkspace;
};

type ReconcileContext = {
  personalIssues: Map<string, LinearIssue>;
  externalIssues: Map<WorkspaceKey, Map<string, LinearIssue>>;
  assignedExternalIds: Map<WorkspaceKey, Set<string>>;
  processedMappingKeys: Set<string>;
};

type MappingResult = {
  conflicts: number;
  broken: number;
};

export type ReconciliationResult = {
  createdInbound: number;
  createdOutbound: number;
  updatedMappings: number;
  conflicts: number;
  broken: number;
};

export class ReconciliationEngine {
  public constructor(
    private readonly config: AppConfig,
    private readonly personal: LinearWorkspace,
    private readonly externals: Map<WorkspaceKey, LinearWorkspace>,
    private readonly state: SyncState,
  ) {}

  public async run(initial: boolean): Promise<ReconciliationResult> {
    logEvent("personal_sync_labels_starting");
    await this.ensurePersonalSyncLabels();
    logEvent("personal_sync_labels_ready");
    logEvent("personal_issue_discovery_starting", { team: this.config.personal.teamName });
    const personalIssues = await this.personal.listIssues({
      teamName: this.config.personal.teamName,
      includeArchived: false,
      includeLabels: true,
      includeExternalLinks: true,
      excludeCompleted: initial,
    });
    logEvent("personal_issues_discovered", { count: personalIssues.length });
    const context: ReconcileContext = {
      personalIssues: new Map(personalIssues.map((issue) => [issue.id, issue])),
      externalIssues: new Map(),
      assignedExternalIds: new Map(),
      processedMappingKeys: new Set(),
    };
    const result: ReconciliationResult = {
      createdInbound: 0,
      createdOutbound: 0,
      updatedMappings: 0,
      conflicts: 0,
      broken: 0,
    };

    for (const issue of personalIssues) {
      logEvent("personal_issue_reconciliation_starting", {
        issueId: issue.id,
        identifier: issue.identifier,
      });
      try {
        const outcome = await this.reconcilePersonalIssue(issue, context);
        this.state.clearFailure("personal", issue.id);
        result.createdOutbound += outcome.createdOutbound;
        result.updatedMappings += outcome.updatedMappings;
        result.conflicts += outcome.conflicts;
        result.broken += outcome.broken;
        logEvent("personal_issue_reconciliation_completed", {
          issueId: issue.id,
          identifier: issue.identifier,
          ...outcome,
        });
      } catch (error: unknown) {
        await this.handleFailure("personal", issue.id, error, result, issue);
      }
    }

    for (const pair of this.workspacePairs()) {
      logEvent("external_issue_discovery_starting", {
        workspace: pair.externalConfig.name,
        team: pair.externalConfig.teamName,
      });
      let assigned: LinearIssue[];
      try {
        assigned = await pair.external.listIssues({
          assignedToViewer: true,
          teamName: pair.externalConfig.teamName,
          includeArchived: false,
          includeLabels: false,
          includeExternalLinks: false,
          excludeCompleted: initial,
        });
        this.state.clearFailure(`workspace:${pair.externalConfig.key}`, "__list__");
        logEvent("external_issues_discovered", {
          workspace: pair.externalConfig.name,
          count: assigned.length,
        });
      } catch (error: unknown) {
        this.handleWorkspaceFailure(pair.externalConfig.key, error);
        continue;
      }
      context.assignedExternalIds.set(
        pair.externalConfig.key,
        new Set(assigned.map((issue) => issue.id)),
      );
      context.externalIssues.set(
        pair.externalConfig.key,
        new Map(assigned.map((issue) => [issue.id, issue])),
      );
      for (const externalIssue of assigned) {
        const processedKey = this.mappingKey(pair.externalConfig.key, externalIssue.id);
        if (context.processedMappingKeys.has(processedKey)) {
          this.state.clearFailure(pair.externalConfig.key, externalIssue.id);
          logEvent("inbound_issue_reconciliation_skipped", {
            workspace: pair.externalConfig.name,
            issueId: externalIssue.id,
            identifier: externalIssue.identifier,
            reason: "already_processed",
          });
          continue;
        }
        logEvent("inbound_issue_reconciliation_starting", {
          workspace: pair.externalConfig.name,
          issueId: externalIssue.id,
          identifier: externalIssue.identifier,
        });
        try {
          const outcome = await this.reconcileInboundIssue(pair, externalIssue, context);
          this.state.clearFailure(pair.externalConfig.key, externalIssue.id);
          result.createdInbound += outcome.createdInbound;
          result.updatedMappings += outcome.updatedMappings;
          result.conflicts += outcome.conflicts;
          result.broken += outcome.broken;
          logEvent("inbound_issue_reconciliation_completed", {
            workspace: pair.externalConfig.name,
            issueId: externalIssue.id,
            identifier: externalIssue.identifier,
            ...outcome,
          });
        } catch (error: unknown) {
          const existing = this.state.findMappingByExternal(pair.externalConfig.key, externalIssue.id);
          const personalIssue = existing
            ? context.personalIssues.get(existing.personalIssueId)
              ?? await this.personal.getIssue(existing.personalIssueId, true)
            : undefined;
          await this.handleFailure(pair.externalConfig.key, externalIssue.id, error, result, personalIssue ?? undefined);
        }
      }
    }

    const mappings = this.state.listMappings();
    logEvent("mapping_reconciliation_starting", { count: mappings.length });
    for (const mapping of mappings) {
      if (!mapping.active) {
        continue;
      }
      logEvent("mapping_reconciliation_checking", {
        personalIssueId: mapping.personalIssueId,
        externalWorkspace: mapping.externalWorkspaceKey,
        externalIssueId: mapping.externalIssueId,
      });
      const pair = this.getPair(mapping.externalWorkspaceKey);
      if (!pair) {
        continue;
      }
      if (context.processedMappingKeys.has(this.mappingKey(mapping.externalWorkspaceKey, mapping.externalIssueId))) {
        logEvent("mapping_reconciliation_skipped", {
          personalIssueId: mapping.personalIssueId,
          externalWorkspace: mapping.externalWorkspaceKey,
          externalIssueId: mapping.externalIssueId,
          reason: "already_processed",
        });
        continue;
      }
      const personalIssue = context.personalIssues.get(mapping.personalIssueId)
        ?? await this.personal.getIssue(mapping.personalIssueId, true);
      const externalIssue = await pair.external.getIssue(mapping.externalIssueId, true);
      if (!personalIssue || personalIssue.archived) {
        if (externalIssue && !externalIssue.archived) {
          const replacementResult = personalIssue
            ? { issue: await this.personal.restoreIssue(personalIssue.id), statusMapped: true }
            : await this.createInboundPersonalIssue(pair, externalIssue);
          const replacement = replacementResult.issue;
          context.personalIssues.set(replacement.id, replacement);
          await this.ensurePersonalLinkAndLabel(replacement, pair, externalIssue);
          this.state.replaceMapping(mapping.personalIssueId, {
            personalIssueId: replacement.id,
            externalWorkspaceKey: pair.externalConfig.key,
            externalIssueId: externalIssue.id,
            personalIssueUrl: replacement.url,
            externalIssueUrl: externalIssue.url,
            active: true,
            conflict: false,
            broken: false,
          });
          const mappingResult = await this.processMapping(replacement, pair, externalIssue, true, context.processedMappingKeys);
          result.conflicts += mappingResult.conflicts;
          result.broken += mappingResult.broken;
          if (!replacementResult.statusMapped) {
            await this.markBroken(replacement, `unmapped-status:${externalIssue.statusName}`, `No configured status mapping exists for ${externalIssue.statusName}.`, this.config.syncLabels.broken, pair.externalConfig.key);
            result.broken++;
          }
        }
        continue;
      }
      if (!externalIssue || externalIssue.archived) {
        await this.markExternalUnavailable(personalIssue, mapping, externalIssue);
        result.broken++;
        continue;
      }
      const hasPersonalSignal = personalIssue.externalLinks.some((link) =>
        link.workspaceKey === pair.externalConfig.key
        && (link.issueId === externalIssue.id
          || link.issueId === externalIssue.identifier
          || link.issueUrl === externalIssue.url),
      ) || Boolean(
        pair.externalConfig.routingLabel
        && personalIssue.labelNames.includes(pair.externalConfig.routingLabel),
      );
      const isAssignedExternally = context.assignedExternalIds
        .get(pair.externalConfig.key)
        ?.has(externalIssue.id) ?? false;
      if (!hasPersonalSignal && !isAssignedExternally) {
        this.state.upsertMapping({ ...mapping, active: false });
        continue;
      }
      try {
        if (!hasPersonalSignal && isAssignedExternally) {
          await this.ensurePersonalLinkAndLabel(personalIssue, pair, externalIssue);
        }
        const mappingResult = await this.processMapping(personalIssue, pair, externalIssue, false, context.processedMappingKeys);
        result.conflicts += mappingResult.conflicts;
        result.broken += mappingResult.broken;
        this.state.clearFailure(pair.externalConfig.key, externalIssue.id);
      } catch (error: unknown) {
        await this.handleFailure(pair.externalConfig.key, externalIssue.id, error, result, personalIssue);
      }
    }

    for (const pair of this.workspacePairs()) {
      try {
        await new RelationshipSynchronizer(
          this.personal,
          pair.external,
          this.state,
          pair.externalConfig.key,
        ).run(
          context.personalIssues,
          context.externalIssues.get(pair.externalConfig.key) ?? new Map(),
        );
      } catch (error: unknown) {
        this.handleWorkspaceFailure(`relationships:${pair.externalConfig.key}`, error);
      }
    }

    if (initial) {
      this.state.markInitialized();
    }
    logEvent("reconciliation_completed", { initial, ...result });
    return result;
  }

  private async reconcilePersonalIssue(
    personalIssue: LinearIssue,
    context: ReconcileContext,
  ): Promise<ReconciliationResult> {
    const result = this.emptyResult();
    const links = personalIssue.externalLinks;
    if (links.length > 1) {
      await this.markBroken(personalIssue, "multiple-external-links", "Multiple external links make this mapping ambiguous.");
      result.broken++;
      return result;
    }

    if (links.length === 1) {
      const link = links[0];
      const pair = this.getPair(link.workspaceKey);
      if (!pair) {
        await this.markBroken(personalIssue, "unknown-linked-workspace", "The linked external workspace is not configured.");
        result.broken++;
        return result;
      }
      const externalIssue = await pair.external.getIssue(link.issueId, true);
      if (!externalIssue || externalIssue.archived) {
        const mapping = this.state.getMapping(personalIssue.id, pair.externalConfig.key);
        await this.markExternalUnavailable(personalIssue, mapping, externalIssue);
        result.broken++;
        return result;
      }
      const existing = this.state.findMappingByExternal(pair.externalConfig.key, externalIssue.id);
      if (existing && existing.personalIssueId !== personalIssue.id) {
        await this.markMappingConflict(personalIssue, existing, pair);
        result.conflicts++;
        return result;
      }
      await this.ensurePersonalLinkAndLabel(personalIssue, pair, externalIssue);
      await this.persistMapping(personalIssue, pair.externalConfig, externalIssue, true);
      const mappingResult = await this.processMapping(personalIssue, pair, externalIssue, false, context.processedMappingKeys);
      result.conflicts += mappingResult.conflicts;
      result.broken += mappingResult.broken;
      result.updatedMappings++;
      return result;
    }

    const routingMatches = this.config.external.filter((workspace) =>
      workspace.routingLabel && personalIssue.labelNames.includes(workspace.routingLabel),
    );
    if (routingMatches.length > 1) {
      await this.markBroken(personalIssue, "multiple-routing-labels", "Multiple routing labels cannot identify one external workspace.");
      result.broken++;
      return result;
    }
    if (routingMatches.length === 0) {
      return result;
    }

    const target = routingMatches[0];
    const pair = this.getPair(target.key);
    if (!pair) {
      await this.markBroken(personalIssue, "missing-external-client", "The configured external workspace is unavailable.");
      result.broken++;
      return result;
    }
    const existing = this.state.getMapping(personalIssue.id, target.key);
    if (existing) {
      const externalIssue = await pair.external.getIssue(existing.externalIssueId, true);
      if (externalIssue && !externalIssue.archived) {
        const mappingResult = await this.processMapping(personalIssue, pair, externalIssue, false, context.processedMappingKeys);
        result.conflicts += mappingResult.conflicts;
        result.broken += mappingResult.broken;
        result.updatedMappings++;
      } else {
        await this.markExternalUnavailable(personalIssue, existing, externalIssue);
        result.broken++;
      }
      return result;
    }

    const outboundStatus = await this.statusForCreation(
      personalIssue.statusName,
      this.config.personal,
      target,
      pair.external,
    );
    const outboundInput = this.toCreateInput(personalIssue, target);
    outboundInput.statusName = outboundStatus.statusName;
    outboundInput.assigneeEmail = pair.external.viewerEmail;
    const created = await pair.external.createIssue(outboundInput, target.teamName);
    await this.personal.addPersonalLink(personalIssue.id, created.url, `${target.name} ${created.identifier}`);
    await this.persistMapping(personalIssue, target, created, true);
    const mappingResult = await this.processMapping(personalIssue, pair, created, true, context.processedMappingKeys);
    result.conflicts += mappingResult.conflicts;
    result.broken += mappingResult.broken;
    if (!outboundStatus.mapped) {
      await this.markBroken(personalIssue, `unmapped-status:${personalIssue.statusName}`, `No configured status mapping exists for ${personalIssue.statusName}.`, this.config.syncLabels.broken, target.key);
      result.broken++;
    }
    result.createdOutbound++;
    return result;
  }

  private async reconcileInboundIssue(
    pair: WorkspacePair,
    externalIssue: LinearIssue,
    context: ReconcileContext,
  ): Promise<ReconciliationResult> {
    const result = this.emptyResult();
    const existing = this.state.findMappingByExternal(pair.externalConfig.key, externalIssue.id);
    if (existing) {
      const personalIssue = context.personalIssues.get(existing.personalIssueId)
        ?? await this.personal.getIssue(existing.personalIssueId, true);
      if (!personalIssue) {
        const replacement = await this.createInboundPersonalIssue(pair, externalIssue);
        context.personalIssues.set(replacement.issue.id, replacement.issue);
        await this.ensurePersonalLinkAndLabel(replacement.issue, pair, externalIssue);
        if (existing) {
          this.state.replaceMapping(existing.personalIssueId, {
            personalIssueId: replacement.issue.id,
            externalWorkspaceKey: pair.externalConfig.key,
            externalIssueId: externalIssue.id,
            personalIssueUrl: replacement.issue.url,
            externalIssueUrl: externalIssue.url,
            active: true,
            conflict: false,
            broken: false,
          });
        } else {
          await this.persistMapping(replacement.issue, pair.externalConfig, externalIssue, true);
        }
        const mappingResult = await this.processMapping(replacement.issue, pair, externalIssue, true, context.processedMappingKeys);
        result.conflicts += mappingResult.conflicts;
        result.broken += mappingResult.broken;
        if (!replacement.statusMapped) {
          await this.markBroken(replacement.issue, `unmapped-status:${externalIssue.statusName}`, `No configured status mapping exists for ${externalIssue.statusName}.`, this.config.syncLabels.broken, pair.externalConfig.key);
          result.broken++;
        }
        result.createdInbound++;
        return result;
      }
      await this.ensurePersonalLinkAndLabel(personalIssue, pair, externalIssue);
      const mappingResult = await this.processMapping(personalIssue, pair, externalIssue, false, context.processedMappingKeys);
      result.conflicts += mappingResult.conflicts;
      result.broken += mappingResult.broken;
      result.updatedMappings++;
      return result;
    }

    const replacement = await this.createInboundPersonalIssue(pair, externalIssue);
    context.personalIssues.set(replacement.issue.id, replacement.issue);
    await this.ensurePersonalLinkAndLabel(replacement.issue, pair, externalIssue);
    await this.persistMapping(replacement.issue, pair.externalConfig, externalIssue, true);
    const mappingResult = await this.processMapping(replacement.issue, pair, externalIssue, true, context.processedMappingKeys);
    result.conflicts += mappingResult.conflicts;
    result.broken += mappingResult.broken;
    if (!replacement.statusMapped) {
      await this.markBroken(replacement.issue, `unmapped-status:${externalIssue.statusName}`, `No configured status mapping exists for ${externalIssue.statusName}.`, this.config.syncLabels.broken, pair.externalConfig.key);
      result.broken++;
    }
    result.createdInbound++;
    return result;
  }

  private async processMapping(
    personalIssue: LinearIssue,
    pair: WorkspacePair,
    externalIssue: LinearIssue,
    created: boolean,
    processedMappingKeys: Set<string>,
  ): Promise<MappingResult> {
    await this.ensurePersonalAdditionalLabels(personalIssue, pair);
    const mapping = this.state.getMapping(personalIssue.id, pair.externalConfig.key);
    if (!mapping) {
      await this.persistMapping(personalIssue, pair.externalConfig, externalIssue, true);
    }

    const currentExternal = this.toSnapshot(externalIssue);
    const desiredPersonalAssignee = externalIssue.assigneeEmail === pair.external.viewerEmail
      ? this.personal.viewerEmail
      : null;
    if (personalIssue.assigneeEmail !== desiredPersonalAssignee) {
      const updatedPersonal = await this.personal.updateIssue(personalIssue.id, {
        assigneeEmail: desiredPersonalAssignee,
      });
      Object.assign(personalIssue, updatedPersonal);
    }
    const currentPersonal = this.toSnapshot(personalIssue);
    const previous = this.state.getSnapshot(personalIssue.id, pair.externalConfig.key);
    const statusErrors = previous && !created
      ? await this.statusMappingErrors(currentPersonal, currentExternal, pair)
      : [];
    for (const statusError of statusErrors) {
      await this.markBroken(
        personalIssue,
        `unmapped-status:${statusError}`,
        `No configured status mapping exists for ${statusError}.`,
        this.config.syncLabels.broken,
        pair.externalConfig.key,
      );
    }
    let broken = statusErrors.length;
    if (!previous || created) {
      this.state.putSnapshot(currentPersonal, pair.externalConfig.key);
      this.state.putSnapshot(currentExternal, pair.externalConfig.key);
      processedMappingKeys.add(this.mappingKey(pair.externalConfig.key, externalIssue.id));
      return { conflicts: 0, broken };
    }

    const conflicts = CORE_FIELDS.filter((field) =>
      this.changedOnBothSides(field, previous, currentPersonal, currentExternal)
      && !this.valuesConverged(field, currentPersonal, currentExternal, pair.externalConfig),
    );
    if (conflicts.length > 0) {
      await this.markConflict(personalIssue, pair.externalConfig.key, conflicts);
      processedMappingKeys.add(this.mappingKey(pair.externalConfig.key, externalIssue.id));
      return { conflicts: 1, broken: 0 };
    }

    const personalChanges: IssueUpdate = {};
    const externalChanges: IssueUpdate = {};
    for (const field of CORE_FIELDS) {
      const personalChanged = !this.fieldEqual(field, currentPersonal, previous);
      const externalChanged = !this.fieldEqual(field, currentExternal, previous);
      if (personalChanged && !externalChanged) {
        const mapped = await this.mapFieldToExternal(field, currentPersonal, pair);
        Object.assign(externalChanges, mapped);
      } else if (externalChanged && !personalChanged) {
        const mapped = await this.mapFieldToPersonal(field, currentExternal, pair);
        Object.assign(personalChanges, mapped);
      }
    }

    const externalStatusError = await this.validateStatusChange(externalChanges, pair.external, pair.externalConfig.teamName);
    if (externalStatusError) {
      await this.markBroken(personalIssue, `unmapped-status:${externalStatusError}`, `No configured status mapping exists for ${externalStatusError}.`, this.config.syncLabels.broken, pair.externalConfig.key);
      delete externalChanges.statusName;
      broken++;
    }
    const personalStatusError = await this.validateStatusChange(personalChanges, this.personal, this.config.personal.teamName);
    if (personalStatusError) {
      await this.markBroken(personalIssue, `unmapped-status:${personalStatusError}`, `No configured status mapping exists for ${personalStatusError}.`, this.config.syncLabels.broken, pair.externalConfig.key);
      delete personalChanges.statusName;
      broken++;
    }

    const finalPersonal = personalIssue;
    const finalExternal = externalIssue;
    if (Object.keys(externalChanges).length > 0) {
      Object.assign(finalExternal, await pair.external.updateIssue(externalIssue.id, externalChanges));
    }
    if (Object.keys(personalChanges).length > 0) {
      Object.assign(finalPersonal, await this.personal.updateIssue(personalIssue.id, personalChanges));
    }
    this.state.putSnapshot(this.toSnapshot(finalPersonal), pair.externalConfig.key);
    this.state.putSnapshot(this.toSnapshot(finalExternal), pair.externalConfig.key);
    this.state.clearConflict(personalIssue.id, pair.externalConfig.key);
    await this.removePersonalLabelIfPresent(personalIssue, this.config.syncLabels.conflict);
    this.state.clearNotifications(personalIssue.id, pair.externalConfig.key, "conflict");
    if (broken === 0) {
      await this.removePersonalLabelIfPresent(personalIssue, this.config.syncLabels.broken);
      this.state.setBroken(personalIssue.id, pair.externalConfig.key, false);
    }
    processedMappingKeys.add(this.mappingKey(pair.externalConfig.key, externalIssue.id));
    return { conflicts: 0, broken };
  }

  private async removePersonalLabelIfPresent(personalIssue: LinearIssue, label: string): Promise<void> {
    if (!personalIssue.labelNames.includes(label)) {
      return;
    }
    await this.personal.removeLabel(personalIssue.id, label);
    personalIssue.labelNames = personalIssue.labelNames.filter((name) => name !== label);
  }

  private async addPersonalLabelIfMissing(personalIssue: LinearIssue, label: string): Promise<void> {
    if (personalIssue.labelNames.includes(label)) {
      return;
    }
    await this.personal.addLabel(personalIssue.id, label);
    personalIssue.labelNames.push(label);
  }

  private async createInboundPersonalIssue(
    pair: WorkspacePair,
    externalIssue: LinearIssue,
  ): Promise<{ issue: LinearIssue; statusMapped: boolean }> {
    const targetStatuses = await this.personal.listStatusNames(this.config.personal.teamName);
    const statusName = await this.mapStatusName(
      externalIssue.statusName,
      pair.externalConfig,
      this.config.personal,
    );
    const issue = await this.personal.createIssue(
      {
        ...this.toCreateInput(externalIssue, this.config.personal),
        statusName: targetStatuses.has(statusName) ? statusName : null,
        assigneeEmail: this.personal.viewerEmail,
      },
      this.config.personal.teamName,
    );
    return { issue, statusMapped: targetStatuses.has(statusName) };
  }

  private toCreateInput(
    issue: IssueSnapshot,
    target: WorkspaceConfig,
  ): IssueCreateInput {
    return {
      title: issue.title,
      description: issue.description,
      statusName: issue.statusName,
      dueDate: issue.dueDate,
      estimate: issue.estimate,
      priority: issue.priority,
    };
  }

  private async statusForCreation(
    sourceStatus: string,
    source: WorkspaceConfig,
    target: WorkspaceConfig,
    targetClient: LinearWorkspace,
  ): Promise<{ statusName: string | null; mapped: boolean }> {
    const targetStatuses = await targetClient.listStatusNames(target.teamName);
    const mapped = await this.mapStatusName(sourceStatus, source, target);
    return { statusName: targetStatuses.has(mapped) ? mapped : null, mapped: targetStatuses.has(mapped) };
  }

  private async ensurePersonalSyncLabels(): Promise<void> {
    for (const workspace of this.config.external) {
      if (workspace.routingLabel) {
        await this.personal.ensureLabel(workspace.routingLabel);
      }
      for (const label of workspace.personalLabels) {
        await this.personal.ensureLabel(label);
      }
    }
    await this.personal.ensureLabel(this.config.syncLabels.conflict);
    await this.personal.ensureLabel(this.config.syncLabels.broken);
    await this.personal.ensureLabel(this.config.syncLabels.externalUnavailable);
  }

  private async ensurePersonalLinkAndLabel(
    personalIssue: LinearIssue,
    pair: WorkspacePair,
    externalIssue: LinearIssue,
  ): Promise<void> {
    if (pair.externalConfig.routingLabel && !personalIssue.labelNames.includes(pair.externalConfig.routingLabel)) {
      await this.personal.addLabel(personalIssue.id, pair.externalConfig.routingLabel);
      personalIssue.labelNames.push(pair.externalConfig.routingLabel);
    }
    await this.ensurePersonalAdditionalLabels(personalIssue, pair);
    const hasLink = personalIssue.externalLinks.some((link) =>
      link.workspaceKey === pair.externalConfig.key
      && (link.issueId === externalIssue.id
        || link.issueId === externalIssue.identifier
        || link.issueUrl === externalIssue.url),
    );
    if (!hasLink) {
      await this.personal.addPersonalLink(personalIssue.id, externalIssue.url, `${pair.externalConfig.name} ${externalIssue.identifier}`);
      personalIssue.externalLinks.push({
        workspaceKey: pair.externalConfig.key,
        issueId: externalIssue.identifier,
        issueUrl: externalIssue.url,
      });
    }
  }

  private async ensurePersonalAdditionalLabels(
    personalIssue: LinearIssue,
    pair: WorkspacePair,
  ): Promise<void> {
    for (const label of pair.externalConfig.personalLabels) {
      await this.addPersonalLabelIfMissing(personalIssue, label);
    }
  }

  private async persistMapping(
    personalIssue: LinearIssue,
    externalConfig: WorkspaceConfig,
    externalIssue: LinearIssue,
    active: boolean,
  ): Promise<void> {
    this.state.upsertMapping({
      personalIssueId: personalIssue.id,
      externalWorkspaceKey: externalConfig.key,
      externalIssueId: externalIssue.id,
      personalIssueUrl: personalIssue.url,
      externalIssueUrl: externalIssue.url,
      active,
      conflict: false,
      broken: false,
    });
  }

  private async markExternalUnavailable(
    personalIssue: LinearIssue,
    mapping: MappingRecord | undefined,
    externalIssue: LinearIssue | null,
  ): Promise<void> {
    await this.markBroken(
      personalIssue,
      `external-unavailable:${mapping?.externalIssueId ?? externalIssue?.id ?? "unknown"}`,
      "The mapped external issue is archived or unavailable.",
      this.config.syncLabels.externalUnavailable,
      mapping?.externalWorkspaceKey,
    );
    if (mapping) {
      this.state.upsertMapping({ ...mapping, active: false, broken: true });
    }
  }

  private async markMappingConflict(
    personalIssue: LinearIssue,
    existing: MappingRecord,
    pair: WorkspacePair,
  ): Promise<void> {
    await this.markConflict(personalIssue, pair.externalConfig.key, ["mapping"]);
    this.state.setConflict(existing.personalIssueId, pair.externalConfig.key);
    const other = await this.personal.getIssue(existing.personalIssueId, false);
    if (other) {
      await this.addPersonalLabelIfMissing(other, this.config.syncLabels.conflict);
      if (this.state.shouldNotify(other.id, pair.externalConfig.key, "conflict", "mapping")) {
        await this.personal.addPersonalNotification(other.id, "A mapping conflict needs your attention.");
      }
    }
  }

  private async markConflict(
    personalIssue: LinearIssue,
    externalWorkspaceKey: WorkspaceKey,
    fields: string[],
  ): Promise<void> {
    await this.addPersonalLabelIfMissing(personalIssue, this.config.syncLabels.conflict);
    this.state.setConflict(personalIssue.id, externalWorkspaceKey);
    const fingerprint = fields.slice().sort().join(",");
    if (this.state.shouldNotify(personalIssue.id, externalWorkspaceKey, "conflict", fingerprint)) {
      await this.personal.addPersonalNotification(
        personalIssue.id,
        `A sync conflict needs your attention for: ${fields.join(", ")}.`,
      );
    }
  }

  private async markBroken(
    personalIssue: LinearIssue,
    fingerprint: string,
    message: string,
    label = this.config.syncLabels.broken,
    externalWorkspaceKey?: WorkspaceKey,
  ): Promise<void> {
    await this.addPersonalLabelIfMissing(personalIssue, label);
    if (externalWorkspaceKey) {
      this.state.setBroken(personalIssue.id, externalWorkspaceKey, true);
    }
    if (this.state.shouldNotify(personalIssue.id, "personal", "broken", fingerprint)) {
      await this.personal.addPersonalNotification(personalIssue.id, message);
    }
  }

  private async mapFieldToExternal(
    field: CoreField,
    personal: IssueSnapshot,
    pair: WorkspacePair,
  ): Promise<IssueUpdate> {
    if (field !== "statusName") {
      return { [field]: personal[field] } as IssueUpdate;
    }
    return {
      statusName: await this.mapStatusName(
        personal.statusName,
        this.config.personal,
        pair.externalConfig,
      ),
    };
  }

  private async mapFieldToPersonal(
    field: CoreField,
    external: IssueSnapshot,
    pair: WorkspacePair,
  ): Promise<IssueUpdate> {
    if (field !== "statusName") {
      return { [field]: external[field] } as IssueUpdate;
    }
    return {
      statusName: await this.mapStatusName(
        external.statusName,
        pair.externalConfig,
        this.config.personal,
      ),
    };
  }

  private async validateStatusChange(
    update: IssueUpdate,
    workspace: LinearWorkspace,
    teamName: string,
  ): Promise<string | undefined> {
    if (!update.statusName) {
      return undefined;
    }
    const names = await workspace.listStatusNames(teamName);
    return names.has(update.statusName) ? undefined : update.statusName;
  }

  private async statusMappingErrors(
    personal: IssueSnapshot,
    external: IssueSnapshot,
    pair: WorkspacePair,
  ): Promise<string[]> {
    const errors: string[] = [];
    const externalStatus = await this.mapStatusName(
      personal.statusName,
      this.config.personal,
      pair.externalConfig,
    );
    if (!(await pair.external.listStatusNames(pair.externalConfig.teamName)).has(externalStatus)) {
      errors.push(`${personal.statusName} -> ${externalStatus}`);
    }
    const personalStatus = await this.mapStatusName(
      external.statusName,
      pair.externalConfig,
      this.config.personal,
    );
    if (!(await this.personal.listStatusNames(this.config.personal.teamName)).has(personalStatus)) {
      errors.push(`${external.statusName} -> ${personalStatus}`);
    }
    return errors;
  }

  private async mapStatusName(
    sourceStatus: string,
    source: WorkspaceConfig,
    target: WorkspaceConfig,
  ): Promise<string> {
    const externalConfig = this.config.external.find((item) => item.key === source.key || item.key === target.key);
    const configured = externalConfig?.statusMappings ?? {};
    let mapped = source.key === this.config.personal.key
      ? configured[sourceStatus]
      : Object.entries(configured).find(([, externalStatus]) => externalStatus === sourceStatus)?.[0];
    mapped ??= sourceStatus;
    return mapped;
  }

  private changedOnBothSides(
    field: CoreField,
    previous: IssueSnapshot,
    personal: IssueSnapshot,
    external: IssueSnapshot,
  ): boolean {
    return !this.fieldEqual(field, personal, previous) && !this.fieldEqual(field, external, previous);
  }

  private valuesConverged(
    field: CoreField,
    personal: IssueSnapshot,
    external: IssueSnapshot,
    pair: WorkspaceConfig,
  ): boolean {
    if (field !== "statusName") {
      return personal[field] === external[field];
    }
    const mappings = pair.statusMappings;
    return personal.statusName === external.statusName
      || mappings[personal.statusName] === external.statusName
      || Object.entries(mappings).some(([personalStatus, externalStatus]) =>
        personalStatus === personal.statusName && externalStatus === external.statusName,
      );
  }

  private fieldEqual(field: CoreField, left: IssueSnapshot, right: IssueSnapshot): boolean {
    return left[field] === right[field];
  }

  private toSnapshot(issue: LinearIssue): IssueSnapshot {
    return {
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      workspaceKey: issue.workspaceKey,
      title: issue.title,
      description: issue.description,
      statusName: issue.statusName,
      dueDate: issue.dueDate,
      estimate: issue.estimate,
      priority: issue.priority,
      assigneeEmail: issue.assigneeEmail,
      archived: issue.archived,
      labelNames: issue.labelNames,
    };
  }

  private getPair(externalWorkspaceKey: WorkspaceKey): WorkspacePair | undefined {
    const externalConfig = this.config.external.find((workspace) => workspace.key === externalWorkspaceKey);
    const external = this.externals.get(externalWorkspaceKey);
    return externalConfig && external ? { externalConfig, external } : undefined;
  }

  private workspacePairs(): WorkspacePair[] {
    return this.config.external.flatMap((externalConfig) => {
      const external = this.externals.get(externalConfig.key);
      return external ? [{ externalConfig, external }] : [];
    });
  }

  private mappingKey(externalWorkspaceKey: WorkspaceKey, externalIssueId: string): string {
    return `${externalWorkspaceKey}\u0000${externalIssueId}`;
  }

  private emptyResult(): ReconciliationResult {
    return { createdInbound: 0, createdOutbound: 0, updatedMappings: 0, conflicts: 0, broken: 0 };
  }

  private async handleFailure(
    scopeKey: string,
    issueId: string,
    error: unknown,
    result: ReconciliationResult,
    personalIssue?: LinearIssue,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const count = this.state.recordFailure(scopeKey, issueId, message);
    logEvent("sync_failure", { level: "error", scopeKey, issueId, count, error: message });
    if (count >= 3 && personalIssue) {
      try {
        await this.markBroken(personalIssue, `persistent-failure:${scopeKey}:${message}`, "Repeated synchronization failures need your attention.");
        result.broken++;
      } catch (markerError: unknown) {
        logEvent("sync_failure_marker_failed", {
          level: "error",
          scopeKey,
          issueId,
          error: markerError instanceof Error ? markerError.message : String(markerError),
        });
      }
    }
  }

  private handleWorkspaceFailure(scopeKey: WorkspaceKey, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const count = this.state.recordFailure(`workspace:${scopeKey}`, "__list__", message);
    logEvent("sync_workspace_failure", { level: "error", scopeKey, count, error: message });
  }
}
