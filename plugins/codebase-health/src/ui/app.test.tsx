// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot, type CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { buildMetrics, type WindowDays } from "../metrics";
import type { MergedPullRequest } from "../pullRequest";
import type { Dashboard } from "../rpc";

const NOW = new Date(2026, 10, 25, 15, 0).getTime();
const HOUR = 3_600_000;

function pr(overrides: Partial<MergedPullRequest>): MergedPullRequest {
  return { repo: "a/one", number: 1, author: "dev", createdAt: NOW - 3 * HOUR, mergedAt: NOW - HOUR, isBetty: false, reviewerComments: 2, ...overrides };
}

function dashboardOf(input: { windowDays: WindowDays; repo: string | null; team?: string | null }, overrides: Partial<Dashboard> = {}): Dashboard {
  const pullRequests = [
    pr({ isBetty: true, reviewerComments: 6, createdAt: NOW - 25 * HOUR }),
    pr({ reviewerComments: 2 }),
    pr({ reviewerComments: 1, createdAt: NOW - 1.5 * HOUR }),
    pr({ reviewerComments: 3 }),
  ];
  return {
    repos: ["a/one", "a/two"],
    repo: input.repo,
    teams: ["@me", "collibra/ai-governance", "collibra/dq-frontend"],
    viewer: "koenvangeert",
    team: input.team ?? null,
    windowDays: input.windowDays,
    metrics: buildMetrics(pullRequests, NOW, input.windowDays),
    baseline: input.team
      ? buildMetrics(
          [...pullRequests, ...[1, 2, 3, 4].map(() => pr({ reviewerComments: 0, createdAt: NOW - 5 * HOUR }))],
          NOW,
          input.windowDays,
        )
      : null,
    byRepo: input.repo
      ? null
      : ["a/one", "a/two"].map((repo) => ({ repo, daily: buildMetrics(pullRequests, NOW, input.windowDays).daily })),
    syncing: false,
    historyDaysRead: 182,
    historyDaysTotal: 182,
    errors: [],
    syncedAt: NOW,
    ...overrides,
  };
}

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../../app"));
});

afterEach(() => cleanup());

type DashboardInput = { windowDays: WindowDays; repo: string | null; team: string | null };

function render(dashboard: (input: DashboardInput) => Dashboard | Promise<Dashboard>) {
  return renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { dashboard: (input: unknown) => dashboard(input as DashboardInput) } });
}

