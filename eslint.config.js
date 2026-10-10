// 小卜 · ESLint 平铺配置
// 目的：把《代码工程目录结构规划》§3 的"禁止清单"从口头约定，变成**构建失败**。
// 这里拦的是"依赖方向"；真正扫 catch 块与上报载荷的是 ci/gates/ 下的脚本（ESLint 看不到跨文件语义）。
//
// ★ .vue 必须交给 vue-eslint-parser 才能解析，否则会报
//   `Parsing error: '>' expected` —— 那条报错跟代码本身无关，纯粹是解析器缺失，
//   很容易被误当成"模板写错了"而白查半天。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

/** 下划线前缀 = "我知道它没用，但签名需要它"（TS noUnusedParameters 同款约定） */
const UNUSED_VARS = {
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      args: 'after-used',
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
    },
  ],
}

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],

  // ── 让 .vue 的 <script lang="ts"> 走 TS 解析，并声明浏览器全局 ─────────
  // ★ 不声明 globals 的话，`document` / `window` / `ResizeObserver` / `HTMLCanvasElement`
  //   会被报成 no-undef —— 那是纯噪音，容易把真正的错误淹掉。
  {
    files: ['**/*.vue'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      // 单文件组件名与文件名一致即可，不强求多词
      'vue/multi-word-component-names': 'off',
      // 格式化规则交给编辑器，不进 CI —— 否则一个换行就能卡住发布
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      ...UNUSED_VARS,
    },
  },

  // ── 禁令 1：core/ 必须零依赖、可在 node 里单测 ─────────────────────────
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['vue', 'pinia', '@capacitor/*', '@capacitor', '@scene/*', '@ui/*', '@store/*'],
              message: '【规划 §3】core/ 必须纯 TS 零依赖 —— 能在 node 里跑，才能单测',
            },
            {
              group: ['@weather/*', '**/weather/**'],
              message: '【门禁 ⑥】情绪映射不得影响卦象与解读：liuyao / ritual 禁止 import weather',
            },
          ],
        },
      ],
    },
  },

  // ── 禁令 2：仪式状态机不许知道"开发模式"这件事 ─────────────────────────
  {
    files: ['src/core/machine/ritualMachine.ts', 'src/core/ritual/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/useDevStore*', '**/devModeMachine*', '**/DevPanel*'],
              message: '【规划 §3】开发模式绝不能改变仪式行为 —— ritualMachine 内出现 isDevMode 即违规',
            },
            {
              group: ['**/features*', '**/config*', '**/remoteConfig*'],
              message: '【规划 §4.2】仪式机的输入只有手势与时间，不读任何配置开关',
            },
          ],
        },
      ],
    },
  },

  // ── 禁令 3：画面不许直接改 DOM ────────────────────────────────────────
  {
    files: ['src/scene/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['@ui/*', '**/ui/**'], message: '【规划 §3】Scene 层只画，不做决定，也不许碰 UI' }],
        },
      ],
    },
  },

  // ── 禁令 4：UI 层不许直接读天气（只能读 store 投影） ────────────────────
  {
    files: ['src/ui/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@weather/*', '**/weather/**'], message: '【门禁 ⑥】UI 只读 useWeatherStore 投影，不直连天气模块' },
          ],
        },
      ],
    },
  },

  // ── 全局：生产只允许 warn / error ──────────────────────────────────────
  {
    files: ['src/**/*.{ts,vue}'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'warn',
      ...UNUSED_VARS,
    },
  },

  // ── 构建 / 门禁脚本：node 环境 ─────────────────────────────────────────
  // ★ 不声明 node globals 的话 `process` 会被报 no-undef ——
  //   一样的噪音问题，跟 .vue 缺浏览器全局是同一类坑。
  {
    files: ['scripts/**/*.{mjs,js,ts}', '*.config.{js,ts,mjs}', 'vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off', ...UNUSED_VARS },
  },

  // ── 测试：与 src 同款「下划线前缀 = 故意未用」约定 ───────────────────────
  //   tests 之前没被任何 block 覆盖，会落入 typescript-eslint 的默认
  //   no-unused-vars（不认 `_` 前缀），导致桩函数里的 `_url` / `_init` 被误报。
  //   这里把项目级约定显式补到测试文件上。
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      ...UNUSED_VARS,
    },
  },
]
