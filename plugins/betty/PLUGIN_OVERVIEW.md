Start and follow BETTY (PESTO) runs from bb.

## What you get

- A **BETTY** page in the left rail. It lists your runs from the last 14 days and every active run, grouped as **Needs a decision**, **In flight** and **Finished**. Tiles show the counts and the spend. Pull requests show as chips that open the pull request. The list reloads every 30 seconds.
- A **BETTY run** tab in the thread side panel. It shows a **Sign in to BETTY** button until you sign in, then a placeholder.

## How it works

The plugin calls BETTY's MCP endpoint at the `baseUrl` setting (default `https://betty.collibra.dev`) and keeps one MCP session for many calls. It signs in with OAuth in your browser. The token stays on the bb server and refreshes before it expires.
