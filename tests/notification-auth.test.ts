import assert from "node:assert/strict";
import { test } from "node:test";
import { createClientCredentialsNotificationClient } from "../src/notification-auth.js";

test("client credentials are exchanged once and reused, with one renewal on rejected authentication", async () => {
  let exchanges = 0;
  const used: string[] = [];
  const fetchToken: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.linear.app/oauth/token");
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("grant_type"), "client_credentials");
    assert.equal(body.get("client_id"), "id");
    assert.equal(body.get("client_secret"), "secret");
    assert.equal(body.get("scope"), "read,comments:create");
    return Response.json({ access_token: `token${++exchanges}` });
  };
  const client = await createClientCredentialsNotificationClient("id", "secret", fetchToken, (token) => ({
    createComment: async () => {
      used.push(token);
      if (used.length === 2) throw new Error("Authentication required");
      return { success: true } as never;
    },
  }));
  await client.createComment({ issueId: "issue", body: "one" });
  await client.createComment({ issueId: "issue", body: "two" });
  await client.createComment({ issueId: "issue", body: "three" });
  assert.equal(exchanges, 2);
  assert.deepEqual(used, ["token1", "token1", "token2", "token2"]);
});

test("token failures omit response secrets and malformed tokens are rejected", async () => {
  await assert.rejects(createClientCredentialsNotificationClient("id", "secret", async () =>
    new Response("sensitive response", { status: 401 })), /^Error: Linear client credentials token request failed \(HTTP 401\)$/);
  await assert.rejects(createClientCredentialsNotificationClient("id", "secret", async () =>
    Response.json({ access_token: "" })), /no access token/);
});

test("non-authentication comment failures do not mint another token", async () => {
  let exchanges = 0;
  const client = await createClientCredentialsNotificationClient("id", "secret", async () => {
    exchanges++;
    return Response.json({ access_token: "token" });
  }, () => ({ createComment: async () => { throw new Error("Rate limit exceeded"); } }));
  await assert.rejects(client.createComment({ issueId: "issue", body: "comment" }), /Rate limit/);
  assert.equal(exchanges, 1);
});
