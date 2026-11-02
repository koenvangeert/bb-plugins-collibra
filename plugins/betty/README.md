# BETTY

A bb plugin that talks to BETTY (PESTO) over its MCP endpoint, so you can start and follow BETTY runs from bb.

## Setting

| Setting | Default | What it does |
| --- | --- | --- |
| `baseUrl` | `https://betty.collibra.dev` | The BETTY server. Must be `https`. The plugin calls `<baseUrl>/mcp`. |

Change it with `bb plugin config betty set baseUrl https://...`.

## Sign-in

- The plugin signs in to BETTY with OAuth 2.1: dynamic client registration and PKCE.
- Open the "BETTY run" tab and click "Sign in to BETTY". Your browser opens the BETTY sign-in page.
- BETTY sends the browser back to `<bb>/api/v1/plugins/betty/http/oauth/callback`. The plugin then reloads and runs.
- The plugin refreshes the token one minute before it expires. When BETTY refuses the refresh, the status says "Sign in to BETTY again".
- Tokens stay in the plugin database on the bb server. They never go to the app or the log.
- A changed `baseUrl` needs a new sign-in.

## Runs page

- The "BETTY" page in the left rail lists your runs. "Your" means runs whose `owner_dev` is the email that `pesto_whoami` gives for your sign-in.
- It shows runs from the last 14 days and every run that is still active.
- Groups: "Needs a decision", "In flight", "Finished". Tiles show the count of each group and the total spend.
- Each row shows its pull requests as chips with the number and state. Click a chip to open the pull request.
- The page reads the list again every 30 seconds and shows the time of the last read.
- Each PESTO query asks for 100 runs at most. When PESTO has more, the page says that older runs are cut off.
- When BETTY sends no email (an `api_key` connection), the page shows an error.

## Status

- The PESTO client reads your identity, the run list, one run's nodes, and artifacts.
- The "BETTY run" tab shows the sign-in button, or a placeholder when you are signed in.

## Develop

```bash
bun install
bun run typecheck
bun run test
bun run build
```
