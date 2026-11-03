/**
 * 远端提供商 /v1/models 接口拉取器。
 */

/**
 * 请求提供商端点的 /models 路径，提取可用的模型 ID 清单。
 *
 * 输入：提供商 Base URL、可选 API Key。
 * 输出：提取到的模型 ID 数组，或错误信息。
 * 预期：
 *   1. 自动拼接 /models 路径（若 URL 尚未包含）。
 *   2. 携带 Authorization Bearer 头（若提供了 Key）。
 *   3. 兼容 OpenAI 的 { data: [{ id }] }、Ollama 的 { models: [{ name }] } 以及直接数组格式。
 *   4. 超时 10 秒防卡死。
 */
export async function fetchRemoteModels(
  baseURL: string,
  apiKey?: string,
): Promise<{ readonly ok: true; readonly modelIDs: string[] } | { readonly ok: false; readonly error: string }> {
  try {
    let clean = baseURL.trim()
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      clean = `https://${clean}`
    }

    const url = clean.endsWith("/models")
      ? clean
      : clean.endsWith("/")
      ? `${clean}models`
      : `${clean}/models`

    const headers: Record<string, string> = {
      Accept: "application/json",
    }
    if (apiKey !== undefined && apiKey.trim().length > 0) {
      headers["Authorization"] = `Bearer ${apiKey.trim()}`
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, 10000)

    let response: Response
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status.toString()} ${response.statusText}` }
    }

    const data: unknown = await response.json()
    let rawList: unknown[] = []

    if (Array.isArray(data)) {
      rawList = data
    } else if (typeof data === "object" && data !== null) {
      const record = data as Record<string, unknown>
      if (Array.isArray(record["data"])) {
        rawList = record["data"]
      } else if (Array.isArray(record["models"])) {
        rawList = record["models"]
      }
    }

    const modelIDs: string[] = []
    for (const item of rawList) {
      if (typeof item === "string" && item.length > 0) {
        modelIDs.push(item)
      } else if (typeof item === "object" && item !== null) {
        const entry = item as Record<string, unknown>
        const id = typeof entry["id"] === "string" ? entry["id"] : (typeof entry["name"] === "string" ? entry["name"] : undefined)
        if (id !== undefined && id.length > 0) {
          modelIDs.push(id)
        }
      }
    }

    return { ok: true, modelIDs }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
