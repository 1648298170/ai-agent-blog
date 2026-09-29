// config.provider.ts —— Nest 侧的配置薄封装：包一层 @agent-app/engine/config 的 getConfig()
// 引擎读配置的入口不变（.env 解析 + 默认值都在引擎的 config.ts），API 层只做依赖注入的壳，
// 服务/控制器拿配置走构造注入而不是散落各处直调——测试时可整体替换。
import { Injectable } from "@nestjs/common";
import { getConfig } from "@agent-app/engine/config";
import type { AppConfig } from "@agent-app/engine/config";

@Injectable()
export class ConfigProvider {
  /** 类型化配置四件套：apiKey / baseURL / model / embeddingModel */
  get(): AppConfig {
    return getConfig();
  }

  /** 是否已配置 API Key（启动自检日志 / 错误提示分支用） */
  hasApiKey(): boolean {
    return getConfig().apiKey !== "";
  }
}
