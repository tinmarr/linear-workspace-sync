# Linear workspace sync

Periodic synchronization between a personal Linear workspace and one or more external workspaces. The supported deployment is a rootless Podman container managed by a systemd user service and timer.

## Development

```sh
pnpm install
cp config.example.toml config.toml
pnpm typecheck
pnpm test
pnpm build
```

Set the API key environment variables named by `api_key_env` in `config.toml` before running the service locally:

```sh
LINEAR_PERSONAL_API_KEY=... \
LINEAR_WORK_API_KEY=... \
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
| `$XDG_STATE_HOME/linear-workspace-sync/env`          | Linear API keys, passed to the container with `--env-file`                     |

Create the files and directories:

```sh
install -d -m 755 \
  "$XDG_CONFIG_HOME/linear-workspace-sync" \
  "$XDG_CONFIG_HOME/systemd/user" \
  "$XDG_STATE_HOME/linear-workspace-sync"
install -m 644 config.example.toml \
  "$XDG_CONFIG_HOME/linear-workspace-sync/config.toml"
install -m 600 /path/to/env \
  "$XDG_CONFIG_HOME/linear-workspace-sync/env"
```

Edit `config.toml` and `env`.

Install and start the systemd user timer:

```sh
install -m 644 systemd/linear-workspace-sync.service \
  "$XDG_CONFIG_HOME/systemd/user/"
install -m 644 systemd/linear-workspace-sync.timer \
  "$XDG_CONFIG_HOME/systemd/user/"

systemctl --user daemon-reload
systemctl --user enable --now linear-workspace-sync.timer
systemctl --user start linear-workspace-sync.service
```

View logs with:

```sh
journalctl --user -u linear-workspace-sync.service -f
```

The timer wakes the service every minute. Each run uses Podman’s `--pull=newer`, so the image is pulled only when its remote digest changes. To deploy immediately after a GitHub push, run `systemctl --user start linear-workspace-sync.service`.
