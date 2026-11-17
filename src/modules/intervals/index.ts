export {
  type CreateWorkoutInput,
  createIntervalsClient,
  type DeleteWorkoutOptions,
  type IntervalsClient,
  type IntervalsClientOptions,
  type IntervalsEvent,
  isOwnedEvent,
  OWNED_EXTERNAL_ID_PREFIX,
  type WorkoutTarget,
} from "./client.js";
export { type IntervalsConfig, loadIntervalsConfig } from "./config.js";
export {
  IntervalsApiError,
  IntervalsConfigError,
  IntervalsForeignEventError,
  IntervalsNotFoundError,
  IntervalsResponseError,
  IntervalsValidationError,
} from "./errors.js";
