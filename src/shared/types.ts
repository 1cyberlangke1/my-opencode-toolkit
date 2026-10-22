/** 可注销句柄。 */
export type Disposable = {
  dispose(): Promise<void>
}
