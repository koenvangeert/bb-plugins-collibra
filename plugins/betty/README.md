# BETTY

A bb plugin to start and follow BETTY (PESTO) runs from bb. It talks to BETTY over its MCP endpoint.

## Set up

You need:

- bb 0.47 or later, and [bun](https://bun.sh).
- A BETTY account.
- The pesto MCP in your agent, to start runs. Reading runs does not need it.
- The GitHub CLI (`gh`), signed in with access to the run's repo, to show screenshots inline.

### 1. Install the plugin

```bash
git clone https://github.com/koenvangeert/bb-plugins-collibra.git
cd bb-plugins-collibra/plugins/betty
bun install
bun run build
bb plugin install "$PWD"
```

Check it: `bb plugin list` shows `betty@0.1.0` and asks you to sign in to BETTY. A "BETTY" page shows in the left rail.

### 2. Sign in to BETTY

1. Open the "BETTY" page in the left rail. You see "Sign in to BETTY".
2. Click it. Your browser opens the BETTY sign-in page.
3. Sign in. The browser shows "Signed in to BETTY. You can close this tab."
4. Go back to bb. The page now lists your runs.

Sign in from a browser on the machine that runs the bb server. BETTY sends the browser back to a local bb address.

### 3. Add the pesto MCP to your agent

For Claude Code:

```bash
claude mcp add --transport http --scope user pesto https://betty.collibra.dev/mcp
```

Then run `/mcp` in a Claude Code session and authenticate `pesto`. This is a second sign-in, for the agent. The plugin sign-in does not cover it.

For another agent, add `<baseUrl>/mcp` as an HTTP MCP server named `pesto`. Use your `baseUrl` when you changed it.

### 4. Start a run

1. Open a thread. If you want, link it to a Jira ticket with the `jira` plugin. It is in this repo at `plugins/jira`, and installs the same way.
2. Click "Run with BETTY" in the thread header. With a linked ticket it reads "Run with BETTY · KEY-123". The button greys out after one click. When the agent is busy, the prompt waits in the queue.
3. The agent gets the workflow template, shows you the DAG and the cost of each node, and waits.
4. Agree. The agent submits the run and calls `betty_link_run`.
5. The thread header now shows the run, for example `6/14 · $4.10`.

You can also ask the agent in your own words. The `betty` skill tells it to link the run after it submits.

## Pages

### BETTY page

- The "BETTY" page in the left rail lists your runs. "Your" means runs whose `owner_dev` is the email that `pesto_whoami` gives for your sign-in.
- It shows runs from the last 14 days and every run that is still active.
- Tiles: "Needs a decision", "In flight", "Shipped", "Broke" and "Spend". Click a tile to show only its runs. Click it again to show all.
- "Outcomes" shows the success rate (shipped out of shipped and broke) and the mix of outcomes.
- "Runs per day" shows the runs of the last 14 days, by the day of their last activity.
- Groups: "Needs a decision", "In flight", "Finished". One line per run. "Finished" shows the newest 8 runs until you click "Show all".
- Each row shows its pull requests as chips with the number and state. Click a chip to open the pull request.
- The page reads the list again every 30 seconds and shows the time of the last read.
- When BETTY sends a run that bb cannot read, the page leaves it out and says how many it left out.

### Thread header

- A thread links to one BETTY run.
- With a run, the header shows the BETTY icon, a dot in the status colour, and the steps and spend, for example `6/14 · $4.10`. Hover shows the full label, `BETTY · Running · 6/14 · $4.10`. A click opens the "BETTY run" tab.
- Without a run, the header shows "Run with BETTY". The ticket key comes from the `jira` plugin.
- When BETTY cannot be read, the header shows `BETTY · unknown`.
- The header reads the run again every 30 seconds.

### BETTY run tab

- The tab in the thread side panel shows a short run detail of the linked run. It has no run id or step columns. The steps are in a list that you open and close.
- Without a run, it shows "No BETTY run for this thread yet."
- It shows "Sign in to BETTY" until you sign in, and the error when BETTY cannot be read.

### Run detail

- Click a run title on the BETTY page to open its detail. "Back to runs" goes back to the list.
- The header shows the title, the outcome, the run id, and what the run spent. The title and outcome come from your run list, so a run you do not own shows only its id.
- "Clean run up to" adds the budgets of the steps that run when no condition fires. It leaves out the conditional fix-up steps (with a `when`) and the steps that wait on them, because PESTO skips those too. A step that waits on a fix-up step counts again when it already ran after that fix-up step was skipped, and an `always_run` step always counts. "Worst case up to" adds the budgets of all steps.
- Each pull request has an "Open PR" button, its repo, and `head → base`. Below it is the list of steps that acted on it (review, remediation, CI watch). Click an entry to open its review or comment on GitHub. An entry that has not happened yet shows "planned".
- The steps show in columns. A step's column is its longest path from a first step. Each step shows its status, its spend against its budget (or its executor when it has no budget), and when it runs.
- Each agent step that finished and checked the acceptance criteria lists them as met or not met, with the evidence and the screenshots. Click a screenshot to open it full size.
- Each step that started has an "Artifacts" button. It loads the step's artifacts, such as review findings and logs, when you click it.
- The detail reads the run again every 30 seconds.

### Decisions

- A step that waits for a decision (`suspended`) gets a card. The card shows why the step stopped and what it spent against its budget.
- "Approve" asks for a new budget and an optional hint. The budget starts at double the old budget. It must be more than the step spent, because PESTO refuses a lower budget.
- "Deny" asks for a reason. A denied step does not run again.
- "Stop run" shows while a step can still stop. Such a step is not finished, not pending and not `always_run`. It asks first. It stops the running and queued steps and denies the steps that wait for a decision, with the reason "Stopped from bb.". PESTO then cancels the steps that wait on them. `always_run` steps, for example the teardown, still run, and the question names them.
- When PESTO refuses to stop a step, the detail shows the step and the reason.

## Agent tools

| Tool | What it does |
| --- | --- |
| `betty_link_run` | Takes `{ runId }`. Checks that the run exists, then links it to the calling thread. It never starts a new thread. |
| `betty_status` | Status, steps done, spend, pull requests, and the steps that need a decision, failed or are running. |
| `betty_evidence` | The acceptance criteria evidence of a run. With `taskId`, the artifacts of a step. With `artifactId` and `offset`, one 3000-char page of an artifact. |

- `betty_status` and `betty_evidence` read the linked run when you give no `runId`.
- Each answer is under 4000 chars and ends with the next call to make.
- The tools need no pesto MCP. They use the plugin sign-in and work right after it, with no restart.
- The `betty` skill tells the agent when to use them.

### Run watcher

While you are signed in, the plugin checks each linked run every 30 seconds. When the run status changes to needs a decision, failed, cancelled or finished, it sends the thread one message. The message tells the agent to call `betty_status`. A run that is already in that status when you link it gets no message. When a thread links a new run, the plugin stops checking the old run.

## Setting

| Setting | Default | What it does |
| --- | --- | --- |
| `baseUrl` | `https://betty.collibra.dev` | The BETTY server. Must be `https`. The plugin calls `<baseUrl>/mcp`. |

Change it with `bb plugin config betty set baseUrl https://...`. A changed `baseUrl` needs a new sign-in.

## Sign-in details

- The plugin signs in with OAuth 2.1, with dynamic client registration and PKCE.
- BETTY sends the browser back to `<bb>/api/v1/plugins/betty/http/oauth/callback`. The plugin then reloads.
- Tokens stay in the plugin database on the bb server. They never go to the app or the log.
- The plugin refreshes the token one minute before it expires. When BETTY refuses the refresh, the plugin shows "Sign in to BETTY again".

## Limits

- Sign-in works only from a browser on the bb server machine. A remote bb, such as bb Connect or a phone, cannot sign in.
- The BETTY page needs your email from BETTY. An `api_key` connection sends none, so the page shows an error.
- Each PESTO query asks for 100 runs at most. When PESTO has more, the page says that older runs are cut off.
- Starting a run needs the pesto MCP in the agent. The plugin itself does not submit runs.
- "Clean run" and "Worst case" count one attempt per step, so a retried step can spend more.
- A pending run can show a clean run that is too low. A pending step that waits on a fix-up step counts as skipped until it runs.
- When a pull request's base is not `main`, CI may run only a few checks, so a green CI can mislead. The run detail and `betty_status` warn about it.
- Screenshots load with `gh` on the bb server. Without `gh`, or for a URL that is not a GitHub raw URL pinned to a commit, the run detail shows a link instead.
- Evidence that mentions faked backend data gets a warning. Read those criteria before you trust them.
- The plugin reads runs and decides on steps. It does not change a run's DAG or retry a failed run.

## Develop

```bash
bun install
bun run typecheck
bun run test
bun run build
```

After a build, `bb plugin reload betty` loads the new code.
