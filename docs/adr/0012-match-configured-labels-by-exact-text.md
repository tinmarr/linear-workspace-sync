# Match configured labels by exact text

The engine identifies configured routing and sync-state labels by exact text within each workspace. This is more accessible to configure through Linear's user interface than internal label identifiers. Missing or ambiguous text matches are configuration errors and must not be resolved by guessing; the affected personal issue receives `sync:broken` and one personal comment mentioning the user.
