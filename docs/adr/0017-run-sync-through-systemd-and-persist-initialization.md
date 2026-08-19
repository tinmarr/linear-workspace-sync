# Run sync through systemd and persist initialization

The synchronization process is invoked by a systemd timer every five minutes by default, with the interval configurable. The first run performs a full initial reconciliation when durable sync state shows initialization has not completed; later runs use the normal reconciliation behavior. Initialization is determined from persisted sync state, not from timer invocations or process uptime.
