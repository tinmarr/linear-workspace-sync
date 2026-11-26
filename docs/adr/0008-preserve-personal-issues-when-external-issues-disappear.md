# Preserve personal issues when external issues disappear

If an external issue is archived or deleted, the engine preserves the personal issue and its external link, pauses normal synchronization, adds a personal-only `sync:external-unavailable` state label, and mentions the user once. The engine never automatically deletes or archives the personal issue.

When the personal issue is archived, normal synchronization pauses and the mapping is retained. Recovery for deleted personal issues is covered in [ADR 0009](0009-recover-personal-representations-for-active-external-work.md).
