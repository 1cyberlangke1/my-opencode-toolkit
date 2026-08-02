/** Parse the arguments of the `/goal` slash command (codex-style). */

export type ParsedGoalCommand =
  | { readonly kind: "set"; readonly objective: string }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "clear" }
  | { readonly kind: "edit" }
  | { readonly kind: "show" };

/** Exact-match command words (codex-style); anything else is the objective. */
export function parseGoalCommand(rawArgs: string): ParsedGoalCommand {
  const trimmed = rawArgs.trim();
  if (trimmed === "") {
    return { kind: "show" };
  }

  switch (trimmed.toLowerCase()) {
    case "pause":
      return { kind: "pause" };
    case "resume":
      return { kind: "resume" };
    case "clear":
      return { kind: "clear" };
    case "edit":
      return { kind: "edit" };
    default:
      return { kind: "set", objective: trimmed };
  }
}
