import type { ScannableStore } from "./json.ts"

/**
 * 输入：具备 scan 能力的存储 + 前缀 + 每条目处理函数 + 每页条数。
 * 输出：无。
 * 预期：按 next 游标分页遍历全部匹配条目，逐条串行处理，避免一次读进内存。
 */
export async function forEachScannedEntry(
  store: ScannableStore,
  prefix: string,
  visit: (entry: { key: string; value: unknown }) => Promise<void>,
  limit = 100,
): Promise<void> {
  let after: string | undefined
  for (;;) {
    const page = await store.scan({ prefix, limit, ...(after === undefined ? {} : { after }) })
    for (const entry of page.entries) await visit(entry)
    if (page.next === undefined) return
    after = page.next
  }
}
