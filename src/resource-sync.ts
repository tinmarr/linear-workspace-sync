import type { ResourceSnapshot } from "./domain.js";
import type { LinearResource } from "./linear.js";

export type ResourceSyncDirection = "personal-to-external" | "external-to-personal" | "conflict" | "none";

export type ResourceOperations = {
  add(resource: ResourceSnapshot): Promise<LinearResource>;
  update(resource: LinearResource, desired: ResourceSnapshot): Promise<LinearResource>;
  remove(resource: LinearResource): Promise<void>;
};

export function resourceSnapshots(resources: readonly ResourceSnapshot[] | undefined): ResourceSnapshot[] {
  return [...new Map((resources ?? []).map((resource) => [resource.url, {
    url: resource.url,
    title: resource.title,
  }])).values()].sort((left, right) => left.url.localeCompare(right.url));
}

export function resourcesEqual(
  left: readonly ResourceSnapshot[] | undefined,
  right: readonly ResourceSnapshot[] | undefined,
): boolean {
  const leftSnapshots = resourceSnapshots(left);
  const rightSnapshots = resourceSnapshots(right);
  return leftSnapshots.length === rightSnapshots.length
    && leftSnapshots.every((resource, index) => {
      const other = rightSnapshots[index];
      return resource.url === other.url && resource.title === other.title;
    });
}

export function resourceSyncDirection(
  personal: readonly LinearResource[],
  external: readonly LinearResource[],
  previous: readonly ResourceSnapshot[] | undefined,
  created: boolean,
): ResourceSyncDirection {
  if (created) {
    if (personal.length > 0 && external.length === 0) return "personal-to-external";
    if (external.length > 0 && personal.length === 0) return "external-to-personal";
    return "none";
  }
  if (previous === undefined) return "none";
  const personalChanged = !resourcesEqual(personal, previous);
  const externalChanged = !resourcesEqual(external, previous);
  if (personalChanged && externalChanged) {
    return resourcesEqual(personal, external) ? "none" : "conflict";
  }
  if (personalChanged) return "personal-to-external";
  if (externalChanged) return "external-to-personal";
  return "none";
}

export async function copyResources(
  source: readonly LinearResource[],
  target: LinearResource[],
  operations: ResourceOperations,
): Promise<void> {
  const desired = resourceSnapshots(source);
  const desiredUrls = new Set(desired.map((resource) => resource.url));
  const retained = new Set<string>();
  for (const resource of [...target]) {
    if (!desiredUrls.has(resource.url) || retained.has(resource.url)) {
      await operations.remove(resource);
      target.splice(target.indexOf(resource), 1);
      continue;
    }
    retained.add(resource.url);
  }

  for (const desiredResource of desired) {
    const existing = target.find((resource) => resource.url === desiredResource.url);
    if (!existing) {
      target.push(await operations.add(desiredResource));
    } else if (existing.title !== desiredResource.title) {
      target[target.indexOf(existing)] = await operations.update(existing, desiredResource);
    }
  }
}
