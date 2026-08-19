# Preserve existing mappings on link collision

If a personal link targets an external issue already mapped to another personal issue, the engine treats the condition as a direct mapping conflict. It preserves the existing mapping, leaves the external issue unchanged, marks the involved personal issues with `sync:conflict`, and mentions the user. It never transfers the mapping automatically.
