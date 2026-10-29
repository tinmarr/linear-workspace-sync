# Repository instructions

- Minimize Linear API calls to stay within rate limits. When changing sync or discovery, filter and batch requests where possible, reuse cached data, and avoid fetching details for unrelated records. Account for pagination and per-record requests.

- You may run `pnpm dev` and inspect its logs for representative testing. It connects to live production Linear workspaces and can make real changes. Keep runs and API usage limited, account for the hourly rate limits, and always leave a buffer below them.
