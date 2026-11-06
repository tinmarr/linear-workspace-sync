import assert from "node:assert/strict";
import { test } from "node:test";
import { LinearClient } from "@linear/sdk";
import { createClientCredentialsClient } from "../src/oauth.js";
import { createPersonalSdkWorkspace, SdkLinearWorkspace } from "../src/sdk-adapter.js";
import { config } from "./helpers.js";

async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = original; }
}

function unauthorized() {
  return Response.json({ errors: [{ message: "Authentication required" }] }, { status: 401 });
}

test("OAuth transport reuses tokens and renews once for SDK reads and writes", async () => {
  let exchanges = 0;
  const used: string[] = [];
  await withFetch(async (url, init) => {
    if (String(url).endsWith("/oauth/token")) {
      const body = init?.body as URLSearchParams;
      assert.equal(body.get("grant_type"), "client_credentials");
      assert.equal(body.get("client_id"), "id");
      assert.equal(body.get("client_secret"), "secret");
      assert.equal(body.get("scope"), "read,write");
      return Response.json({ access_token: `token${++exchanges}` });
    }
    used.push(new Headers(init?.headers).get("Authorization")!);
    if (used.length === 2) return unauthorized();
    const query = JSON.parse(init?.body as string).query;
    return Response.json({ data: query.includes("CommentCreate")
      ? { commentCreate: { success: true } }
      : { viewer: { id: "app", email: "app@example.com", url: "app" } } });
  }, async () => {
    const client = await createClientCredentialsClient("id", "secret");
    assert.equal((await client.viewer).id, "app");
    assert.equal((await client.createComment({ issueId: "p", body: "test" })).success, true);
    assert.equal((await client.viewer).id, "app");
  });
  assert.equal(exchanges, 2);
  assert.deepEqual(used, ["Bearer token1", "Bearer token1", "Bearer token2", "Bearer token2"]);
});

test("persistent authentication failures retry only once, other failures do not renew", async () => {
  for (const status of [401, 429, 403]) {
    let exchanges = 0;
    let requests = 0;
    await withFetch(async (url) => {
      if (String(url).endsWith("/oauth/token")) return Response.json({ access_token: `token${++exchanges}` });
      requests++;
      return Response.json({ errors: [{ message: status === 401 ? "Authentication required" : "Forbidden or rate limited" }] }, { status });
    }, async () => {
      const client = await createClientCredentialsClient("id", "secret");
      await assert.rejects(client.viewer);
    });
    assert.equal(exchanges, status === 401 ? 2 : 1);
    assert.equal(requests, status === 401 ? 2 : 1);
  }
});

test("token failures omit response secrets and malformed tokens are rejected", async () => {
  await assert.rejects(createClientCredentialsClient("id", "secret", async () =>
    new Response("sensitive response", { status: 401 })), /^Error: Linear client credentials token request failed \(HTTP 401\)$/);
  await assert.rejects(createClientCredentialsClient("id", "secret", async () =>
    Response.json({ access_token: "" })), /no access token/);
});

test("personal operations use the app while assignments, roles and mentions retain human identity", async () => {
  const appConfig = config(":memory:");
  const human = { id: "human", email: "me@example.com", url: "https://linear.app/user/me", organization: { id: "tin" } };
  const requests: Array<{ auth: string | null; query: string; variables: any }> = [];
  await withFetch(async (_url, init) => {
    const auth = new Headers(init?.headers).get("Authorization");
    const { query, variables } = JSON.parse(init?.body as string);
    requests.push({ auth, query, variables });
    if (query.includes("SyncViewer")) return Response.json({ data: { viewer: auth === "human-key" ? human : { ...human, id: "app", email: "app@example.com" } } });
    if (query.includes("query issues(")) return Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } });
    if (query.includes("CommentCreate")) return Response.json({ data: { commentCreate: { success: true } } });
    return Response.json({ data: { attachmentDelete: { success: true } } });
  }, async () => {
    const workspace = await createPersonalSdkWorkspace(appConfig.personal, appConfig.external,
      new LinearClient({ apiKey: "human-key" }), new LinearClient({ accessToken: "app-token" }));
    assert.equal(workspace.viewerId, human.id);
    assert.equal(workspace.viewerEmail, human.email);
    await workspace.listIssues({ assignedToViewer: true });
    await workspace.addPersonalNotification("p", "Conflict");
    await workspace.removeIssueResource("attachment");
  });
  assert.equal(requests.filter(({ auth }) => auth === "human-key").length, 1);
  assert.ok(requests.slice(1).every(({ auth }) => auth === "Bearer app-token"));
  const issues = requests.find(({ query }) => query.includes("query issues("))!;
  assert.deepEqual(issues.variables.filter.assignee, { id: { eq: "human" } });
  assert.ok(requests.find(({ query }) => query.includes("CommentCreate"))!.variables.input.body.startsWith(human.url));
});

test("a mismatched OAuth workspace is rejected before synchronization", async () => {
  const appConfig = config(":memory:");
  await withFetch(async (_url, init) => Response.json({ data: { viewer: {
    id: "user", email: "me@example.com", url: "me", organization: {
      id: new Headers(init?.headers).get("Authorization") === "human-key" ? "tin" : "other",
    },
  } } }), async () => {
    await assert.rejects(createPersonalSdkWorkspace(appConfig.personal, [],
      new LinearClient({ apiKey: "human-key" }), new LinearClient({ accessToken: "app-token" })), /different workspaces/);
  });
});

test("concurrent authentication failures share one token renewal", async () => {
  let exchanges = 0;
  await withFetch(async (url, init) => {
    if (String(url).endsWith("/oauth/token")) return Response.json({ access_token: `token${++exchanges}` });
    if (new Headers(init?.headers).get("Authorization") === "Bearer token1") return unauthorized();
    return Response.json({ data: { ok: true } });
  }, async () => {
    const client = await createClientCredentialsClient("id", "secret");
    const results = await Promise.all([
      client.client.request("query { ok }"), client.client.request("query { ok }"),
    ]);
    assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  });
  assert.equal(exchanges, 2);
});

test("external workspace clients keep using their configured API key", async () => {
  const workspaceConfig = { ...config(":memory:").external[0], apiKeyEnv: "LINEAR_TEST_WORK_KEY" };
  const previous = process.env.LINEAR_TEST_WORK_KEY;
  process.env.LINEAR_TEST_WORK_KEY = "work-key";
  const used: Array<string | null> = [];
  try {
    await withFetch(async (_url, init) => {
      used.push(new Headers(init?.headers).get("Authorization"));
      const query = JSON.parse(init?.body as string).query;
      return Response.json({ data: query.includes("viewer")
        ? { viewer: { id: "work-human", email: "me@example.com", url: "me" } }
        : { attachmentDelete: { success: true } } });
    }, async () => {
      const workspace = await SdkLinearWorkspace.create(workspaceConfig, []);
      assert.equal(workspace.viewerId, "work-human");
      await workspace.removeIssueResource("attachment");
    });
    assert.deepEqual(used, ["work-key", "work-key"]);
  } finally {
    if (previous === undefined) delete process.env.LINEAR_TEST_WORK_KEY;
    else process.env.LINEAR_TEST_WORK_KEY = previous;
  }
});
