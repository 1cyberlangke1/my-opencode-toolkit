/**
 * 界面文案。
 *
 * 源码里只引用键名，所有用户可见文字都来自语言文件。
 */
export type Messages = {
  readonly command: {
    readonly title: string
    readonly description: string
    readonly group: string
  }
  readonly menu: {
    readonly title: string
    readonly enabled: string
    readonly language: string
    readonly notifications: string
    readonly goal: string
    readonly scheduling: string
    readonly sidebar: string
    readonly on: string
    readonly off: string
    readonly auto: string
    readonly chinese: string
    readonly english: string
    readonly back: string
  }
  readonly sidebar: {
    readonly title: string
    readonly on: string
    readonly off: string
  }
  readonly tool: {
    readonly pingResult: (enabled: boolean, lang: string) => string
  }
}
