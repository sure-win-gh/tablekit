// Shared types for the deposits route. Lives in its own module so the
// types/values split is clean — Next 16's "use server" enforcement
// objects to non-async-function exports living in the actions file.

export type ActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved" };
