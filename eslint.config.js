import js from "@eslint/js"
import { defineConfig } from "eslint/config"
import tseslint from "typescript-eslint"

export default defineConfig([
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", "tmp/**", "scripts/**", "tui-test/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 设置对象要能直接赋给 JSON 值类型；interface 不会获得隐式索引签名，故统一用 type。
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
    },
  },
])
