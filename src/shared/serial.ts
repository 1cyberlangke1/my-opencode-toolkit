/**
 * 进程级串行队列。
 *
 * 输入：注册表、键、任务。
 * 输出：任务结果。
 * 预期：同一个键的任务按调用顺序排队；任务失败不会卡住后续任务。
 *       注册表挂在 `globalThis` 上，热重载后仍然共享，避免两个实例同时读改写同一份存档。
 */
export function runSerial<T>(
  registry: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = registry.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  registry.set(key, next)
  const clear = (): void => {
    if (registry.get(key) === next) registry.delete(key)
  }
  void next.then(clear, clear)
  return next
}

/** 输入：全局符号；输出：跨热重载共享的串行注册表。 */
export function globalSerialRegistry(key: symbol): Map<string, Promise<unknown>> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Promise<unknown>> | undefined>
  let registry = holder[key]
  if (registry === undefined) {
    registry = new Map<string, Promise<unknown>>()
    holder[key] = registry
  }
  return registry
}
