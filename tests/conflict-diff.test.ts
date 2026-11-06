import assert from "node:assert/strict";
import { test } from "node:test";
import { formatConflictDiff } from "../src/conflict-diff.js";
import { ProjectSynchronizer } from "../src/project-sync.js";
import { SyncState } from "../src/state.js";
import { loadConfig } from "../src/config.js";

test("text conflicts show workspace labels, changed lines and compact context", () => {
  const prefix = Array.from({ length: 1000 }, (_, i) => `unchanged ${i}`).join("\n");
  const result = formatConflictDiff(["content"], { content: `${prefix}\npersonal edit\nend` },
    { content: `${prefix}\nexternal edit\nend` }, "Personal", "Work");
  assert.match(result, /```diff\n--- Personal\n\+\+\+ Work/);
  assert.match(result, /-personal edit\n\+external edit/);
  assert.match(result, / unchanged 999/);
  assert.doesNotMatch(result, /unchanged 998/);
});

test("simple values and empty descriptions are readable", () => {
  const result = formatConflictDiff(["targetDate", "description"], { targetDate: null, description: null },
    { targetDate: "2026-11-06", description: "added" }, "Personal", "Work");
  assert.match(result, /Personal: \(empty\)\nWork: 2026-11-06/);
  assert.match(result, /-\(empty\)\n\+added/);
});

test("large diffs are capped and embedded fences remain inside the code block", () => {
  const result = formatConflictDiff(["content"], { content: "```\n" + "old\n".repeat(500) },
    { content: "new\n".repeat(500) }, "Personal", "Work");
  assert.match(result, /````diff/);
  assert.match(result, /diff truncated/);
  assert.ok(result.length < 2200);
  assert.ok(result.endsWith("````"));
});

test("project notification includes the diff and retains notification deduplication", async () => {
  const config = await loadConfig("config.toml");
  const state = new SyncState(":memory:");
  const messages: string[] = [];
  const personal = { id: "p", labelNames: [config.syncLabels.conflict] };
  const client: any = { addPersonalProjectNotification: async (_id: string, body: string) => messages.push(body) };
  const sync: any = new ProjectSynchronizer(config, client, new Map(), state);
  try {
    for (let i = 0; i < 2; i++) {
      await sync.markProjectConflict(personal, config.external[0].key, ["content"],
        { content: "personal edit" }, { content: "external edit" });
    }
    assert.equal(messages.length, 1);
    assert.match(messages[0], /-personal edit\n\+external edit/);
    assert.match(messages[0], /remove sync:conflict to overwrite the external project/);
  } finally { state.close(); }
});
