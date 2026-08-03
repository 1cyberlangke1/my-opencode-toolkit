// Vitest 配置：只跑项目自身 src/ 下的测试，排除 tmp/（参考实现）等目录。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["tmp/**", "node_modules/**", "dist/**"],
  },
});
