/**
 * OpenCode 全局配置文件 opencode.json(c) 的 AST 级安全读写引擎。
 *
 * 铁律：
 * 1. 采用 jsonc-parser 进行 AST 精确编辑，绝不破坏用户现有的其他配置、缩进与全部注释。
 * 2. 前置语法校验：若原有文件存在语法错误，绝对放弃写入并拦截报错。
 * 3. 后置内存自检：写入磁盘前在内存中二次解析，出现哪怕一个语法错误立刻终止。
 * 4. 原子落盘：写入 .tmp 临时文件再 rename 覆盖，防止断电或进程崩溃留下截断的半截文件。
 */

import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"

import { globalConfigDirectory } from "../shared/config-paths.ts"
import type {
  CustomModelConfig,
  CustomProviderConfig,
} from "./types.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 输入：可选配置目录（默认全局配置目录）。
 * 输出：实际存在的 opencode.jsonc / opencode.json 路径（都不存在则返回 opencode.json）。
 */
export function resolveOpenCodeConfigFile(configDir: string = globalConfigDirectory()): string {
  const jsonc = join(configDir, "opencode.jsonc")
  if (existsSync(jsonc)) return jsonc
  return join(configDir, "opencode.json")
}

/**
 * 从 opencode.json(c) 读取所有带 options.baseURL 的自定义提供商列表。
 *
 * 输入：配置文件绝对路径。
 * 输出：读取结果，包含自定义提供商数组。
 * 预期：原文件不存在返回空数组；原文件有语法错误返回 ok: false。
 */
export async function loadCustomProviders(
  filePath: string,
): Promise<{ readonly ok: true; readonly providers: CustomProviderConfig[] } | { readonly ok: false; readonly error: string }> {
  let text: string
  try {
    text = await readFile(filePath, "utf8")
  } catch (error) {
    if (isNotFound(error)) return { ok: true, providers: [] }
    return { ok: false, error: errorMessage(error) }
  }

  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  const first = errors[0]
  if (first !== undefined) {
    return {
      ok: false,
      error: `JSONC parse error: ${printParseErrorCode(first.error)} at offset ${first.offset.toString()}`,
    }
  }

  if (!isRecord(parsed)) return { ok: true, providers: [] }
  const rawProviders = parsed["provider"]
  if (!isRecord(rawProviders)) return { ok: true, providers: [] }

  const providers: CustomProviderConfig[] = []
  for (const [id, rawEntry] of Object.entries(rawProviders)) {
    if (!isRecord(rawEntry)) continue
    const options = rawEntry["options"]
    if (!isRecord(options)) continue
    const baseURL = options["baseURL"]
    if (typeof baseURL !== "string" || baseURL.trim().length === 0) continue

    const name = typeof rawEntry["name"] === "string" ? rawEntry["name"] : id
    const npm = typeof rawEntry["npm"] === "string" ? rawEntry["npm"] : "@ai-sdk/openai-compatible"
    const apiKey = typeof options["apiKey"] === "string" ? options["apiKey"] : undefined

    const models: Record<string, CustomModelConfig> = {}
    const rawModels = rawEntry["models"]
    if (isRecord(rawModels)) {
      for (const [modelID, rawModel] of Object.entries(rawModels)) {
        if (!isRecord(rawModel)) continue
        const modelName = typeof rawModel["name"] === "string" ? rawModel["name"] : modelID
        const limit = isRecord(rawModel["limit"])
          ? {
              context: typeof rawModel["limit"]["context"] === "number" ? rawModel["limit"]["context"] : 128000,
              output: typeof rawModel["limit"]["output"] === "number" ? rawModel["limit"]["output"] : 4096,
            }
          : undefined
        const capabilities = isRecord(rawModel["capabilities"])
          ? {
              tools: rawModel["capabilities"]["tools"] !== false,
              input: Array.isArray(rawModel["capabilities"]["input"])
                ? rawModel["capabilities"]["input"].filter((x): x is string => typeof x === "string")
                : ["text"],
              output: Array.isArray(rawModel["capabilities"]["output"])
                ? rawModel["capabilities"]["output"].filter((x): x is string => typeof x === "string")
                : ["text"],
            }
          : undefined

        models[modelID] = {
          id: modelID,
          name: modelName,
          enabled: rawModel["enabled"] !== false,
          limit,
          capabilities,
        }
      }
    }

    providers.push({
      id,
      name,
      npm,
      options: {
        baseURL,
        ...(apiKey !== undefined ? { apiKey } : {}),
      },
      models,
    })
  }

  return { ok: true, providers }
}