describe("Codebase health page", () => {
  it("shows a loading state until the first figures arrive", async () => {
    const slot = render(() => new Promise<Dashboard>(() => {}));

    expect(await slot.findByText("Loading codebase health…")).toBeTruthy();
  });

  it("shows merges per day, reviewer comments, time to merge and the BETTY share", async () => {
    const slot = render((input) => dashboardOf(input));
    const totals = await slot.findByRole("region", { name: "Totals" });

    expect(totals.textContent).toContain("Merged per work day0.2");
    expect(totals.textContent).toContain("Reviewer comments per PR3.0");
    expect(totals.textContent).toContain("Time to merge2.0hMedian · mean 7.1h");
    expect(totals.textContent).toContain("Made by BETTY25%1 of 4");
    expect(totals.querySelector("[data-tone]")).toBeNull();
    expect(slot.getByLabelText(/^Merged pull requests per day from Oct 27 to Nov 25$/)).toBeTruthy();
  });

  it("compares BETTY pull requests with the others", async () => {
    const slot = render((input) => dashboardOf(input));
    const table = await slot.findByRole("region", { name: "BETTY against others" });
    const row = (name: string) =>
      Array.from(table.querySelectorAll("tr")).find((tr) => tr.querySelector("th")?.textContent === name)!.textContent;

    expect(row("Pull requests merged")).toBe("Pull requests merged134");
    expect(row("Reviewer comments per PR")).toBe("Reviewer comments per PR6.02.03.0");
    expect(row("Median time to merge")).toBe("Median time to merge24.0h2.0h2.0h");
  });

  it("asks for the picked period, repository and team", async () => {
    const dashboard = vi.fn((input: DashboardInput) => dashboardOf(input));
    const slot = render(dashboard);
    await slot.findByRole("region", { name: "Totals" });

    await act(async () => slot.getByRole("button", { name: "7 days" }).click());
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Repository"), { target: { value: "a/two" } });
    });

    await act(async () => {
      fireEvent.change(slot.getByLabelText("Team"), { target: { value: "collibra/dq-frontend" } });
    });

    expect(dashboard).toHaveBeenLastCalledWith({ windowDays: 7, repo: "a/two", team: "collibra/dq-frontend" });
    expect(Array.from((slot.getByLabelText("Team") as HTMLSelectElement).options, (option) => option.text)).toEqual([
      "All teams",
      "Me (koenvangeert)",
      "ai-governance",
      "dq-frontend",
    ]);
    expect(slot.getByRole("button", { name: "7 days" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the figure of the clicked card in the chart", async () => {
    const slot = render((input) => dashboardOf(input));
    const comments = await slot.findByRole("button", { name: /^Reviewer comments per PR/ });
    expect(slot.getByLabelText(/^Merged pull requests per day from/)).toBeTruthy();

    await act(async () => comments.click());

    expect(comments.getAttribute("aria-pressed")).toBe("true");
    expect(slot.getByRole("heading", { name: "Reviewer comments per PR, by day of merge" })).toBeTruthy();
    expect(slot.getByLabelText(/^Reviewer comments per PR, by day of merge from Oct 27 to Nov 25$/)).toBeTruthy();
    expect(slot.getByRole("region", { name: "Reviewer comments per PR, by day of merge" }).textContent).not.toContain("Others");

    await act(async () => slot.getByRole("button", { name: /^Time to merge/ }).click());
    expect(slot.getByRole("heading", { name: "Median time to merge, by day of merge" })).toBeTruthy();

    await act(async () => slot.getByRole("button", { name: /^Made by BETTY/ }).click());
    expect(slot.getByRole("heading", { name: "Share made by BETTY, by day of merge" })).toBeTruthy();
  });

  it("keeps the newest period when an older request answers last", async () => {
    let answerThirtyDays!: () => void;
    const slot = render((input) =>
      input.windowDays === 30
        ? new Promise<Dashboard>((resolve) => (answerThirtyDays = () => resolve(dashboardOf(input))))
        : dashboardOf(input),
    );
    await act(async () => (await slot.findByRole("button", { name: "7 days" })).click());
    await slot.findByRole("region", { name: "Totals" });

    await act(async () => answerThirtyDays());

    expect(slot.getByLabelText(/^Merged pull requests per day from Nov 19 to Nov 25$/)).toBeTruthy();
  });

  it("shows how much history is read while the first sync runs", async () => {
    const slot = render((input) => dashboardOf(input, { historyDaysRead: 40, syncing: true }));

    expect(await slot.findByText(/^Reading history from GitHub: 40 of 182 days\./)).toBeTruthy();
  });

  it("compares a picked team with all teams on every card and on the trend chart", async () => {
    const slot = render((input) => dashboardOf(input));
    await slot.findByRole("region", { name: "Totals" });

    await act(async () => {
      fireEvent.change(slot.getByLabelText("Team"), { target: { value: "collibra/dq-frontend" } });
    });
    const badges = Array.from(slot.getByRole("region", { name: "Totals" }).querySelectorAll("[data-tone]"), (badge) => [
      badge.textContent,
      badge.getAttribute("data-tone"),
    ]);

    expect(badges).toEqual([
      ["50% of all merges", "neutral"],
      ["▲+1.5 vs all (1.5)", "worse"],
      ["▼-2.0h vs all (4.0h)", "better"],
      ["▲+13 pts vs all (13%)", "better"],
    ]);

    await act(async () => {
      fireEvent.change(slot.getByLabelText("Repository"), { target: { value: "a/one" } });
    });
    await act(async () => slot.getByRole("button", { name: /^Reviewer comments per PR/ }).click());
    const legend = slot.getByRole("region", { name: "Reviewer comments per PR, by day of merge" }).textContent;
    expect(legend).toContain("dq-frontend");
    expect(legend).toContain("All teams");
  });

  it("splits the chart per repository when all repositories are shown", async () => {
    const slot = render((input) => dashboardOf(input));
    const chartLegend = async () =>
      (await slot.findByRole("region", { name: "Merged pull requests per day" })).textContent;

    expect(await chartLegend()).toBe(`Merged pull requests per dayOct 27 to Nov 25onetwo5-day average`);

    await act(async () => {
      fireEvent.change(slot.getByLabelText("Repository"), { target: { value: "a/one" } });
    });

    expect(await chartLegend()).toContain("OthersBETTY5-day average");
  });

  it("hides the team filter when the repository names no teams", async () => {
    const slot = render((input) => dashboardOf(input, { teams: [] }));
    await slot.findByRole("region", { name: "Totals" });

    expect(slot.queryByLabelText("Team")).toBeNull();
  });

  it("names a repository that GitHub cannot read", async () => {
    const slot = render((input) =>
      dashboardOf(input, { errors: [{ repo: "a/two", message: "gh auth login" }] }),
    );

    expect((await slot.findByRole("alert")).textContent).toBe("Cannot read a/two from GitHub: gh auth login");
  });
});
