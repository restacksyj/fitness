import { describe, expect, test } from "bun:test";
import { calculatePrAchievements, EMPTY_PR_BASELINE, estimatedOneRepMax } from "./personal-records";

describe("personal records", () => {
  test("uses Epley for estimated 1RM", () => {
    expect(estimatedOneRepMax(100, 1)).toBe(100);
    expect(estimatedOneRepMax(100, 10)).toBeCloseTo(133.333, 2);
  });

  test("the first-ever set is a baseline and later sets can earn records", () => {
    const result = calculatePrAchievements([
      { id: "a", reps: 5, weight: 100, completed: true },
      { id: "b", reps: 5, weight: 105, completed: true },
    ], EMPTY_PR_BASELINE, false);
    expect(result.get("a")).toEqual([]);
    expect(result.get("b")?.map((item) => item.type)).toEqual(["heaviest_weight", "estimated_1rm", "set_volume"]);
  });

  test("ties do not earn records and collided records move to the strongest set", () => {
    const baseline = { ...EMPTY_PR_BASELINE, historicalSessions: 2, maxWeight: 100, maxEstimated1Rm: estimatedOneRepMax(100, 5), maxSetVolume: 500, maxSessionVolume: 2000 };
    const result = calculatePrAchievements([
      { id: "tie", reps: 5, weight: 100, completed: true },
      { id: "first", reps: 5, weight: 105, completed: true },
      { id: "second", reps: 5, weight: 110, completed: true },
    ], baseline, false);
    expect(result.get("tie")).toEqual([]);
    expect(result.get("first")).toEqual([]);
    expect(result.get("second")?.length).toBe(3);
  });

  test("moves equal-weight records to the set with more reps", () => {
    const baseline = { ...EMPTY_PR_BASELINE, historicalSessions: 2, maxWeight: 40, maxEstimated1Rm: estimatedOneRepMax(40, 8), maxSetVolume: 320, maxSessionVolume: 2000 };
    const result = calculatePrAchievements([
      { id: "set-2", reps: 9, weight: 45, completed: true },
      { id: "set-3", reps: 10, weight: 45, completed: true },
    ], baseline, false);
    expect(result.get("set-2")).toEqual([]);
    expect(result.get("set-3")?.map((achievement) => achievement.type).sort()).toEqual(["estimated_1rm", "heaviest_weight", "set_volume"].sort());
  });

  test("awards a session record only on the crossing set", () => {
    const baseline = { ...EMPTY_PR_BASELINE, historicalSessions: 1, maxWeight: 200, maxEstimated1Rm: 250, maxSetVolume: 1500, maxSessionVolume: 1000 };
    const result = calculatePrAchievements([
      { id: "a", reps: 5, weight: 100, completed: true },
      { id: "b", reps: 6, weight: 100, completed: true },
      { id: "c", reps: 5, weight: 100, completed: true },
    ], baseline, false);
    expect(result.get("a")?.some((item) => item.type === "session_volume")).toBe(false);
    expect(result.get("b")?.some((item) => item.type === "session_volume")).toBe(true);
    expect(result.get("c")?.some((item) => item.type === "session_volume")).toBe(false);
  });

  test("tracks bodyweight set and session reps", () => {
    const baseline = { ...EMPTY_PR_BASELINE, historicalSessions: 3, maxSetReps: 10, maxSessionReps: 18 };
    const result = calculatePrAchievements([
      { id: "a", reps: 11, weight: 0, completed: true },
      { id: "b", reps: 9, weight: 0, completed: true },
    ], baseline, true);
    expect(result.get("a")?.map((item) => item.type)).toContain("set_reps");
    expect(result.get("b")?.map((item) => item.type)).toContain("session_reps");
  });

  test("removes achievements when a completed set is unchecked", () => {
    const baseline = { ...EMPTY_PR_BASELINE, historicalSessions: 1, maxWeight: 100, maxEstimated1Rm: 110, maxSetVolume: 500, maxSessionVolume: 500 };
    const completed = calculatePrAchievements([{ id: "set", reps: 5, weight: 110, completed: true }], baseline, false);
    const unchecked = calculatePrAchievements([{ id: "set", reps: 5, weight: 110, completed: false }], baseline, false);
    expect(completed.get("set")?.length).toBeGreaterThan(0);
    expect(unchecked.get("set")).toEqual([]);
  });

  test("moves a session achievement when an edit changes the crossing set", () => {
    const baseline = { ...EMPTY_PR_BASELINE, historicalSessions: 1, maxWeight: 200, maxEstimated1Rm: 250, maxSetVolume: 1000, maxSessionVolume: 900 };
    const beforeEdit = calculatePrAchievements([
      { id: "a", reps: 5, weight: 100, completed: true },
      { id: "b", reps: 5, weight: 100, completed: true },
    ], baseline, false);
    const afterEdit = calculatePrAchievements([
      { id: "a", reps: 10, weight: 100, completed: true },
      { id: "b", reps: 5, weight: 100, completed: true },
    ], baseline, false);
    expect(beforeEdit.get("a")?.some((item) => item.type === "session_volume")).toBe(false);
    expect(beforeEdit.get("b")?.some((item) => item.type === "session_volume")).toBe(true);
    expect(afterEdit.get("a")?.some((item) => item.type === "session_volume")).toBe(true);
    expect(afterEdit.get("b")?.some((item) => item.type === "session_volume")).toBe(false);
  });
});
