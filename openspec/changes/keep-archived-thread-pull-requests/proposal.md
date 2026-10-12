## Why

An archived thread loses its PR on the Jira page: BB tears down its environment, so the live PR lookup returns nothing. Threads that an agent starts from a linked thread also show nowhere, because they carry no ticket key.

## What Changes

- The plugin saves the last PR it saw for each linked thread. When BB has no live PR, the chip shows the saved one.
- A new child thread of a linked thread gets the parent's ticket, unless it already has one.
- Out of scope: a server-side PR lookup for threads archived before the page saw their PR.

## Capabilities

### Modified Capabilities

- `jira-ticket-list`: a thread chip falls back to the saved PR.
- `jira-thread-link`: child threads inherit the parent's link.

## Impact

- New table `thread_pull_requests` (append-only migration).
- New RPC `savePullRequest`. `linkedThread` gets `pullRequest`.
- `thread.created` listener in `server.ts`.
