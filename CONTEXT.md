# Linear Workspace Sync

This context defines the language for synchronizing a personal Linear workspace with external workspaces.

## Synchronization

**Personal workspace**:
The user's central Linear workspace that coordinates synchronized work across all connected workspaces.
_Avoid_: hub workspace, source workspace

**External workspace**:
A connected Linear workspace other than the personal workspace, such as the user's work or startup workspace.
_Avoid_: remote workspace, child workspace

**Sync mapping**:
The relationship between one personal issue and one external issue that represent the same task across workspaces.
_Avoid_: mirror pair, link, association

**Personal issue**:
An issue in the personal workspace that participates in a sync mapping or is eligible to create one.
_Avoid_: hub issue, source issue

**External issue**:
An issue in an external workspace that participates in a sync mapping with a personal issue.
_Avoid_: remote issue, mirror issue

**One-to-one mapping**:
A sync mapping always contains exactly one personal issue and exactly one external issue. A personal issue cannot map to multiple external issues.
_Avoid_: fan-out sync, one-to-many sync

**Sync label**:
A designated label in the personal workspace that identifies an external workspace as the destination for a synchronized issue and marks the issue as participating in sync.
_Avoid_: routing tag, workspace tag

**Sync-state label**:
A personal-workspace label that controls or communicates the current synchronization state of an issue, including routing, conflict, and broken states.
_Avoid_: sync flag, sync metadata

**Sync-control label**:
A `sync:*` label used by the engine or the user to control or communicate synchronization state in the personal workspace. Missing sync-control labels may be created automatically.
_Avoid_: system label, engine label

**Manual mapping**:
An explicit user-created sync mapping that pairs an existing personal issue with an existing external issue.
_Avoid_: guessed match, fuzzy match

**Personal sync link**:
A link on a personal issue that identifies the one external issue paired with it.
_Avoid_: reciprocal link, backlink

**Link precedence**:
When a personal issue contains a valid external issue link, that link determines or recovers the sync mapping and takes precedence over every label-based mapping or creation decision. The matching personal routing label is maintained from the linked external workspace.
_Avoid_: label precedence, create-first behavior

**Inbound issue**:
An external issue assigned to the user that qualifies to be represented in the personal workspace.
_Avoid_: imported issue, mirrored issue

**Conflict**:
A synchronization condition that cannot be safely resolved automatically, including concurrent changes to the same synchronized field or a one-to-one mapping collision.
_Avoid_: divergence, sync error

**Mapping conflict**:
A conflict in which more than one personal issue claims the same external issue, or a personal link contradicts an established one-to-one mapping.
_Avoid_: duplicate mapping, link error

**Conflict label**:
A reserved label on the personal issue indicating that synchronization is paused for a conflict until the compared values converge.
_Avoid_: error tag, warning label

**Broken sync state**:
A personal-only state indicating that an unexpected or unsupported synchronization condition outside the normal conflict flow requires user attention.
_Avoid_: edge-case label, sync error tag

**Inactive mapping**:
A previously established sync mapping that is no longer actively synchronizing because its personal routing label was removed and its external issue is not currently eligible for inbound synchronization.
_Avoid_: deleted mapping, broken mapping

**Inbound assignment**:
The user's assignment to an external issue, which makes that issue eligible for representation in the personal workspace and can reactivate an existing mapping.
_Avoid_: external opt-in, imported state

**Archived issue**:
An issue excluded from synchronization and inbound discovery regardless of its status or assignment.
_Avoid_: completed issue, inactive issue

**Status mapping**:
A one-to-one correspondence between workflow states in two workspaces, resolved by exact state-name match by default and overridable through a bidirectional sync configuration.
_Avoid_: status translation, workflow guess

**Sync notification**:
A personal-workspace comment that mentions the user when the engine needs attention, without becoming part of synchronized issue comments.
_Avoid_: synced comment, external notification

**Core task field**:
A task attribute included in two-way synchronization for the MVP: title, description, status, due date, estimate, or priority.
_Avoid_: synced metadata, mirrored field

**Workspace-local metadata**:
Issue information that remains owned by each workspace and is not overwritten by synchronization, including ordinary labels, team, cycle, and comments. Assignee is initialized in both workspaces when a personal issue creates a new external mapping, then reflected one way from external to personal. Native issue relationships are governed separately by the relationship synchronization rules.
_Avoid_: unsupported metadata, local-only field

**Assignee reflection**:
The user's assignee state on the external issue is reflected on the personal issue: outbound creation assigns the user in both workspaces, external assignment assigns the personal issue to the user, and external unassignment clears that personal assignment. Personal assignee changes do not update the external issue after creation.
_Avoid_: assignee synchronization, bidirectional assignment

**Orphaned mapping**:
A sync mapping whose external issue is archived or deleted, leaving the personal issue preserved while normal synchronization is paused.
_Avoid_: broken mapping, missing task

