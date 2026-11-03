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
- Tiles: "Needs a decision", "In flight", "Shipped", "Broke" and "Spend". Click a tile to show only its runs. Click it again to show all.
- "Outcomes" shows the success rate (shipped out of shipped and broke) and the mix of outcomes.
- "Runs per day" shows the runs of the last 14 days, by the day of their last activity.
- Groups: "Needs a decision", "In flight", "Finished". One line per run. "Finished" shows the newest 8 runs until you click "Show all".
- Each row shows its pull requests as chips with the number and state. Click a chip to open the pull request.
- The page reads the list again every 30 seconds and shows the time of the last read.
- Each PESTO query asks for 100 runs at most. When PESTO has more, the page says that older runs are cut off.
- When BETTY sends no email (an `api_key` connection), the page shows an error.

## Thread link

- A thread links to one BETTY run. The link is `{ runId }` in the thread's `betty` plugin metadata, so it stays after a bb restart.
- Status, steps and spend come live from `pesto_dag_status`. The plugin stores nothing else.
- The thread header shows the BETTY icon, a dot in the status colour, and the steps and spend, for example `6/14 · $4.10`. Hover shows the full label, `BETTY · Running · 6/14 · $4.10`. A click opens the "BETTY run" tab. The header reads the run again every 30 seconds.
- When BETTY cannot be read, the header shows `BETTY · unknown` and the tab shows the error or the sign-in button.
- A thread with no run shows "Run with BETTY". The ticket key comes from the `jira` plugin metadata (`issueKey`).
- "Run with BETTY" sends a prompt to the agent of the same thread. The agent starts the run with the pesto MCP, then calls `betty_link_run`.
- The `betty_link_run` agent tool takes `{ runId }`. It checks the run exists, then writes the link for the calling thread. It never starts a new thread.

## Status

- The PESTO client reads your identity, the run list, one run's nodes, and artifacts.
- The "BETTY run" tab shows the run id, status, steps, spend and pull requests of the linked run.

## Develop

```bash
bun install
bun run typecheck
bun run test
bun run build
```
