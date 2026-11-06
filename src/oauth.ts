import { LinearClient } from "@linear/sdk";

export function isAuthenticationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as { status?: number; response?: { status?: number; errors?: Array<{ extensions?: { code?: string; type?: string } }> }; message?: string; type?: string };
  return failure.status === 401 || failure.response?.status === 401 || failure.type === "AuthenticationError"
    || Boolean(failure.response?.errors?.some(({ extensions }) =>
      extensions?.code === "AUTHENTICATION_ERROR" || extensions?.type === "authentication error"))
    || /authentication required|not authenticated|invalid.*token|token.*expired/i.test(failure.message ?? "");
}

export async function createClientCredentialsClient(
  clientId: string,
  clientSecret: string,
  fetchToken: typeof fetch = fetch,
): Promise<LinearClient> {
  async function mintToken(): Promise<string> {
    const response = await fetchToken("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "read,write",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    // Never include the token response body in errors.
    if (!response.ok) throw new Error(`Linear client credentials token request failed (HTTP ${response.status})`);
    const token: unknown = await response.json();
    if (!token || typeof token !== "object" || !("access_token" in token)
      || typeof token.access_token !== "string" || !token.access_token.trim()) {
      throw new Error("Linear client credentials response contained no access token");
    }
    return token.access_token;
  }

  let accessToken = await mintToken();
  const client = new LinearClient({ accessToken });
  const request = client.client.request.bind(client.client);
  let renewing: Promise<void> | undefined;
  // Wrapping the transport also covers pagination and lazy SDK model requests.
  client.client.request = async <Data, Variables extends Record<string, unknown>>(
    document: string, variables?: Variables, headers?: RequestInit["headers"],
  ): Promise<Data> => {
    const usedToken = accessToken;
    try {
      return await request<Data, Variables>(document, variables, headers);
    } catch (error) {
      if (!isAuthenticationFailure(error)) throw error;
      if (usedToken === accessToken) {
        renewing ??= mintToken().then((token) => {
          client.client.setHeader("Authorization", `Bearer ${token}`);
          accessToken = token;
        }).finally(() => { renewing = undefined; });
        await renewing;
      }
      return request<Data, Variables>(document, variables, headers);
    }
  };
  return client;
}
