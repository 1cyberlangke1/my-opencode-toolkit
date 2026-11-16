import { describe, expect, it } from "vitest"

import { diagnostic, diagnosticResult, renderDiagnostic } from "../src/shared/diagnostic.ts"
import { explainCronError } from "../src/scheduling/cron.ts"

/** 输入：无；输出：一条解析类诊断（有原文可指）。 */
function parseDiagnostic() {
  return diagnostic({
    tool: "cron_create",
    code: "CRON_FIELD",
    summary: "invalid cron expression",
    at: "cron field 3 (dayOfMonth)",
    expected: "1-31",
    got: "99",
    excerpt: "0 0 99 * *",
    fix: "use 1-31, or '*' for every day",
  })
}

/** 输入：无；输出：一条状态类诊断（无原文）。 */
function stateDiagnostic() {
  return diagnostic({
    tool: "create_goal",
    code: "UNFINISHED_GOAL",
    summary: "this thread has an unfinished goal",
    expected: "no active goal",
    got: "an active goal",
    fix: "complete or clear the current goal first",
  })
}

describe("diagnostic", () => {
  it("解析类诊断渲染出原文、期望、实得和修法", () => {
    const text = renderDiagnostic(parseDiagnostic())
    expect(text).toContain("ERROR: cron_create:")
    expect(text).toContain("(CRON_FIELD)")
    expect(text).toContain("at: cron field 3 (dayOfMonth)")
    expect(text).toContain("expected: 1-31")
    expect(text).toContain("got: 99")
    expect(text).toContain("excerpt: 0 0 99 * *")
    expect(text).toContain("fix: use 1-31")
  })

  it("状态类诊断不编造行列与原文", () => {
    const text = renderDiagnostic(stateDiagnostic())
    expect(text).not.toContain("at:")
    expect(text).not.toContain("excerpt:")
    expect(text).toContain("expected: no active goal")
    expect(text).toContain("got: an active goal")
  })

  it("diagnostic 不把 undefined 落成显式键", () => {
    expect(Object.keys(stateDiagnostic())).not.toContain("at")
    expect(Object.keys(stateDiagnostic())).not.toContain("excerpt")
  })

  it("diagnosticResult 同时产出 output / content / metadata", () => {
    const result = diagnosticResult(parseDiagnostic(), {})
    expect(result.output.error).toBe("invalid cron expression")
    expect(result.output.code).toBe("CRON_FIELD")
    expect(result.output.got).toBe("99")
    expect(result.content).toContain("ERROR: cron_create:")
    expect(result.metadata["error"]).toBe(true)
    expect(result.metadata["code"]).toBe("CRON_FIELD")
  })
})

describe("explainCronError", () => {
  it("日期字段越界时指出第 3 个字段和越界值", () => {
    const issue = explainCronError("0 0 99 * *")
    expect(issue?.fieldIndex).toBe(2)
    expect(issue?.fieldName).toBe("dayOfMonth")
    expect(issue?.part).toBe("99")
    expect(issue?.reason).toContain("out of range")
    expect(issue?.reason).toContain("99")
  })

  it("分钟字段越界时指出第 1 个字段", () => {
    const issue = explainCronError("60 * * * *")
    expect(issue?.fieldIndex).toBe(0)
    expect(issue?.fieldName).toBe("minute")
    expect(issue?.part).toBe("60")
  })

  it("步进为 0 时指出 step 必须 >= 1", () => {
    const issue = explainCronError("*/0 * * * *")
    expect(issue?.reason).toContain("step")
  })

  it("范围起点大于终点时指出 range 问题", () => {
    const issue = explainCronError("0 9-3 * * *")
    expect(issue?.fieldName).toBe("hour")
    expect(issue?.reason).toContain("start")
  })

  it("无法解析的字段说明允许的形式", () => {
    const issue = explainCronError("a * * * *")
    expect(issue?.part).toBe("a")
    expect(issue?.reason).toContain("not")
  })

  it("字段数不是 5 时返回 undefined（由调用方报字段数错误）", () => {
    expect(explainCronError("* * * *")).toBeUndefined()
    expect(explainCronError("")).toBeUndefined()
  })

  it("合法表达式返回 undefined", () => {
    expect(explainCronError("* * * * *")).toBeUndefined()
    expect(explainCronError("0 9-17 * * 1-5")).toBeUndefined()
  })

  it("逗号列表里第 2 段出错时带 partIndex", () => {
    const issue = explainCronError("0,99 * * * *")
    expect(issue?.fieldName).toBe("minute")
    expect(issue?.partIndex).toBe(1)
    expect(issue?.part).toBe("99")
  })
})
