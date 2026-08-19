# Use TOML configuration and environment credentials

Non-secret deployment configuration is stored in a readable TOML file. It defines workspaces, creation destinations, sync label text, status overrides, polling, and the SQLite state path. Workspace credentials are supplied through environment variables and are never stored in the TOML file or SQLite database.
