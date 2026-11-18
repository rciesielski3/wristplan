// Why: only HR + repeat text was verified live (spike S1). Pace, power, distance and sub-minute/padded
// times follow documented syntax but are unverified live; pace ordering (slow-fast) is the likeliest to be wrong.
import type { End, RepeatStep, Step, Target, Workout } from "./model";
import { parseWorkout } from "./validate";

const pad2 = (n: number): string => String(n).padStart(2, "0");

const formatTime = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m${pad2(rest)}`;
};

const formatEnd = (end: End): string => {
  if (end.type === "time") return formatTime(end.seconds);
  return end.meters % 1000 === 0 ? `${end.meters / 1000}km` : `${end.meters}mtr`;
};

const formatPace = (secPerKm: number): string =>
  `${Math.floor(secPerKm / 60)}:${pad2(secPerKm % 60)}`;

const formatTarget = (target: Target): string => {
  switch (target.type) {
    case "hr":
      return `Z${target.zone} HR`;
    case "pace":
      return `${formatPace(target.slowSecPerKm)}-${formatPace(target.fastSecPerKm)}/km Pace`;
    case "power":
      return `${target.min}-${target.max}${target.unit === "watts" ? "w" : "%"}`;
  }
};

const stepLine = (step: Step | RepeatStep): string =>
  `- ${formatEnd(step.end)} ${formatTarget(step.target)}`;

const HEADERS = {
  warmup: "Warmup",
  work: "Work",
  recovery: "Recovery",
  cooldown: "Cooldown",
} as const;

const section = (step: Workout["steps"][number]): string =>
  step.kind === "repeat"
    ? [`Main set ${step.times}x`, ...step.steps.map(stepLine)].join("\n")
    : [HEADERS[step.kind], stepLine(step)].join("\n");

// Re-validates so a hand-built or cast Workout can never inject lines or tokens (NaN, floats, strings).
export const toIntervalsText = (workout: Workout): string =>
  parseWorkout(workout).steps.map(section).join("\n\n");
