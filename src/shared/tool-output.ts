import { Schema } from "effect"

/**
 * tk 工具的统一 output 形状：成功时为空对象，失败时带编译器式诊断字段。
 *
 * 输入：工具返回；输出：宿主按此 schema 编码。
 * 预期：诊断字段全部 optional，成功路径不受影响；失败路径的 error/code/at 等能真正传给宿主与 TUI。
 */
export const ToolOutput = Schema.Struct({
  error: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  at: Schema.optional(Schema.String),
  expected: Schema.optional(Schema.String),
  got: Schema.optional(Schema.String),
  excerpt: Schema.optional(Schema.String),
  fix: Schema.optional(Schema.String),
})
