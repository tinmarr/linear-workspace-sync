import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function writeConfig(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "linear-sync-config-"));
  const path = join(directory, "config.toml");
  writeFileSync(path, source);
  return path;
}

const base = `
database_path = "/tmp/linear-sync.db"

[personal]
name = "personal"
api_key_env = "PERSONAL_KEY"
workspace_name = "Personal"
team_name = "Personal"

[external.work]
name = "work"
api_key_env = "WORK_KEY"
workspace_name = "Work"
workspace_slug = "work"
team_name = "Work"
routing_label = "sync:work"
personal_labels = ["frv:work", "priority:work"]
`;

describe("configuration", () => {
  it("requires a routing label for every external workspace", async () => {
    await expect(loadConfig(writeConfig(base.replace('routing_label = "sync:work"', ""))))
      .rejects.toThrow("work.routing_label");
  });

  it("rejects non-bijective status mappings", async () => {
    const source = `${base}
[sync.status_mappings.work]
Todo = "Open"
Done = "Open"
`;
    await expect(loadConfig(writeConfig(source))).rejects.toThrow("one-to-one");
  });

  it("loads an arbitrary number of external workspaces", async () => {
    const source = `${base}
[external.startup]
name = "startup"
api_key_env = "STARTUP_KEY"
workspace_name = "Startup"
workspace_slug = "startup"
team_name = "Startup"
routing_label = "sync:startup"

[external.side]
name = "side"
api_key_env = "SIDE_KEY"
workspace_name = "Side"
workspace_slug = "side"
team_name = "Side"
routing_label = "sync:side"
`;
    const loaded = await loadConfig(writeConfig(source));
    expect(loaded.external.map((workspace) => workspace.key)).toEqual(["work", "startup", "side"]);
  });

  it("loads personal labels for each external workspace", async () => {
    const loaded = await loadConfig(writeConfig(base));

    expect(loaded.external[0].personalLabels).toEqual(["frv:work", "priority:work"]);
    expect(loaded.personal.personalLabels).toEqual([]);
  });

  it("rejects duplicate personal labels", async () => {
    const source = base.replace(
      'personal_labels = ["frv:work", "priority:work"]',
      'personal_labels = ["frv:work", "frv:work"]',
    );

    await expect(loadConfig(writeConfig(source))).rejects.toThrow("must not contain duplicate labels");
  });
});
