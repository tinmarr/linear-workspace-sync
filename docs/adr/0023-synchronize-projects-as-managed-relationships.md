# Synchronize projects as managed relationships

Status: accepted

Projects are synchronized with the same explicit personal routing and eligible inbound discovery model as issues. A project mapping pairs a personal project with an external project through an explicit personal project link, never by title matching; an eligible inbound issue may trigger creation of its project representation, but only issues that already qualify for issue synchronization are imported. After creation, project mappings are independent managed relationships, like subissues and native issue relationships, so issue discovery cannot deactivate, reroute, or delete them. Project name, description, status, priority, start date, target date, and the authenticated user's lead and member roles synchronize bidirectionally. Project issue membership synchronizes only between mapped endpoints and follows managed relationship change handling. Project statuses use separate logic with hard-coded canonical mappings when available and exact-name matching otherwise. Project labels, teams, other members, milestones, initiatives, updates, comments, integrations, and presentation metadata remain workspace-local. Archived projects are ignored silently without broken markers, notifications, or automatic issue changes.

## Consequences

- A personal project can have a separate mapped counterpart for each external workspace, while each project mapping remains one-to-one within its workspace.
- Project mapping state needs its own persisted snapshots and rebuildable identity, independent of issue mappings.
- A project can remain mapped even when none of its issues are currently eligible or mapped.
