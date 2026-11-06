# Linear workspace sync

Periodic synchronization between a personal Linear workspace and one or more external workspaces. The supported deployment is a rootless Podman container managed by a systemd user service and timer.

The sync includes explicitly routed projects as well as issues. A project uses the external workspace's `routing_label` as a project label. External projects led by the authenticated user are discovered even without issues, and an eligible synchronized issue can also bring in its external project. Project links, project resources, issue resources, core project fields including the short summary and full description, milestones including their descriptions, and the authenticated user's lead or member role are synchronized independently from issue mappings. Project dependencies synchronize when both projects are mapped; milestone anchors also require mapped milestones. Mapped issue milestone membership is synchronized when the issue, project, and milestone are all mapped. Resources are matched by URL, and the special personal link that identifies a mapped issue or project is kept out of resource synchronization.

## Issue and project conflicts

Core issue fields use changes since the last successful sync, rather than the issue's overall last-edit time. A label, assignment, or other unrelated edit must not decide which description wins. Empty and absent descriptions compare equally.

When both sides change the same field to different values, the syncer preserves both values and adds `sync:conflict` on the personal issue. To choose the personal issue as the source of truth, edit it to contain the desired values and remove `sync:conflict`. On the next run, its core fields and managed resources overwrite the external issue. A failed overwrite remains pending for retry. Mapping collisions still require correcting the mapping. For a recorded project field or resource conflict, removing the personal project's `sync:conflict` label similarly selects its synchronized fields and managed resources to overwrite the external project. Milestone conflicts still require converging the compared values.

Conflict comments identify the affected fields, show compact comparisons of the workspace values, and explain how to resolve an issue or project field conflict. Text comparisons include changed lines with limited context; long diffs are truncated. Failed comments are retried on later runs. If the optional notification app token is rejected for authentication, comments fall back to the personal workspace API client. Existing notification records written by older versions may already suppress previously failed comments.


## Linear API limits

Linear applies separate hourly request and query-complexity limits. Its published limits are:

| Authentication | Requests per hour | Complexity points per hour | Scope |
| --- | ---: | ---: | --- |
| API key | 2,500 | 3,000,000 | Authenticated user |
| OAuth app | 5,000 | 2,000,000 | User or app user |
| Unauthenticated | 600 | 100,000 | IP address |

A single query is limited to 10,000 complexity points. API keys belonging to the same user share that user's quota, and some operations have lower endpoint-specific limits. Linear uses a leaky bucket, so quota refills continuously. Check the `X-RateLimit-Requests-*`, `X-RateLimit-Complexity-*`, and, where applicable, `X-RateLimit-Endpoint-Requests-*` response headers for current limits and remaining capacity. Leave a buffer for other activity and stop before reaching the limits, especially when running `pnpm dev` against live production workspaces.

Linear may change these limits or grant higher ones. See [Linear's rate limiting documentation](https://linear.app/developers/rate-limiting) for current details and rate-limit error handling.

## Development

```sh
pnpm install
cp config.example.toml config.toml
pnpm exec tsx --test tests/*.test.ts
pnpm typecheck
pnpm build
```

Set the API key environment variables named by `api_key_env` in `config.toml` before running the service locally. For app-authored personal sync notifications, enable **client credentials tokens** in the Linear OAuth app settings for the personal workspace and set `LINEAR_NOTIFICATION_CLIENT_ID` and `LINEAR_NOTIFICATION_CLIENT_SECRET`. No browser authorization or redirect callback is used. Ensure the app has access to the teams containing the issues to comment on.

The service requests a fresh app token at the start of each sync run with `read,comments:create` scopes, reuses it for that run, and renews once on an authentication failure. Tokens are kept in memory only. Token acquisition failures stop the run; comment authentication failures after renewal retain the personal-client fallback. Keep this app's scopes consistent across other uses, since requesting different scopes revokes its existing app tokens. See [Linear's client credentials documentation](https://linear.app/developers/oauth-2-0-authentication#client-credentials-tokens).

Optional top-level config keys `notification_client_id_env` and `notification_client_secret_env` override the credential environment variable names. Without client credentials, comments use the personal workspace client. Put both variables in the deployment's existing environment file.

```sh
LINEAR_PERSONAL_API_KEY=... \
LINEAR_WORK_API_KEY=... \
LINEAR_NOTIFICATION_CLIENT_ID=... \
LINEAR_NOTIFICATION_CLIENT_SECRET=... \
pnpm dev -- --config ./config.toml --force
```

## Image

The [Containerfile](Containerfile) builds a Node.js 26 Alpine image. GitHub Actions publishes it to GHCR on pushes to `main` and version tags.

```sh
podman build --tag linear-workspace-sync:local .
```

## Server deployment

Run these commands as the non-root user that owns the rootless Podman setup. The host is assumed to already have Podman and its systemd user manager configured.

The service uses these paths:

| Host path                                            | Used for                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `$XDG_CONFIG_HOME/linear-workspace-sync/config.toml` | application configuration, mounted as `/etc/linear-workspace-sync/config.toml` |
| `$XDG_CONFIG_HOME/linear-workspace-sync/env`         | Linear API keys, passed to the container with `--env-file`                     |
| `$XDG_STATE_HOME/linear-workspace-sync/`             | SQLite state db `state.db`                                                     |

Create the files and directories:

```sh
install -d -m 755 \
  $XDG_CONFIG_HOME/linear-workspace-sync \
  $XDG_CONFIG_HOME/systemd/user \
  $XDG_STATE_HOME/linear-workspace-sync
install -m 644 config.example.toml \
  $XDG_CONFIG_HOME/linear-workspace-sync/config.toml
install -m 600 /path/to/env \
  $XDG_CONFIG_HOME/linear-workspace-sync/env
```

Edit `config.toml` and `env`.

Install and start the systemd user timer:

```sh
install -m 644 systemd/linear-workspace-sync.service \
  $XDG_CONFIG_HOME/systemd/user/
install -m 644 systemd/linear-workspace-sync.timer \
  $XDG_CONFIG_HOME/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now linear-workspace-sync.timer
systemctl --user start linear-workspace-sync.service
```

View logs with:

```sh
journalctl --user -u linear-workspace-sync.service -f
```

The timer wakes the service every minute. Each run uses Podman’s `--pull=newer`, so the image is pulled only when its remote digest changes. To deploy immediately after a GitHub push, run `systemctl --user start linear-workspace-sync.service`.
