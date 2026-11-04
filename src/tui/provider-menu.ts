/**
 * TUI 自定义提供商管理交互流。
 */

import type { Context } from "@opencode/plugin/tui/context"

import type { Messages } from "../i18n/index.ts"
import {
  defaultProviderIdFromName,
  defaultProviderNameFromUrl,
  formatCapabilitiesEmoji,
  toggleInputModality,
} from "../provider/matcher.ts"
import { npmPresetOptions } from "../provider/npm-presets.ts"
import type {
  CustomModelConfig,
  CustomProviderConfig,
} from "../provider/types.ts"
import type { RpcCallOptions, ToolkitRpcClient } from "../shared/rpc.ts"

/** 提供商菜单依赖。 */
export type ProviderMenuOptions = {
  readonly context: Context
  readonly client: ToolkitRpcClient
  readonly copy: () => Messages
  readonly rpcOptions: () => RpcCallOptions
}

/** 内部可变草稿结构。 */
type MutableProviderDraft = {
  id: string
  name?: string | undefined
  npm: string
  options: {
    baseURL: string
    apiKey?: string | undefined
  }
  models: Record<string, CustomModelConfig>
}

/**
 * 打开自定义提供商管理主界面。
 */
export async function openProviderMenu(opts: ProviderMenuOptions): Promise<void> {
  const { context, client, copy, rpcOptions } = opts

  try {
    for (;;) {
      const text = copy()
      const getRes = await client.providersGet({}, rpcOptions())
      if (!getRes.ok) {
        context.ui.toast.show({
          message: getRes.error ?? text.panel.error,
          variant: "error",
        })
        return
      }

      const providers = getRes.providers
      const options = [
        {
          title: text.provider.addProvider,
          value: "__add__",
        },
        ...providers.map((p) => ({
          title: p.name && p.name.length > 0 ? p.name : p.id,
          value: p.id,
          footer: text.provider.modelsCount(Object.keys(p.models).length),
        })),
      ]

      const choice = await context.ui.dialog.select<string>({
        title: text.provider.menuTitle,
        options,
      })

      if (choice === undefined) return

      if (choice === "__add__") {
        await startAddProviderWizard(opts)
      } else {
        const selected = providers.find((p) => p.id === choice)
        if (selected !== undefined) {
          await editProviderDialog(opts, selected, false)
        }
      }
    }
  } catch (error) {
    context.ui.toast.show({
      message: error instanceof Error ? error.message : String(error),
      variant: "error",
    })
  }
}

/**
 * 极简添加提供商向导（URL -> Key -> 自动匹配与拉取）。
 */
async function startAddProviderWizard(opts: ProviderMenuOptions): Promise<void> {
  const { context, client, copy, rpcOptions } = opts
  const text = copy()

  const rawUrl = await context.ui.dialog.prompt({
    title: text.provider.promptBaseUrl,
    placeholder: "https://api.example.com/v1",
  })
  if (rawUrl === undefined || rawUrl.trim().length === 0) return

  const baseURL = rawUrl.trim()
  const apiKey = await context.ui.dialog.prompt({
    title: text.provider.promptApiKey,
    placeholder: "sk-...",
  })

  const derivedName = defaultProviderNameFromUrl(baseURL)
  const derivedID = defaultProviderIdFromName(derivedName)

  // 第一次创建自动从远端拉取并模糊匹配模型
  context.ui.toast.show({ message: text.provider.refetching, variant: "info" })
  const fetchRes = await client.providerModelsFetch(
    { baseURL, ...(apiKey && apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}) },
    rpcOptions(),
  )

  const modelsRecord: Record<string, CustomModelConfig> = {}
  if (fetchRes.ok && fetchRes.models !== undefined) {
    for (const m of fetchRes.models) {
      modelsRecord[m.id] = m
    }
    context.ui.toast.show({
      message: text.provider.refetchSuccess(fetchRes.models.length),
      variant: "success",
    })
  } else if (!fetchRes.ok && fetchRes.error !== undefined) {
    context.ui.toast.show({
      message: `${text.provider.refetchFailed}: ${fetchRes.error}`,
      variant: "warning",
    })
  }

  const draft: CustomProviderConfig = {
    id: derivedID,
    name: derivedName,
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL,
      ...(apiKey && apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
    },
    models: modelsRecord,
  }

  // 首次添加拉取模型后立即自动保存入盘，保证数据即刻生效
  const saveRes = await client.providerSave({ provider: draft }, rpcOptions())
  if (saveRes.ok) {
    context.ui.toast.show({
      message: text.provider.saveSuccess(draft.name && draft.name.length > 0 ? draft.name : draft.id),
      variant: "success",
    })
  } else {
    context.ui.toast.show({
      message: `${text.provider.saveFailed}: ${saveRes.error ?? "unknown error"}`,
      variant: "error",
    })
  }

  await editProviderDialog(opts, draft, true)
}

