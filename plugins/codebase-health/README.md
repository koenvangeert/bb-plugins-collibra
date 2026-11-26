# Codebase Health

A dashboard of codebase health figures. The first source is GitHub pull requests. More sources can follow.

## What it adds

A `Codebase health` page in the sidebar. Pick a period (7, 30 or 90 days), a team, and a repository, or all of them.

| Figure | How it is made |
| --- | --- |
| Merged per work day | Merged pull requests in the period, divided by the work days (Monday to Friday) in the period. |
| Reviewer comments per PR | The mean of the reviewer comments per merged pull request. |
| Time to merge | The median time from opening to merge, without the hours on Saturday and Sunday. The mean shows below it. Without this, a pull request open over a weekend makes Monday look slow. |
| Made by BETTY | The share of merged pull requests with the `betty-pr-factory-app` label. |
| Daily chart | The figure of the selected tile, per local work day. Weekends are left out of the chart, but their merges count in the tiles and the table. With all of several repositories shown, the chart splits per repository: one bar part per repository on the merged chart, and one colour per repository on the other charts. The tiles and the table stay totals. Every chart has a 5-day average line over the last 5 work days, computed from the pull requests of those days. With a team picked, the dashed all-teams line is also a 5-day average. Click a tile to change it. Merged per day shows BETTY and others stacked. The other tiles show a line: reviewer comments per PR, median time to merge, or BETTY share, of the pull requests merged that day. |
| BETTY against others | Merged count, reviewer comments, and median and mean time to merge, for each group. |

### Reviewer comments

A reviewer comment is one of these, written by someone who is not the pull request author:

- A conversation comment.
- A review with a summary text.
- An inline review comment.

Comments from bots and from `collibra-cicd` do not count. Comments from the author do not count, because BETTY posts its own reviews under the author's account.

### Teams

- A team is a GitHub team named in the repository's `CODEOWNERS` (`.github/CODEOWNERS`, `CODEOWNERS` or `docs/CODEOWNERS`).
- A team's pull requests are the ones its members wrote. Who owns the changed files does not count.
- A person in more than one team counts for each of them.
- The plugin uses today's team members, also for older pull requests.
- It reads the teams at the first sync and then every 6 hours. A team `gh` cannot see is left out.
- The Team menu also has **Me**: the pull requests of the `gh` user on the bb server, compared with everyone.
- Without a `CODEOWNERS` file, the Team menu has only **Me**.
- With a team picked, each tile compares the team with all teams, for example `+1.5 vs all (1.5)`. The merged tile shows the team's share of all merges. The BETTY tile shows the gap in percentage points. The trend charts add a dashed line for all teams.

## How the data is read

- A background service runs `gh api graphql` with a search per repository and per UTC day: `repo:<repo> is:pr is:merged merged:<day>`.
- The first sync reads 98 days, newest first: 90 days for the longest period, 7 for the first 5-day averages, and 1 because a local day can start on the UTC day before. It takes about 4 seconds per day per repository. The page shows the progress, and the figures fill in while it runs.
- After that, every 30 minutes, it reads the last 3 days again. Reviewers still comment for a short time after a merge.
- A day is marked read only after it is saved and has ended. A failed day, or a day read while still in progress, is read again at the next sync.
- A change to the `repositories` setting starts a sync at once.

## Setting

| Setting | Default | What it does |
| --- | --- | --- |
| `repositories` | `collibra/frontend` | The repositories to track, as `owner/name`, separated by commas. |

```bash
bb plugin config codebase-health set repositories "collibra/frontend,collibra/dgc-core"
```

## Limits

- Only merged pull requests count. Pull requests closed without a merge are not in the figures.
- The plugin reads the first 100 conversation comments and the first 100 reviews of a pull request.
- GitHub search gives 1000 results at most. A repository that merges more than 1000 pull requests on one day shows an error for that day.
- Without a signed-in `gh` on the bb server, the page shows the `gh` error for each repository.
- A pull request made by BETTY before the label existed counts as "others".

## Development

```bash
bun install
bun run test && bun run typecheck
bb plugin build
```
