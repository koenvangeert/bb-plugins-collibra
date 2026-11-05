Start and follow BETTY (PESTO) runs from bb.

## What you get

- A **BETTY** page in the left rail. It lists your runs from the last 14 days and every active run, grouped as **Needs a decision**, **In flight** and **Finished**. Tiles show the counts and the spend, and filter the list. Panels show the success rate, the outcome mix and the runs per day. Pull requests show as chips that open the pull request. The list reloads every 30 seconds.
- A **BETTY** button in the thread header. With a linked run it shows the BETTY icon, a status dot, and the steps done and spend, for example `6/14 · $4.10`. A click opens the run tab.
- A **Run with BETTY** button on a thread with no run. It asks the thread's agent to start a run for the linked Jira ticket with the pesto MCP.
- A **BETTY run** tab in the thread side panel. It shows the run and its pull requests, or a **Sign in to BETTY** button until you sign in.
- A `betty_link_run` agent tool. The agent calls it after it submits a run, to link the run to the thread.
- A run watcher. Every 30 seconds it checks each linked run. It sends the thread one message when the run needs a decision, fails, is cancelled or finishes.
- A **run detail** when you click a run. It shows the steps in columns with their status, spend against budget and run condition. It shows the spend so far, the most a clean run can cost (no conditional fix-up steps and no steps that wait on them) and the worst case (every step once). Each pull request has a link, the steps that reviewed or remediated it with links to GitHub, and a warning when its base is not `main`, because CI may then run only a few checks.
- **Acceptance criteria in the run detail.** Each step that checked the acceptance criteria in a browser lists them as met or not met, with the criterion text, the evidence and links to the screenshots. A warning shows when the evidence comes from faked backend data, because those checks did not run against real data. Each step that started has an **Artifacts** button. It loads the step's artifacts, such as review findings and logs, only when you click it.
- **Decisions from the run detail.** Approve a step that waits for a decision with a new budget and a hint, deny it with a reason, or stop the whole run. A stop still lets `always_run` steps such as the teardown run.

## How it works

The plugin calls BETTY's MCP endpoint at the `baseUrl` setting (default `https://betty.collibra.dev`) and keeps one MCP session for many calls. It signs in with OAuth in your browser. The token stays on the bb server and refreshes before it expires.