**Replacement personal issue**:
A newly created personal representation for an active external issue after the original personal issue was deleted and cannot be restored.
_Avoid_: duplicate personal issue, reimported task

**Reconciliation run**:
A periodic pass that compares eligible issues and established mappings across workspaces, applies safe changes, and records unresolved conditions.
_Avoid_: polling tick, sync cycle

**Initial reconciliation**:
The first full pass over configured workspaces and existing assigned work, performed before incremental periodic runs begin.
_Avoid_: first sync, bootstrap poll

**Sync state**:
Rebuildable engine state that caches mappings, prior synchronized values, initialization progress, and unresolved conditions across process runs without becoming the source of truth for issues.
_Avoid_: authoritative database, in-memory state, timer state

**State rebuild**:
The process of reconstructing sync state from Linear issues, personal links, sync labels, and configuration when the local state database is absent at startup.
_Avoid_: database restore, data migration

**Reconciliation lock**:
The single-run guard that prevents overlapping reconciliation runs from changing the same mappings concurrently.
_Avoid_: timer lock, process lock

**Creation destination**:
The explicitly configured team where the engine creates a new issue in a workspace.
_Avoid_: default team, inferred destination

**Workspace configuration**:
The deterministic set of identifiers and rules that describes a connected workspace, its creation team, and its sync labels or mappings.
_Avoid_: workspace guess, runtime discovery

**Deployment configuration**:
The non-secret TOML configuration that defines connected workspaces, creation teams, sync label text, personal labels, status overrides, polling, and state paths.
_Avoid_: database configuration, environment config

**Workspace credential**:
A secret environment-provided credential used to access one configured Linear workspace.
_Avoid_: database secret, checked-in token

**Text-matched label**:
A configured Linear label identified by its exact text within a workspace rather than by an internal identifier.
_Avoid_: label ID, fuzzy label match

## Issue relationships

**Issue relationship**:
A native Linear connection between two issues, such as related, blocks, duplicate, or parent-child.

**Dependency**:
An issue relationship that expresses ordering or prerequisite work, especially blocks or blocked by.

**Subissue**:
An issue that has a parent issue in an issue hierarchy.

**Managed relationship**:
An issue relationship that synchronization has copied or is tracking between corresponding issues.

**Relationship synchronization**:
The synchronization of native issue relationships between corresponding issues, including parent-child hierarchy, dependencies, related issues, and duplicate links.

## Projects

**Project**:
A Linear collection of issues organized around a shared goal, with its own lifecycle, dates, priority, description, and user assignments.

**Project mapping**:
The managed relationship between a personal project and an external project that represent the same project in one external workspace. It is treated like other synchronized relationships and remains independent after an issue has triggered or established it.
_Avoid_: project mirror, project association

**Project link**:
A link on a personal project that identifies the external project paired with it and takes precedence over label-based creation or discovery decisions.
_Avoid_: project backlink, project URL marker

**Project routing**:
The personal-project signal that opts a project into synchronization with one external workspace, following the same explicit routing model as synchronized issues.
_Avoid_: project import flag, project destination guess

**Project sync trigger**:
An explicit personal project route or an otherwise eligible inbound issue that belongs to an external project. A trigger may establish a project mapping, but issues do not control that mapping afterward.
_Avoid_: project sync dependency, issue-driven project lifecycle

**Inbound project trigger**:
An otherwise eligible inbound issue whose external project is not yet represented personally and therefore causes that project to be brought into the personal workspace.
_Avoid_: project-wide import, automatic project discovery

**Project field**:
A project attribute synchronized between mapped projects for the MVP: name, description, status, priority, start date, or target date.
_Avoid_: project metadata, project mirror field

**Project issue membership**:
The relationship that places a mapped issue in a mapped project and is synchronized only when both the issue and project mappings exist. Its additions, removals, and latest-edit behavior follow the managed relationship rules used for subissues and native issue relationships.
_Avoid_: project assignment, issue grouping

**Project assignment**:
The authenticated user's role on a project, including project lead or project member, which is synchronized between mapped projects.
_Avoid_: project ownership, project responsibility

**Project status mapping**:
A separate correspondence between project lifecycle statuses in two workspaces, using known hard-coded correspondences when available and exact status-name matching otherwise.
_Avoid_: workflow status mapping, issue status mapping, project state guess

**Independent project synchronization**:
The rule that a project mapping manages its own fields, assignments, and lifecycle after creation; an issue may trigger project creation but cannot later control the project mapping.
_Avoid_: issue-driven project sync, derived project mapping

**Orphaned project mapping**:
A project mapping whose external project is unavailable. Archived projects are ignored silently, without a broken marker, notification, or automatic issue mutation.
_Avoid_: deleted project mapping, missing project
