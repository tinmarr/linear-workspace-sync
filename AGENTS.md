# Repository instructions

- Minimize Linear API calls to stay within rate limits. When changing sync or discovery, filter and batch requests where possible, reuse cached data, and avoid fetching details for unrelated records. Account for pagination and per-record requests.

- You may run `pnpm dev` and inspect its logs for representative testing. It connects to live production Linear workspaces and can make real changes. Estimate the remaining API buffer from the systemd schedule, recent service activity, and any runs in this session; exact quota headers are not required. Keep runs and API usage limited and leave a buffer below the hourly limits.
