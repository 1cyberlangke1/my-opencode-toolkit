import { asRecord } from "../shared/json.ts"

/** 执行失败分类。用户打断由 `session.execution.interrupted` 单独处理。 */
export type GoalFailureKind = "insufficient_funds" | "token_limit" | "other"

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
]

const INSUFFICIENT_FUNDS_NAMES = ["quota", "balance", "payment", "billing", "credit", "funding", "insufficient"]

const TOKEN_LIMIT_PATTERNS = [
  "prompt is too long",
  "is too long",
  "token limit",
  "context length",
  "too many tokens",
  "context_window_exceeded",
  "maximum context length",
]

/**
 * 输入：`session.execution.failed` 的 error 载荷或任意错误。
 * 输出：`{ type, message, status }` 字符串/数字视图。
 * 预期：兼容 V2 的 `{ type, message, status }` 与普通 Error 的 `{ name, message, statusCode }`。
 */
function extractFields(error: unknown): { type: string; message: string; status: number | undefined } {
  if (typeof error === "string") return { type: "", message: error.toLowerCase(), status: undefined }

  const root = asRecord(error)
  if (root === undefined) return { type: "", message: "", status: undefined }

  const nested = asRecord(root["data"]) ?? {}
  const type = firstString(root["type"], root["name"], nested["type"], nested["name"])
  const message = firstString(root["message"], nested["message"])
  const status = firstNumber(root["status"], root["statusCode"], nested["status"], nested["statusCode"])
  return { type: type.toLowerCase(), message: message.toLowerCase(), status }
}

/** 输入：若干候选值；输出：第一个非空字符串。预期：用于跨形状取字段。 */
function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.length > 0) return value
  return ""
}

/** 输入：若干候选值；输出：第一个有限数字。 */
function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value
  return undefined
}

/**
 * 输入：错误载荷。
 * 输出：是否属于余额/额度不足。
 * 预期：401/402/403 直接判定；否则看 type 与 message 关键词。
 */
export function isInsufficientFundsError(error: unknown): boolean {
  const { type, message, status } = extractFields(error)
  if (status === 401 || status === 402 || status === 403) return true
  if (INSUFFICIENT_FUNDS_NAMES.some((name) => type.includes(name))) return true
  return INSUFFICIENT_FUNDS_MESSAGES.some((pattern) => message.includes(pattern))
}

/**
 * 输入：错误载荷。
 * 输出：是否属于上下文超长。
 * 预期：看 type/message 关键词；不做 HTTP 状态判断。
 */
export function isTokenLimitError(error: unknown): boolean {
  const { type, message } = extractFields(error)
  if (type.includes("contextlengtherror") || type.includes("context_length_exceeded")) return true
  return TOKEN_LIMIT_PATTERNS.some((pattern) => message.includes(pattern))
}

/**
 * 输入：错误载荷。
 * 输出：失败分类。
 * 预期：余额优先于超长，其余归为 other。
 */
export function classifyGoalFailure(error: unknown): GoalFailureKind {
  if (isInsufficientFundsError(error)) return "insufficient_funds"
  if (isTokenLimitError(error)) return "token_limit"
  return "other"
}