/**
 * 提供商详情配置与微调面板。
 */
async function editProviderDialog(
  opts: ProviderMenuOptions,
  initialProvider: CustomProviderConfig,
  isNew: boolean,
): Promise<void> {
  const { context, client, copy, rpcOptions } = opts
  const draft: MutableProviderDraft = {
    id: initialProvider.id,
    name: initialProvider.name,
    npm: initialProvider.npm,
    options: { ...initialProvider.options },
    models: { ...initialProvider.models },
  }

  const persist = async (): Promise<void> => {
    const saveRes = await client.providerSave({ provider: draft }, rpcOptions())
    if (!saveRes.ok) {
      context.ui.toast.show({
        message: `${copy().provider.saveFailed}: ${saveRes.error ?? "unknown error"}`,
        variant: "error",
      })
    }
  }

  for (;;) {
    const text = copy()
    const options = [
      {
        title: text.provider.manageModels,
        value: "models",
        footer: text.provider.modelsCount(Object.keys(draft.models).length),
      },
      {
        title: text.provider.refetchModels,
        value: "refetch",
      },
      {
        title: `${text.provider.fieldName}: ${draft.name && draft.name.length > 0 ? draft.name : draft.id}`,
        value: "name",
      },
      {
        title: `${text.provider.fieldBaseUrl}: ${draft.options.baseURL}`,
        value: "baseURL",
      },
      {
        title: `${text.provider.fieldApiKey}: ${draft.options.apiKey && draft.options.apiKey.length > 0 ? "******" : text.provider.notSet}`,
        value: "apiKey",
      },
      {
        title: `${text.provider.fieldNpm}: ${draft.npm}`,
        value: "npm",
      },
      ...(!isNew
        ? [
            {
              title: text.provider.delete,
              value: "delete",
            },
          ]
        : []),
    ]

    const choice = await context.ui.dialog.select<string>({
      title: `${text.provider.editTitle}: ${draft.name && draft.name.length > 0 ? draft.name : draft.id}`,
      options,
    })

    if (choice === undefined) return

    if (choice === "name") {
      const newName = await context.ui.dialog.prompt({
        title: text.provider.promptName,
        ...(draft.name !== undefined ? { value: draft.name } : {}),
      })
      if (newName !== undefined) {
        draft.name = newName.trim()
        await persist()
      }
    } else if (choice === "baseURL") {
      const newUrl = await context.ui.dialog.prompt({
        title: text.provider.promptBaseUrl,
        value: draft.options.baseURL,
      })
      if (newUrl !== undefined && newUrl.trim().length > 0) {
        draft.options = { ...draft.options, baseURL: newUrl.trim() }
        await persist()
      }
    } else if (choice === "apiKey") {
      const newKey = await context.ui.dialog.prompt({
        title: text.provider.promptApiKey,
        ...(draft.options.apiKey !== undefined ? { value: draft.options.apiKey } : {}),
      })
      if (newKey !== undefined) {
        const trimmed = newKey.trim()
        draft.options = {
          ...draft.options,
          ...(trimmed.length > 0 ? { apiKey: trimmed } : { apiKey: undefined }),
        }
        await persist()
      }
    } else if (choice === "npm") {
      const selectedNpm = await context.ui.dialog.select<string>({
        title: text.provider.fieldNpm,
        options: [...npmPresetOptions(), { title: "自定义输入...", value: "__custom__" }],
        current: draft.npm,
      })
      if (selectedNpm === "__custom__") {
        const customNpm = await context.ui.dialog.prompt({
          title: text.provider.fieldNpm,
          value: draft.npm,
        })
        if (customNpm !== undefined && customNpm.trim().length > 0) {
          draft.npm = customNpm.trim()
          await persist()
        }
      } else if (selectedNpm !== undefined) {
        draft.npm = selectedNpm
        await persist()
      }
    } else if (choice === "refetch") {
      context.ui.toast.show({ message: text.provider.refetching, variant: "info" })
      const res = await client.providerModelsFetch(
        { baseURL: draft.options.baseURL, ...(draft.options.apiKey ? { apiKey: draft.options.apiKey } : {}) },
        rpcOptions(),
      )
      if (res.ok && res.models !== undefined) {
        for (const m of res.models) {
          draft.models[m.id] = m
        }
        await persist()
        context.ui.toast.show({
          message: text.provider.refetchSuccess(res.models.length),
          variant: "success",
        })
      } else {
        context.ui.toast.show({
          message: `${text.provider.refetchFailed}: ${res.error ?? "unknown error"}`,
          variant: "warning",
        })
      }
    } else if (choice === "models") {
      await manageModelsDialog(opts, draft, persist)
    } else if (choice === "delete") {
      const confirmed = await context.ui.dialog.confirm({
        title: text.provider.delete,
        message: text.provider.confirmDelete(draft.name && draft.name.length > 0 ? draft.name : draft.id),
      })
      if (confirmed === true) {
        const delRes = await client.providerDelete({ providerID: draft.id }, rpcOptions())
        if (delRes.ok) {
          context.ui.toast.show({
            message: text.provider.deleteSuccess,
            variant: "success",
          })
          return
        }
        context.ui.toast.show({
          message: delRes.error ?? text.panel.error,
          variant: "error",
        })
      }
    }
  }
}

