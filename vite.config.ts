import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [vue()],

  resolve: {
    // 别名 = 目录契约（《小卜-代码工程目录结构规划》§2）
    // ★ 别名不只是方便：ESLint 的依赖禁令靠这些前缀才拦得住跨层 import
    alias: {
      '@': r('./src'),
      '@bootstrap': r('./src/bootstrap'),
      '@core': r('./src/core'),
      '@scene': r('./src/scene'),
      '@assets': r('./src/assets'),
      '@ui': r('./src/ui'),
      '@audio': r('./src/audio'),
      '@weather': r('./src/weather'),
      '@services': r('./src/services'),
      '@platform': r('./src/platform'),
      '@shared': r('./src/shared'),
      '@store': r('./src/store'),
    },
  },

  build: {
    target: 'es2020',
    // ★ 包体红线 ≤ 30 MB：素材一律走 CDN 或按需释放，禁止 base64 内联进 JS
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 700,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vue: ['vue', 'pinia'],
          cap: ['@capacitor/core'],
        },
        // ★ 门禁 ② 校验：产物里不许出现 devpanel chunk，也不许出现任何 .map
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },

  server: {
    port: 5173,
    host: true, // 真机同网段调试：手机直接开 http://<PC-IP>:5173
    // ★ 开发期把 /api 转发到仓库内的 FastAPI（server/main.py）：
    //   这样 Web 端无需设 VITE_API_BASE、也没有跨域。真机 / 生产请改在
    //   .env 里给 VITE_API_BASE（相对路径在 capacitor://localhost 下打不到后端）。
    proxy: {
      '/api': {
        target: process.env.XIAOBU_API_TARGET ?? 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