/**
 * 安全保存一个自定义提供商到 opencode.json(c)。
 *
 * 输入：配置文件绝对路径、自定义提供商配置。
 * 输出：操作结果。
 * 预期：
 *   1. 前置校验：原文件存在语法错误立刻终止，绝不破坏原文件。
 *   2. AST 局部修改：保留所有原文件注释与缩进。
 *   3. 内存自检：修改后语法错误立刻终止。
 *   4. 原子替换：通过临时文件原子 rename。
 */
export async function saveCustomProvider(
  filePath: string,
  provider: CustomProviderConfig,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  let text = "{\n}\n"
  try {
    text = await readFile(filePath, "utf8")
  } catch (error) {
    if (!isNotFound(error)) return { ok: false, error: errorMessage(error) }
  }

  // 1. 前置语法校验
  const preErrors: ParseError[] = []
  const preParsed: unknown = parse(text, preErrors, { allowTrailingComma: true })
  const firstPre = preErrors[0]
  if (firstPre !== undefined) {
    return {
      ok: false,
      error: `Existing file parse error: ${printParseErrorCode(firstPre.error)} at offset ${firstPre.offset.toString()}; aborted to prevent corruption`,
    }
  }

  if (text.trim().length > 0 && !isRecord(preParsed)) {
    return { ok: false, error: "Root configuration must be an object" }
  }

  // 组装要写入 provider.<id> 的规范对象
  const modelsRecord: Record<string, unknown> = {}
  for (const [modelID, m] of Object.entries(provider.models)) {
    if (m.enabled === false) continue
    modelsRecord[modelID] = {
      name: m.name ?? modelID,
      limit: {
        context: m.limit?.context ?? 128000,
        output: m.limit?.output ?? 4096,
      },
      capabilities: {
        tools: m.capabilities?.tools ?? true,
        input: m.capabilities?.input ?? ["text"],
        output: m.capabilities?.output ?? ["text"],
      },
    }
  }

  const providerEntry = {
    npm: provider.npm.length > 0 ? provider.npm : "@ai-sdk/openai-compatible",
    name: provider.name && provider.name.length > 0 ? provider.name : provider.id,
    options: {
      baseURL: provider.options.baseURL,
      ...(provider.options.apiKey && provider.options.apiKey.length > 0 ? { apiKey: provider.options.apiKey } : {}),
    },
    models: modelsRecord,
  }

  // 2. AST 局部修改
  const edits = modify(text, ["provider", provider.id], providerEntry, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  const newText = applyEdits(text, edits)

  // 3. 内存二次严格自检
  const postErrors: ParseError[] = []
  const postParsed: unknown = parse(newText, postErrors, { allowTrailingComma: true })
  const firstPost = postErrors[0]
  if (firstPost !== undefined || !isRecord(postParsed)) {
    return { ok: false, error: "Failed post-edit validation; aborted to prevent corruption" }
  }

  // 4. 原子落盘
  try {
    await mkdir(dirname(filePath), { recursive: true })
    const temp = `${filePath}.${process.pid.toString()}.${Date.now().toString()}.tmp`
    await writeFile(temp, newText, "utf8")
    try {
      await rename(temp, filePath)
    } catch {
      await copyFile(temp, filePath)
      await rm(temp, { force: true })
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/**
 * 从 opencode.json(c) 中安全移除一个提供商。
 *
 * 输入：配置文件路径、提供商 ID。
 * 输出：操作结果。
 * 预期：仅删除该提供商节点，保留其余全部内容和注释。
 */
export async function deleteCustomProvider(
  filePath: string,
  providerID: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  let text: string
  try {
    text = await readFile(filePath, "utf8")
  } catch (error) {
    if (isNotFound(error)) return { ok: true }
    return { ok: false, error: errorMessage(error) }
  }

  const errors: ParseError[] = []
  parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    return { ok: false, error: "Existing file parse error; aborted delete" }
  }

  const edits = modify(text, ["provider", providerID], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  const newText = applyEdits(text, edits)

  const postErrors: ParseError[] = []
  const postParsed: unknown = parse(newText, postErrors, { allowTrailingComma: true })
  if (postErrors.length > 0 || !isRecord(postParsed)) {
    return { ok: false, error: "Failed post-edit validation" }
  }

  try {
    await mkdir(dirname(filePath), { recursive: true })
    const temp = `${filePath}.${process.pid.toString()}.${Date.now().toString()}.tmp`
    await writeFile(temp, newText, "utf8")
    try {
      await rename(temp, filePath)
    } catch {
      await copyFile(temp, filePath)
      await rm(temp, { force: true })
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}