/**
 * 模型清单列表与微调入口。
 */
async function manageModelsDialog(
  opts: ProviderMenuOptions,
  draft: MutableProviderDraft,
  persist: () => Promise<void>,
): Promise<void> {
  const { context, client, copy, rpcOptions } = opts

  for (;;) {
    const text = copy()
    const modelList = Object.values(draft.models)
    const options = [
      {
        title: text.provider.addModelManual,
        value: "__add_manual__",
      },
      ...modelList.map((m) => ({
        title: `[${m.enabled !== false ? "✓" : " "}] ${m.id}`,
        ...(m.name && m.name !== m.id ? { description: m.name } : {}),
        footer: formatCapabilitiesEmoji(m),
        value: m.id,
      })),
    ]

    const choice = await context.ui.dialog.select<string>({
      title: `${text.provider.modelsTitle} (${modelList.length.toString()})`,
      options,
    })

    if (choice === undefined) return

    if (choice === "__add_manual__") {
      const modelID = await context.ui.dialog.prompt({
        title: text.provider.promptModelId,
        placeholder: "custom-chat-v1",
      })
      if (modelID !== undefined && modelID.trim().length > 0) {
        const cleanID = modelID.trim()
        const matchRes = await client.providerModelMatch({ modelID: cleanID }, rpcOptions())
        const addedModel: CustomModelConfig = {
          id: cleanID,
          name: matchRes.model.name,
          enabled: true,
          limit: matchRes.model.limit,
          capabilities: matchRes.model.capabilities,
        }
        draft.models[cleanID] = addedModel
        await persist()
        await editSingleModelDialog(
          opts,
          addedModel,
          (updated) => {
            draft.models[cleanID] = updated
            void persist()
          },
          () => {
            Reflect.deleteProperty(draft.models, cleanID)
            void persist()
          },
        )
      }
    } else {
      const selectedModel = draft.models[choice]
      if (selectedModel !== undefined) {
        await editSingleModelDialog(
          opts,
          selectedModel,
          (updated) => {
            draft.models[choice] = updated
            void persist()
          },
          () => {
            Reflect.deleteProperty(draft.models, choice)
            void persist()
          },
        )
      }
    }
  }
}

/**
 * 单个模型的细粒度微调弹窗（满足“支持直接选中模型自定义修改”）。
 */
