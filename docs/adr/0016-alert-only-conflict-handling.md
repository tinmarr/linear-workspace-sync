# Use alert-only conflict handling

When a synchronization conflict is detected, the engine preserves both sides, adds the personal-only `sync:conflict` label, and mentions the user once. It does not provide a conflict-resolution command, resolution label, automatic winner, transfer, or conflict-driven update. If the compared values later converge through manual edits, the engine clears `sync:conflict` and resumes normal synchronization without pushing a winner.


## Issue resolution update, 2026-11-06

For an established issue mapping with a recorded conflict, removing the personal conflict label now explicitly selects the personal issue's core fields and managed resources to overwrite the external issue on the next successful sync. This replaces alert-only handling for issue field and resource conflicts because simply removing the label previously recreated it indefinitely; new conflicts still preserve both sides, mapping collisions still require correcting the mapping, and project and milestone conflicts retain the convergence policy. Core issue fields compare saved values rather than overall last-edit timestamps, since unrelated sync metadata edits also change those timestamps; absent and empty descriptions are equivalent.
