# Linear workspace sync

This is a periodic, personal-hub sync engine for one personal Linear workspace and one or more external workspaces. The process runs through a systemd timer, uses the Linear TypeScript SDK, and stores only rebuildable mapping and snapshot state in SQLite.

## Request budget

The personal Linear API key is limited to 2,500 requests per hour. Treat that as a hard per-run budget: keep discovery scoped to the configured teams, preserve the adapter caches, and avoid adding per-issue SDK calls. The adapter batches label and attachment discovery, skips unused external-issue details, and reuses status, user, team, and issue lookups to stay within this limit.

After a Ratelimited response, wait for the API-provided reset time before another live run.

## Current MVP behavior

- One personal issue maps to at most one external issue.
- A valid external issue link on a personal issue always takes precedence over labels.
- A personal routing label without a link creates a new external issue.
- Non-archived issues assigned to the authenticated user are imported into the personal workspace.
- Completed issues are excluded from both workspace discovery and hydration on the initial run; later runs use normal discovery.
- Sync-specific labels, links, and notification comments are written only to personal issues.
- `personal_labels` configured on an external workspace are added to its corresponding personal issues; they are not routing labels and are not removed automatically.
- Core fields sync bidirectionally: title, description, status, due date, estimate, and priority.
- New external issues created from a personal routing label assign the authenticated user in both workspaces; later assignee changes flow from external to personal.
- Ordinary labels, teams, cycles, relations, parent links, and comments are not synchronized.
- Conflicts preserve both sides, add `sync:conflict` to the personal issue, and mention the user.
- Unexpected non-conflict conditions use `sync:broken` and a personal notification comment.
- Archived issues are excluded from discovery and normal synchronization.

## Local setup

```sh
pnpm install
cp config.example.toml config.toml
pnpm typecheck
pnpm test
pnpm build
```

Set one environment variable per configured workspace, using the names from `api_key_env` in the TOML file. Keep `config.toml`, credentials, and the SQLite database outside version control.

Run one reconciliation manually with:

```sh
LINEAR_PERSONAL_API_KEY=... \
LINEAR_WORK_API_KEY=... \
LINEAR_STARTUP_API_KEY=... \
pnpm dev -- --config ./config.toml --force
```

The process writes timestamped JSON progress events to stdout. Events identify the current phase and workspace without logging API keys or issue descriptions. For example, `linear_viewer_fetching` identifies a wait during authentication, while `linear_issue_query_starting` and `linear_issue_query_completed` bracket issue discovery.

The first run uses the current Linear labels, personal links, and assigned external issues to rebuild mappings. The SQLite file is a cache and snapshot store. If it is absent at startup, the process rebuilds it without changing issues merely because the file was missing.

## systemd

Build the project and install the compiled directory at the paths used by the unit files. Then place the TOML configuration at `/etc/linear-workspace-sync/config.toml` and the environment variables at `/etc/linear-workspace-sync/env`.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now linear-workspace-sync.timer
sudo systemctl start linear-workspace-sync.service
sudo journalctl -u linear-workspace-sync.service
```

The service is `Type=oneshot`. The timer wakes it every minute, while `poll_interval_seconds` in TOML controls the actual reconciliation interval and defaults to five minutes. The application lock prevents overlapping runs if a reconciliation takes longer than the wake interval.
