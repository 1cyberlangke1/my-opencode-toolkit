interface ErrorLike {
  name?: unknown;
  message?: unknown;
  data?: unknown;
  statusCode?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as Record<string, unknown>;
}

function extractFields(error: unknown): ErrorLike {
  if (typeof error === "string") return { message: error };
  const root = asRecord(error);
  if (!root) return {};
  const data = asRecord(root.data);
  return {
    name: root.name ?? data?.name,
    message: root.message ?? data?.message,
    statusCode: root.statusCode ?? data?.statusCode,
  };
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

const INSUFFICIENT_FUNDS_MESSAGES = [
  "insufficient balance",
  "insufficient quota",
  "insufficient funds",
  "payment required",
  "billing not active",
  "billing issue",
  "not enough credits",
  "no credits",
  "quota exceeded",
  "out of credits",
  "insufficient_quota",
];

const INSUFFICIENT_FUNDS_NAMES = [
  "quota",
  "balance",
  "payment",
  "billing",
  "credit",
  "funding",
  "authorization",
  "insufficient",
];

export function isInsufficientFundsError(error: unknown): boolean {
  const { name, message, statusCode } = extractFields(error);
  const code = Number(statusCode);
  if (code === 401 || code === 402 || code === 403) return true;

  const nameLower = lower(name);
  const messageLower = lower(message);
  if (INSUFFICIENT_FUNDS_NAMES.some((n) => nameLower.includes(n))) return true;
  return INSUFFICIENT_FUNDS_MESSAGES.some((m) => messageLower.includes(m));
}

export function isTokenLimitError(error: unknown): boolean {
  const { name, message } = extractFields(error);
  const nameLower = lower(name);
  const messageLower = lower(message);
  if (nameLower.includes("contextlengtherror") || nameLower.includes("context_length_exceeded")) {
    return true;
  }
  const patterns = [
    "prompt is too long",
    "is too long",
    "token limit",
    "context length",
    "too many tokens",
    "context_window_exceeded",
    "maximum context length",
  ];
  return patterns.some((pattern) => messageLower.includes(pattern));
}

export function isAbortError(error: unknown): boolean {
  const { name } = extractFields(error);
  const nameLower = lower(name);
  return nameLower === "messageabortederror" || nameLower === "aborterror";
}

/** Classify a session.error payload into a failure kind. */
export type GoalFailureKind = "insufficient_funds" | "abort" | "token_limit" | "other";

export function classifyGoalFailure(error: unknown): GoalFailureKind {
  if (isInsufficientFundsError(error)) return "insufficient_funds";
  if (isAbortError(error)) return "abort";
  if (isTokenLimitError(error)) return "token_limit";
  return "other";
}
