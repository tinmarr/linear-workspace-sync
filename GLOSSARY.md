# Linear Workspace Sync

This context defines the language for synchronizing a personal Linear workspace with external workspaces.

## Language

### Synchronization

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
A label that controls or communicates synchronization state in the personal workspace.
_Avoid_: system label, engine label

**Manual mapping**:
An explicit user-created sync mapping that pairs an existing personal issue with an existing external issue.
_Avoid_: guessed match, fuzzy match

**Personal sync link**:
A link on a personal issue that identifies the one external issue paired with it.
_Avoid_: reciprocal link, backlink

**Link precedence**:
The priority given to a valid personal sync link over label-based mapping or creation decisions.
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
A correspondence between workflow states in two workspaces.
_Avoid_: status translation, workflow guess

**Sync notification**:
A personal-workspace comment that mentions the user when the engine needs attention, without becoming part of synchronized issue comments.
_Avoid_: synced comment, external notification

**Core task field**:
A task attribute included in two-way synchronization for the MVP: title, description, status, due date, estimate, or priority.
_Avoid_: synced metadata, mirrored field

**Managed resource**:
An ordinary issue attachment or project external link synchronized by URL and display title or label. The personal issue or project link that identifies a sync mapping is synchronization metadata, not a managed resource.
_Avoid_: synced attachment, resource mirror

**Workspace-local metadata**:
Issue or project information owned by its workspace and excluded from ordinary synchronization, such as labels, team, cycle, documents, integrations, and comments.
_Avoid_: unsupported metadata, local-only field

**Assignee reflection**:
The one-way reflection of the user's external issue assignment on the corresponding personal issue.
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

**Creation destination**:
The explicitly configured team where the engine creates a new issue in a workspace.
_Avoid_: default team, inferred destination

### Issue relationships

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

### Projects

**Project**:
A Linear collection of issues organized around a shared goal, with its own lifecycle, dates, priority, description, and user assignments.

**Project mapping**:
The managed relationship between a personal project and an external project that represent the same project in one external workspace.
_Avoid_: project mirror, project association

**Project link**:
A link on a personal project that identifies the external project paired with it.
_Avoid_: project backlink, project URL marker

**Project routing**:
The personal-project signal that opts a project into synchronization with one external workspace, following the same explicit routing model as synchronized issues.
_Avoid_: project import flag, project destination guess

**Project sync trigger**:
A personal project route, an external project lead assignment, or an eligible inbound issue that can establish a project mapping.
_Avoid_: project sync dependency, issue-driven project lifecycle

**Inbound project trigger**:
An external project lead assignment or an eligible inbound issue belonging to an external project that makes the project eligible for representation in the personal workspace.
_Avoid_: project-wide import

**Project field**:
A project attribute synchronized between mapped projects for the MVP: name, description, status, priority, start date, or target date.
_Avoid_: project metadata, project mirror field

**Project issue membership**:
The relationship that places a mapped issue in a mapped project.
_Avoid_: project assignment, issue grouping

**Project milestone**:
A named phase or checkpoint belonging to a project, with its own description, target date, and order, used to organize mapped issues toward a goal.
_Avoid_: project phase, project checkpoint

**Milestone mapping**:
The managed relationship between a milestone on a personal project and its counterpart in an external workspace.
_Avoid_: milestone mirror, milestone pairing

**Milestone issue membership**:
The relationship that places a mapped issue in a mapped project milestone.
_Avoid_: milestone assignment, issue milestone grouping

**Milestone synchronization**:
The bidirectional synchronization of mapped milestone names, descriptions, target dates, order, and mapped issue membership between corresponding projects. Missing counterparts are created, and deleting or archiving one milestone removes its mapped counterpart.
_Avoid_: milestone mirroring

**Project assignment**:
The authenticated user's role on a project, including project lead or project member, which is synchronized between mapped projects.
_Avoid_: project ownership, project responsibility

**Project status mapping**:
A correspondence between project lifecycle statuses in two workspaces.
_Avoid_: workflow status mapping, issue status mapping, project state guess

**Independent project synchronization**:
The synchronization of a project mapping independently of the issues that may have triggered its creation.
_Avoid_: issue-driven project sync, derived project mapping

**Orphaned project mapping**:
A project mapping whose external project is unavailable.
_Avoid_: deleted project mapping, missing project
