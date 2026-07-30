# Deactivate mappings without deleting data

Removing a personal routing label deactivates outbound participation without deleting either issue or changing the external issue. However, an external issue that remains assigned to the user stays eligible for inbound synchronization. On a later sync, the engine reuses the existing mapping, restores the personal routing label, and continues synchronization. There is no personal opt-out state for assigned external work. This preserves visibility of assigned external work while keeping label removal non-destructive.
