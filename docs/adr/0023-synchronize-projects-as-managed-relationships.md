# Synchronize projects as managed relationships

Status: accepted

Projects are synchronized with the same explicit personal routing and eligible inbound discovery model as issues. A project mapping pairs a personal project with an external project through an explicit personal project link, never by title matching; an eligible inbound issue may trigger creation of its project representation, but only issues that already qualify for issue synchronization are imported. After creation, project mappings are independent managed relationships, like subissues and native issue relationships, so issue discovery cannot deactivate, reroute, or delete them. Project name, description, status, priority, start date, target date, and the authenticated user's lead and member roles synchronize bidirectionally. Project milestones are managed child relationships of mapped projects: name, description, target date, and sort order synchronize bidirectionally, missing counterparts are created, and a deletion or archive removes the mapped counterpart. Milestone mappings use persisted IDs as the authority and exact names only as a bootstrap or recovery fallback; duplicate names are treated as ambiguous and left untouched. Project issue membership synchronizes only between mapped endpoints, including mapped milestone membership, and follows managed relationship change handling. Project statuses use separate logic with hard-coded canonical mappings when available and exact-name matching otherwise. Project labels, teams, other members, initiatives, updates, comments, integrations, and presentation metadata remain workspace-local. Archived projects are ignored silently without broken markers, notifications, or automatic issue changes.

## Consequences

- A personal project can have a separate mapped counterpart for each external workspace, while each project mapping remains one-to-one within its workspace.
- Project mapping state needs its own persisted snapshots and rebuildable identity, independent of issue mappings.
- Milestone mapping state and metadata snapshots are persisted independently from project and issue mappings, while issue milestone membership is stored with project membership state.
- A milestone moved to another mapped project follows its mapped counterpart; a move to an unmapped project leaves the local milestone in place and deactivates its mapping.
- A project can remain mapped even when none of its issues are currently eligible or mapped.
