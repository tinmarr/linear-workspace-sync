# Pause on conflicts and preserve both values

Status: superseded by ADR 0016

When the same synchronized field changes in both issues since the last successful synchronization, the engine leaves the external issue unchanged and adds a conflict label to the personal issue. The earlier design allowed a separate resolution label to authorize propagation, but that workflow was removed in favor of alert-only conflict handling.
