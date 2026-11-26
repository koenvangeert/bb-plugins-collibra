Track the health of your codebase from its pull requests.

## What you get

- A **Codebase health** page in the sidebar. Pick 7, 30 or 90 days, a team, and one repository or all. A team is a GitHub team in the repository's CODEOWNERS, and its pull requests are the ones its members wrote.
- Tiles with the pull requests merged per day, the reviewer comments per pull request, the time to merge, and the share made by BETTY.
- A daily chart of the figure on the selected tile. Click a tile to show its trend: merges (BETTY and others), reviewer comments per PR, time to merge, or BETTY share.
- A table that compares BETTY pull requests with the others.

## How it works

The plugin reads merged pull requests from GitHub through your signed-in `gh` CLI. It keeps them in its own database and reads the newest days again every 30 minutes. A BETTY pull request has the `betty-pr-factory-app` label.
