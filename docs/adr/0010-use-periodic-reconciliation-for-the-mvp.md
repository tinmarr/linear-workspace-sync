# Use periodic reconciliation for the MVP

The MVP uses periodic reconciliation as its primary synchronization mechanism, running every five minutes by default with a configurable interval. Future webhook or event integrations may trigger the same reconciliation logic, but they are not required for correctness. This prioritizes a dependable recovery path and keeps the first implementation focused on one synchronization model.
