# Use one-to-one sync mappings

Each synchronized task is represented by exactly one personal issue and exactly one external issue. A personal issue cannot fan out to multiple external workspaces. This keeps identity and conflict handling unambiguous for the MVP, at the cost of requiring separate personal issues when the same real-world work must exist in more than one external workspace.
