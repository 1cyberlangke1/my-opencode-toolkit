/**
 * 提供商管理服务层：编排配置读写、远端拉取与能力匹配。
 */

import {
  deleteCustomProvider,
  loadCustomProviders,
  resolveOpenCodeConfigFile,
  saveCustomProvider,
} from "./config.ts"
import { fetchRemoteModels } from "./fetcher.ts"
import { matchModelCapabilities } from "./matcher.ts"
import type {
  CustomModelConfig,
  CustomProviderConfig,
  KnownModelRef,
  MatchedModelResult,
} from "./types.ts"

/** 抽象模型列表查询函数。 */
export type KnownModelsLister = () => Promise<readonly KnownModelRef[]>

/** 提供商服务选项。 */
export type ProviderServiceOptions = {
  readonly configFilePath?: string | undefined
  readonly listKnownModels?: KnownModelsLister | undefined
}

/** 提供商业务服务。 */
export class ProviderService {
  private readonly configPath: string
  private readonly listKnown: KnownModelsLister

  constructor(options?: ProviderServiceOptions) {
    this.configPath = options?.configFilePath ?? resolveOpenCodeConfigFile()
    this.listKnown = options?.listKnownModels ?? (() => Promise.resolve([]))
  }

  /** 获取所有自定义提供商列表。 */
  async getProviders(): Promise<{ readonly ok: boolean; readonly providers: CustomProviderConfig[]; readonly error?: string }> {
    const result = await loadCustomProviders(this.configPath)
    if (!result.ok) {
      return { ok: false, providers: [], error: result.error }
    }
    return { ok: true, providers: result.providers }
  }

  /** 保存一个自定义提供商。 */
  async saveProvider(provider: CustomProviderConfig): Promise<{ readonly ok: boolean; readonly error?: string }> {
    return saveCustomProvider(this.configPath, provider)
  }

  /** 删除一个自定义提供商。 */
  async deleteProvider(providerID: string): Promise<{ readonly ok: boolean; readonly error?: string }> {
    return deleteCustomProvider(this.configPath, providerID)
  }

  /**
   * 从远端提供商拉取模型列表，并与已知模型库做模糊匹配。
   */
  async fetchAndMatchModels(
    baseURL: string,
    apiKey?: string,
  ): Promise<{ readonly ok: boolean; readonly models?: CustomModelConfig[]; readonly error?: string }> {
    const fetchResult = await fetchRemoteModels(baseURL, apiKey)
    if (!fetchResult.ok) {
      return { ok: false, error: fetchResult.error }
    }

    let knownModels: readonly KnownModelRef[] = []
    try {
      knownModels = await this.listKnown()
    } catch {
      // 查询已知模型失败时使用空列表，直接走 128k 兜底
    }

    const models: CustomModelConfig[] = fetchResult.modelIDs.map((id) => {
      const matched = matchModelCapabilities(id, knownModels)
      return {
        id,
        name: matched.name,
        enabled: true,
        limit: matched.limit,
        capabilities: matched.capabilities,
      }
    })

    return { ok: true, models }
  }

  /**
   * 对单个模型名称在已知库中重新做一次模糊匹配。
   */
  async rematchModel(modelID: string): Promise<MatchedModelResult> {
    let knownModels: readonly KnownModelRef[] = []
    try {
      knownModels = await this.listKnown()
    } catch {
      // ignore
    }
    return matchModelCapabilities(modelID, knownModels)
  }
}
