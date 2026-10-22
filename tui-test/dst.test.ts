import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const cronUrl = pathToFileURL(join(import.meta.dir, "..", "src", "scheduling", "cron.ts")).href

/**
 * 输入：在子进程里执行的脚本片段（已注入 `nextCronRunMs`）。
 * 输出：脚本打印的 JSON。
 * 预期：子进程固定 `TZ=America/New_York`，避免改父进程时区影响其他测试。
 */
async function runWithNewYork(script: string): Promise<Record<string, number | null>> {
  const dir = await mkdtemp(join(tmpdir(), "dst-probe-"))
  const file = join(dir, "probe.ts")
  await writeFile(file, `import { nextCronRunMs } from ${JSON.stringify(cronUrl)}\n${script}`)

  const proc = Bun.spawn([process.execPath, file], {
    env: { ...process.env, TZ: "America/New_York" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  await rm(dir, { recursive: true, force: true })
  if (code !== 0) throw new Error(err)
  return JSON.parse(out) as Record<string, number | null>
}

test("春季拨快：不存在的 02:30 顺延到次日", async () => {
  const result = await runWithNewYork(`
    const from = new Date(2026, 2, 8, 1, 59, 0).getTime()
    const next = nextCronRunMs("30 2 * * *", from)
    console.log(JSON.stringify({ next, expected: new Date(2026, 2, 9, 2, 30, 0).getTime() }))
  `)

  expect(result.next).toBe(result.expected)
})

test("秋季拨慢：重复的一小时被跳过，下一次是次日", async () => {
  const result = await runWithNewYork(`
    const first = nextCronRunMs("30 1 * * *", new Date(2026, 10, 1, 0, 0, 0).getTime())
    const second = first === null ? null : nextCronRunMs("30 1 * * *", first)
    console.log(JSON.stringify({
      first,
      second,
      delta: first === null || second === null ? null : second - first,
    }))
  `)

  // 01:30 EDT 之后直接到次日 01:30 EST，重复的 01:00-01:59 不再触发。
  expect(result.delta).toBe(25 * 60 * 60 * 1000)
})
