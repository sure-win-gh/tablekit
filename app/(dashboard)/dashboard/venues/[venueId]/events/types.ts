// Shared types for the special-events route. Lives in its own module so
// the types/values split is clean — Next's "use server" enforcement
// objects to non-async-function exports living in the actions file.

export type ActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  // `warning` carries a non-blocking notice — e.g. publishing an event that
  // collides with existing standard bookings. The save still succeeded.
  | { status: "saved"; warning?: string };
