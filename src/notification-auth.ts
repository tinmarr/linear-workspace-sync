import { LinearClient } from "@linear/sdk";

type NotificationClient = Pick<LinearClient, "createComment">;

export function isAuthenticationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { status?: number }).status;
  return status === 401 || /authentication required|not authenticated|invalid.*token|token.*expired/i.test(error.message);
}

export async function createClientCredentialsNotificationClient(
  clientId: string,
  clientSecret: string,
  fetchToken: typeof fetch = fetch,
  createClient: (accessToken: string) => NotificationClient = (accessToken) => new LinearClient({ accessToken }),
): Promise<NotificationClient> {
  async function mintClient(): Promise<NotificationClient> {
    const response = await fetchToken("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "read,comments:create",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    // Do not include the response body, which may contain credentials, in errors.
    if (!response.ok) throw new Error(`Linear client credentials token request failed (HTTP ${response.status})`);
    const token: unknown = await response.json();
    if (!token || typeof token !== "object" || !("access_token" in token)
      || typeof token.access_token !== "string" || !token.access_token.trim()) {
      throw new Error("Linear client credentials response contained no access token");
    }
    return createClient(token.access_token);
  }

  let client = await mintClient();
  return {
    async createComment(input) {
      try {
        return await client.createComment(input);
      } catch (error) {
        if (!isAuthenticationFailure(error)) throw error;
        client = await mintClient();
        return client.createComment(input);
      }
    },
  };
}
