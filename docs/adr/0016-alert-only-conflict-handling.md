# Use alert-only conflict handling

When a synchronization conflict is detected, the engine preserves both sides, adds the personal-only `sync:conflict` label, and mentions the user once. It does not provide a conflict-resolution command, resolution label, automatic winner, transfer, or conflict-driven update. If the compared values later converge through manual edits, the engine clears `sync:conflict` and resumes normal synchronization without pushing a winner.