async function editSingleModelDialog(
  opts: ProviderMenuOptions,
  initialModel: CustomModelConfig,
  onUpdate: (updated: CustomModelConfig) => void,
  onDelete: () => void,
): Promise<void> {
  const { context, client, copy, rpcOptions } = opts
  let current: CustomModelConfig = { ...initialModel }

  for (;;) {
    const text = copy()
    const options = [
      {
        title: `${text.provider.modelEnabled}: ${current.enabled !== false ? text.menu.on : text.menu.off}`,
        value: "enabled",
      },
      {
        title: `${text.provider.modelName}: ${current.name && current.name.length > 0 ? current.name : current.id}`,
        value: "name",
      },
      {
        title: `🪟 ${text.provider.modelContextWindow}: ${(current.limit?.context ?? 128000).toLocaleString()}`,
        value: "context",
      },
      {
        title: `📤 ${text.provider.modelMaxOutput}: ${(current.limit?.output ?? 4096).toLocaleString()}`,
        value: "output",
      },
      {
        title: `🛠️ ${text.provider.modelTools}: ${current.capabilities?.tools !== false ? text.menu.on : text.menu.off}`,
        value: "tools",
      },
      {
        title: `👁️ ${text.provider.modelVision}: ${current.capabilities?.input.includes("image") ?? false ? text.menu.on : text.menu.off}`,
        value: "vision",
      },
      {
        title: `🎙️ ${text.provider.modelAudio}: ${current.capabilities?.input.includes("audio") ?? false ? text.menu.on : text.menu.off}`,
        value: "audio",
      },
      {
        title: `🎬 ${text.provider.modelVideo}: ${current.capabilities?.input.includes("video") ?? false ? text.menu.on : text.menu.off}`,
        value: "video",
      },
      {
        title: `🔍 ${text.provider.modelRematch}`,
        value: "rematch",
      },
      {
        title: `🗑️ ${text.provider.deleteModel}`,
        value: "delete",
      },
    ]

    const choice = await context.ui.dialog.select<string>({
      title: `${text.provider.modelEditTitle}: ${current.id}`,
      options,
    })

    if (choice === undefined) {
      onUpdate(current)
      return
    }

    if (choice === "enabled") {
      current = { ...current, enabled: current.enabled === false }
      onUpdate(current)
    } else if (choice === "name") {
      const newName = await context.ui.dialog.prompt({
        title: text.provider.modelName,
        ...(current.name !== undefined ? { value: current.name } : {}),
      })
      if (newName !== undefined) {
        current = { ...current, name: newName.trim() }
        onUpdate(current)
      }
    } else if (choice === "context") {
      const rawNum = await context.ui.dialog.prompt({
        title: text.provider.modelContextWindow,
        value: (current.limit?.context ?? 128000).toString(),
      })
      if (rawNum !== undefined && /^\d+$/.test(rawNum.trim())) {
        const num = Number.parseInt(rawNum.trim(), 10)
        current = {
          ...current,
          limit: {
            context: num,
            output: current.limit?.output ?? 4096,
          },
        }
        onUpdate(current)
      }
    } else if (choice === "output") {
      const rawNum = await context.ui.dialog.prompt({
        title: text.provider.modelMaxOutput,
        value: (current.limit?.output ?? 4096).toString(),
      })
      if (rawNum !== undefined && /^\d+$/.test(rawNum.trim())) {
        const num = Number.parseInt(rawNum.trim(), 10)
        current = {
          ...current,
          limit: {
            context: current.limit?.context ?? 128000,
            output: num,
          },
        }
        onUpdate(current)
      }
    } else if (choice === "tools") {
      const tools = current.capabilities?.tools === false
      current = {
        ...current,
        capabilities: {
          tools,
          input: current.capabilities?.input ?? ["text"],
          output: current.capabilities?.output ?? ["text"],
        },
      }
      onUpdate(current)
    } else if (choice === "vision" || choice === "audio" || choice === "video") {
      // 三种输入模态共用一套开关逻辑：vision 对应 image，其余直接用选项名。
      const modality = choice === "vision" ? "image" : choice
      current = {
        ...current,
        capabilities: {
          tools: current.capabilities?.tools !== false,
          input: toggleInputModality(current.capabilities, modality),
          output: current.capabilities?.output ?? ["text"],
        },
      }
      onUpdate(current)
    } else if (choice === "rematch") {
      // 重新在已知库匹配一次该模型能力
      const matchRes = await client.providerModelMatch({ modelID: current.id }, rpcOptions())
      current = {
        ...current,
        name: matchRes.model.name,
        limit: matchRes.model.limit,
        capabilities: matchRes.model.capabilities,
      }
      onUpdate(current)
      context.ui.toast.show({
        message: text.provider.refetchSuccess(1),
        variant: "success",
      })
    } else if (choice === "delete") {
      onDelete()
      return
    }
  }
}
