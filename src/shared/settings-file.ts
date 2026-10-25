import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"

/** 配置对象。 */
export type ConfigValues = Record<string, unknown>

/** 单层读取错误。 */
export type ConfigError = {
  readonly path: string
  readonly message: string
}

/** 多层合并结果。 */
export type ConfigReadResult = {
  readonly values: ConfigValues
  readonly errors: readonly ConfigError[]
}

/** 写入结果。 */
export type ConfigWriteResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

function isRecord(value: unknown): value is ConfigValues {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseConfig(text: string, path: string): { readonly value?: ConfigValues; readonly error?: ConfigError } {
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  const first = errors[0]
  if (first !== undefined) {
    return {
      error: {
        path,
        message: `JSONC parse failed: ${printParseErrorCode(first.error)} at ${first.offset.toString()}`,
      },
    }
  }
  if (!isRecord(parsed)) return { error: { path, message: "config root must be a JSON object" } }
  return { value: parsed }
}

async function readConfigFile(path: string): Promise<{ readonly value?: ConfigValues; readonly error?: ConfigError }> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (isNotFound(error)) return { value: {} }
    return { error: { path, message: errorMessage(error) } }
  }
  return parseConfig(text, path)
}

function mergeConfig(base: ConfigValues, next: ConfigValues): ConfigValues {
  const result: ConfigValues = { ...base }
  for (const [key, value] of Object.entries(next)) {
    const previous = result[key]
    result[key] = isRecord(previous) && isRecord(value) ? mergeConfig(previous, value) : value
  }
  return result
}

/** 输入：低→高路径；输出：合并值 + 坏层错误。 */
export async function readMergedConfig(paths: readonly string[]): Promise<ConfigReadResult> {
  let values: ConfigValues = {}
  const errors: ConfigError[] = []
  for (const path of paths) {
    const read = await readConfigFile(path)
    if (read.error !== undefined) {
      errors.push(read.error)
      continue
    }
    if (read.value !== undefined) values = mergeConfig(values, read.value)
  }
  return { values, errors }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => deepEqual(value, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every((key) => key in right && deepEqual(left[key], right[key]))
  }
  return false
}

/** 输入：当前值 + 目标值；输出：只含变化键的补丁。 */
export function diffConfig(current: ConfigValues, next: ConfigValues): ConfigValues | undefined {
  const patch: ConfigValues = {}
  for (const [key, value] of Object.entries(next)) {
    const previous = current[key]
    if (deepEqual(previous, value)) continue
    if (isRecord(previous) && isRecord(value)) {
      const nested = diffConfig(previous, value)
      if (nested !== undefined) patch[key] = nested
      continue
    }
    patch[key] = value
  }
  return Object.keys(patch).length === 0 ? undefined : patch
}

function flattenPatch(patch: ConfigValues, prefix: readonly string[] = []): { path: string[]; value: unknown }[] {
  const leaves: { path: string[]; value: unknown }[] = []
  for (const [key, value] of Object.entries(patch)) {
    const path = [...prefix, key]
    if (isRecord(value) && Object.keys(value).length > 0) {
      leaves.push(...flattenPatch(value, path))
      continue
    }
    leaves.push({ path, value })
  }
  return leaves
}

/** 输入：路径 + 补丁；输出：写入结果。预期：保留注释，解析失败不覆盖。 */
export async function writeConfigValues(path: string, patch: ConfigValues): Promise<ConfigWriteResult> {
  if (Object.keys(patch).length === 0) return { ok: true }
  const read = await readConfigFile(path)
  if (read.error !== undefined) return { ok: false, error: read.error.message }

  let text = "{}"
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (!isNotFound(error)) return { ok: false, error: errorMessage(error) }
  }
  for (const leaf of flattenPatch(patch)) {
    text = applyEdits(
      text,
      modify(text, leaf.path, leaf.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    )
  }

  try {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid.toString()}.${Date.now().toString()}.tmp`
    await writeFile(temp, text, "utf8")
    try {
      await rename(temp, path)
    } catch {
      await copyFile(temp, path)
      await rm(temp, { force: true })
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/**
 * 输入：低→高路径。
 * 输出：最近一个「存在且能解析」的文件；没有可写的就回退到全局路径。
 * 预期：写目标不能只看「文件存在」——坏掉的 JSONC 层会让保存永远失败，
 *       而写到下层本来就能生效，没必要卡死。
 */
export async function nearestExistingConfig(paths: readonly string[]): Promise<string | undefined> {
  for (let index = paths.length - 1; index >= 0; index -= 1) {
    const path = paths[index]
    if (path === undefined) continue
    try {
      await stat(path)
    } catch {
      continue
    }
    const read = await readConfigFile(path)
    // 解析失败：跳过这一层，继续往更低的层找。
    if (read.error === undefined) return path
  }
  return paths[0]
}
