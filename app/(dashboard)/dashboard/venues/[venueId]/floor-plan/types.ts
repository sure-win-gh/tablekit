// Action-state types for the floor-plan actions. Lives here (not in
// actions.ts) to satisfy Next 16's "use server" rule that exports
// must be async functions only.

export type ActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved" };
