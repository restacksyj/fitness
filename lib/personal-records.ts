export type PrType =
  | "heaviest_weight"
  | "estimated_1rm"
  | "set_volume"
  | "session_volume"
  | "set_reps"
  | "session_reps";

export type PrAchievement = {
  type: PrType;
  value: number;
  previousValue: number;
};

export type PrBaseline = {
  historicalSessions: number;
  maxWeight: number;
  maxEstimated1Rm: number;
  maxSetVolume: number;
  maxSessionVolume: number;
  maxSetReps: number;
  maxSessionReps: number;
};

export type PrSetInput = {
  id: string;
  reps: number;
  weight: number;
  completed: boolean;
};

export const EMPTY_PR_BASELINE: PrBaseline = {
  historicalSessions: 0,
  maxWeight: 0,
  maxEstimated1Rm: 0,
  maxSetVolume: 0,
  maxSessionVolume: 0,
  maxSetReps: 0,
  maxSessionReps: 0,
};

const exceeds = (value: number, previous: number) => value > previous + Number.EPSILON;

export function estimatedOneRepMax(weight: number, reps: number) {
  if (weight <= 0 || reps <= 0) return 0;
  return reps === 1 ? weight : weight * (1 + reps / 30);
}

export function calculatePrAchievements(
  sets: PrSetInput[],
  baseline: PrBaseline,
  bodyweight: boolean,
) {
  const result = new Map<string, PrAchievement[]>();
  let maxWeight = baseline.maxWeight;
  let maxEstimated1Rm = baseline.maxEstimated1Rm;
  let maxSetVolume = baseline.maxSetVolume;
  let maxSetReps = baseline.maxSetReps;
  let sessionVolume = 0;
  let sessionReps = 0;
  let sessionRecordAwarded = false;
  let hasComparableSet = baseline.historicalSessions > 0;

  for (const set of sets) {
    if (!set.completed || !Number.isFinite(set.reps) || set.reps <= 0 || !Number.isFinite(set.weight) || set.weight < 0) {
      result.set(set.id, []);
      continue;
    }

    const achievements: PrAchievement[] = [];
    const setVolume = set.weight * set.reps;
    const oneRm = estimatedOneRepMax(set.weight, set.reps);
    sessionVolume += setVolume;
    sessionReps += set.reps;

    if (hasComparableSet) {
      if (bodyweight) {
        if (exceeds(set.reps, maxSetReps)) achievements.push({ type: "set_reps", value: set.reps, previousValue: maxSetReps });
      } else {
        if (exceeds(set.weight, maxWeight)) achievements.push({ type: "heaviest_weight", value: set.weight, previousValue: maxWeight });
        if (exceeds(oneRm, maxEstimated1Rm)) achievements.push({ type: "estimated_1rm", value: oneRm, previousValue: maxEstimated1Rm });
        if (exceeds(setVolume, maxSetVolume)) achievements.push({ type: "set_volume", value: setVolume, previousValue: maxSetVolume });
      }
    }

    if (baseline.historicalSessions > 0 && !sessionRecordAwarded) {
      const sessionValue = bodyweight ? sessionReps : sessionVolume;
      const previousValue = bodyweight ? baseline.maxSessionReps : baseline.maxSessionVolume;
      if (exceeds(sessionValue, previousValue)) {
        achievements.push({ type: bodyweight ? "session_reps" : "session_volume", value: sessionValue, previousValue });
        sessionRecordAwarded = true;
      }
    }

    maxWeight = Math.max(maxWeight, set.weight);
    maxEstimated1Rm = Math.max(maxEstimated1Rm, oneRm);
    maxSetVolume = Math.max(maxSetVolume, setVolume);
    maxSetReps = Math.max(maxSetReps, set.reps);
    hasComparableSet = true;
    result.set(set.id, achievements);
  }

  const validSets = sets.filter((set) => set.completed && Number.isFinite(set.reps) && set.reps > 0 && Number.isFinite(set.weight) && set.weight >= 0);
  const firstSet = validSets[0];
  const setRecordTypes: PrType[] = bodyweight ? ["set_reps"] : ["heaviest_weight", "estimated_1rm", "set_volume"];
  const valueFor = (type: PrType, set: PrSetInput) => {
    if (type === "heaviest_weight") return set.weight;
    if (type === "estimated_1rm") return estimatedOneRepMax(set.weight, set.reps);
    if (type === "set_volume") return set.weight * set.reps;
    return set.reps;
  };
  const historicalValueFor = (type: PrType) => {
    if (type === "heaviest_weight") return baseline.maxWeight;
    if (type === "estimated_1rm") return baseline.maxEstimated1Rm;
    if (type === "set_volume") return baseline.maxSetVolume;
    return baseline.maxSetReps;
  };

  for (const type of setRecordTypes) {
    for (const [setId, achievements] of result) result.set(setId, achievements.filter((achievement) => achievement.type !== type));
    if (!firstSet) continue;

    const previousValue = baseline.historicalSessions > 0 ? historicalValueFor(type) : valueFor(type, firstSet);
    const winner = validSets.reduce((best, candidate) => {
      const candidateValue = valueFor(type, candidate);
      const bestValue = valueFor(type, best);
      if (candidateValue > bestValue + Number.EPSILON) return candidate;
      if (type === "heaviest_weight" && Math.abs(candidateValue - bestValue) <= Number.EPSILON && candidate.reps > best.reps) return candidate;
      return best;
    }, firstSet);
    const winnerValue = valueFor(type, winner);
    if (exceeds(winnerValue, previousValue)) {
      result.set(winner.id, [...(result.get(winner.id) ?? []), { type, value: winnerValue, previousValue }]);
    }
  }

  return result;
}

export const PR_LABELS: Record<PrType, string> = {
  heaviest_weight: "Heaviest Weight",
  estimated_1rm: "Best 1RM",
  set_volume: "Best Set Volume",
  session_volume: "Best Session Volume",
  set_reps: "Best Set Reps",
  session_reps: "Best Session Reps",
};

export function formatPrValue(type: PrType, value: number) {
  if (type === "set_reps" || type === "session_reps") return `${Math.round(value)} reps`;
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  return `${formatted} lbs`;
}
