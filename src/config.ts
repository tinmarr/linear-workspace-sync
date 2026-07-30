import { readFile } from "node:fs/promises";
import { parse } from "@iarna/toml";
import type { AppConfig, WorkspaceConfig } from "./domain.js";

type RawWorkspace = {
  name?: string;
  api_key_env?: string;
  workspace_name?: string;
  workspace_slug?: string;
  team_name?: string;
  routing_label?: string;
  personal_labels?: string[];
};

type RawConfig = {
  poll_interval_seconds?: number;
  database_path?: string;
  personal?: RawWorkspace;
  external?: Record<string, RawWorkspace>;
  sync?: {
    conflict_label?: string;
    broken_label?: string;
    external_unavailable_label?: string;
    status_mappings?: Record<string, Record<string, string>>;
  };
};

function required(value: string | undefined, path: string): string {
  if (!value?.trim()) {
    throw new Error(`Missing required config value: ${path}`);
  }
  return value.trim();
}

function configuredLabels(value: unknown, path: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of non-empty label names`);
  }
  const labels = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${path}[${index}] must be a non-empty label name`);
    }
    return item.trim();
  });
  if (new Set(labels).size !== labels.length) {
    throw new Error(`${path} must not contain duplicate labels`);
  }
  return labels;
}

function workspaceConfig(
  key: string,
  raw: RawWorkspace | undefined,
  mappings: Record<string, string>,
): WorkspaceConfig {
  if (!raw) {
    throw new Error(`Missing workspace configuration: ${key}`);
  }

  const routingLabel = raw.routing_label?.trim() || undefined;
  if (key !== "personal" && !routingLabel) {
    throw new Error(`Missing required config value: ${key}.routing_label`);
  }

  return {
    key,
    name: required(raw.name, `${key}.name`),
    apiKeyEnv: required(raw.api_key_env, `${key}.api_key_env`),
    workspaceName: required(raw.workspace_name, `${key}.workspace_name`),
    workspaceSlug: raw.workspace_slug?.trim() || raw.workspace_name?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    teamName: required(raw.team_name, `${key}.team_name`),
    routingLabel,
    personalLabels: configuredLabels(raw.personal_labels, `${key}.personal_labels`),
    statusMappings: mappings,
  };
}

export async function loadConfig(path: string): Promise<AppConfig> {
  const source = await readFile(path, "utf8");
  const raw = parse(source) as RawConfig;
  const statusMappings = raw.sync?.status_mappings ?? {};
  const external = Object.entries(raw.external ?? {}).map(([key, value]) => {
    const mappings = statusMappings[key] ?? {};
    const values = Object.values(mappings);
    if (values.some((item) => !item.trim())) {
      throw new Error(`Status mappings for ${key} must use non-empty names`);
    }
    if (new Set(values).size !== values.length) {
      throw new Error(`Status mappings for ${key} must be one-to-one`);
    }
    return workspaceConfig(key, value, mappings);
  });

  if (external.length === 0) {
    throw new Error("At least one external workspace must be configured");
  }
  if (external.some((workspace) => workspace.key.toLowerCase() === "personal")) {
    throw new Error("The personal workspace is reserved as the central workspace");
  }
  const routingLabels = external.map((workspace) => workspace.routingLabel);
  if (new Set(routingLabels).size !== routingLabels.length) {
    throw new Error("External workspace routing labels must be unique");
  }
  const workspaceSlugs = external.map((workspace) => workspace.workspaceSlug);
  if (new Set(workspaceSlugs).size !== workspaceSlugs.length) {
    throw new Error("External workspace slugs must be unique");
  }

  const pollIntervalSeconds = raw.poll_interval_seconds ?? 300;
  if (!Number.isInteger(pollIntervalSeconds) || pollIntervalSeconds < 1) {
    throw new Error("poll_interval_seconds must be a positive integer");
  }

  return {
    pollIntervalSeconds,
    databasePath: required(raw.database_path, "database_path"),
    personal: workspaceConfig("personal", raw.personal, {}),
    external,
    syncLabels: {
      conflict: raw.sync?.conflict_label?.trim() || "sync:conflict",
      broken: raw.sync?.broken_label?.trim() || "sync:broken",
      externalUnavailable: raw.sync?.external_unavailable_label?.trim() || "sync:external-unavailable",
    },
  };
}
