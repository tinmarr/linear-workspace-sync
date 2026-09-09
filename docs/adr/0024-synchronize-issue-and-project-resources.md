# Synchronize issue and project resources

Status: accepted

Ordinary Linear links attached to synchronized issues and external links listed in synchronized projects are managed resources. Resource identity is the URL, while the display title or label is synchronized with it. A resource added, removed, or renamed on one side is applied to the other side; simultaneous non-convergent resource edits use the existing alert-only conflict flow. Newly created counterparts receive the source resources. Existing mappings with no resource snapshot are initialized without changing either side, preserving state created by earlier versions.

The personal issue link used to identify its external mapping and the personal project link used to identify its external project mapping are not managed resources. They remain personal synchronization metadata and are never copied to an external workspace. Other workspace-local metadata, including project labels, documents, integrations, and comments, remains outside this synchronization rule.
