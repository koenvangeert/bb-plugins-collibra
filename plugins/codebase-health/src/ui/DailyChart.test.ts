import { describe, expect, it } from "vitest";
import type { DailyFigures } from "../metrics";
import { chartConfiguration, type Palette } from "./DailyChart";

const palette: Palette = { read: (_name, fallback) => fallback, text: "#000", grid: "#ccc", surface: "#fff", muted: "#666" };

const daily: DailyFigures[] = [
  {
    day: "2026-11-24",
    betty: 1,
    other: 3,
    avgReviewerComments: 2.5,
    medianHoursToMerge: 20,
    rolling: { mergedPerDay: 3, avgReviewerComments: 2, medianHoursToMerge: 18, bettyShare: 0.2 },
  },
  {
    day: "2026-11-25",
    betty: 0,
    other: 0,
    avgReviewerComments: null,
    medianHoursToMerge: null,
    rolling: { mergedPerDay: 2, avgReviewerComments: 2.2, medianHoursToMerge: 19, bettyShare: 0.25 },
  },
];

type YTicks = { callback(value: number): string };
const yTick = (metric: Parameters<typeof chartConfiguration>[1], value: number) =>
  (chartConfiguration(daily, metric, palette).options!.scales!.y!.ticks as unknown as YTicks).callback(value);

describe("chartConfiguration", () => {
  it("stacks BETTY and other merges with a 5-day average line for the merged view", () => {
    const config = chartConfiguration(daily, "merged", palette);

    expect(config.type).toBe("bar");
    expect(config.data.datasets.map((set) => [set.label, set.data])).toEqual([
      ["Others", [3, 0]],
      ["BETTY", [1, 0]],
      ["5-day average", [3, 2]],
    ]);
  });

  it("names the weekday of each day on the axis", () => {
    expect(chartConfiguration(daily, "merged", palette).data.labels).toEqual(["Tue Nov 24", "Wed Nov 25"]);
  });

  it("draws the daily figure with a gap on a day without merges, and its 5-day average", () => {
    const series = (metric: "comments" | "timeToMerge" | "bettyShare") =>
      chartConfiguration(daily, metric, palette).data.datasets.map((set) => [set.label, set.data]);

    expect(series("comments")).toEqual([
      ["Daily", [2.5, null]],
      ["5-day average", [2, 2.2]],
    ]);
    expect(series("timeToMerge")).toEqual([
      ["Daily", [20, null]],
      ["5-day average", [18, 19]],
    ]);
    expect(series("bettyShare")).toEqual([
      ["Daily", [0.25, null]],
      ["5-day average", [0.2, 0.25]],
    ]);
  });

  it("adds a dashed all-teams 5-day average to a trend view when a team is picked", () => {
    const baseline = daily.map((entry) => ({ ...entry, rolling: { ...entry.rolling, avgReviewerComments: 1 } }));

    const withTeam = chartConfiguration(daily, "comments", palette, baseline).data.datasets;
    const withoutTeam = chartConfiguration(daily, "comments", palette, null).data.datasets;

    expect(withTeam.map((set) => set.label)).toEqual(["Daily", "5-day average", "All teams, 5-day average"]);
    expect(withTeam[2]).toMatchObject({ data: [1, 1], borderDash: [4, 4] });
    expect(withoutTeam).toHaveLength(2);
    expect(chartConfiguration(daily, "merged", palette, baseline).data.datasets).toHaveLength(3);
  });

  it("stacks one bar part per repository and draws one line pair per repository when split", () => {
    const byRepo = [
      { repo: "collibra/frontend", daily },
      { repo: "collibra/dgc-core", daily: daily.map((entry) => ({ ...entry, other: 1, betty: 0 })) },
    ];

    const merged = chartConfiguration(daily, "merged", palette, null, byRepo).data.datasets;
    const comments = chartConfiguration(daily, "comments", palette, null, byRepo).data.datasets;

    expect(merged.map((set) => [set.label, set.data])).toEqual([
      ["frontend", [4, 0]],
      ["dgc-core", [1, 1]],
      ["5-day average", [3, 2]],
    ]);
    expect(comments.map((set) => set.label)).toEqual([
      "frontend: Daily",
      "frontend: 5-day average",
      "dgc-core: Daily",
      "dgc-core: 5-day average",
    ]);
    expect(comments[1]!.borderColor).not.toBe(comments[3]!.borderColor);
  });

  it("labels the axis in the unit of the view", () => {
    expect(yTick("comments", 2)).toBe("2.0");
    expect(yTick("timeToMerge", 30)).toBe("30.0h");
    expect(yTick("bettyShare", 0.5)).toBe("50%");
    expect(yTick("merged", 40)).toBe("40");
  });
});
