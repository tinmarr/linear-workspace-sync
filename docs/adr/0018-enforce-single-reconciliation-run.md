# Enforce a single reconciliation run

Only one reconciliation run may be active at a time. The preferred enforcement mechanism is systemd service behavior; the process must also support an application-level lock as a fallback. If a timer fires during an active run, the new invocation exits safely without concurrent writes.
