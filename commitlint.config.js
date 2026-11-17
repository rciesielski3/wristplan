export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "activities",
        "workouts",
        "calendar",
        "analytics",
        "intervals",
        "garmin",
        "lib",
        "repo",
        "ci",
        "deps",
      ],
    ],
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "refactor", "perf", "test", "build", "ci", "chore", "revert"],
    ],
    "subject-case": [2, "always", "lower-case"],
    "header-max-length": [2, "always", 72],
  },
};
