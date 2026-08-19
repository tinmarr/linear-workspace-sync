# Preserve personal issues when external issues disappear

If an external issue is archived or deleted, the engine preserves the personal issue and its external link, pauses normal synchronization, adds a personal-only `sync:external-unavailable` state label, and mentions the user once. The engine never automatically deletes or archives the personal issue.

If the personal issue is archived or deleted while the external issue remains active and assigned to the user, the engine restores the personal issue when possible. If restoration is not possible, it creates a replacement personal issue and updates the mapping, without modifying the external issue.
