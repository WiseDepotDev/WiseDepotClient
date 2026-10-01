import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import react from '@vitejs/plugin-react';
import ElementPlus from 'unplugin-element-plus/vite';

/**
 * 唯一 Web 产物（桌面 `app://wise/` 与手机 `https://appassets.androidplatform.net/` 共用）。
 *
 * 三条必须在构建期定死的东西：
 *
 * 1. **`base: './'`** —— 产物会被两种非 HTTP 的标准 origin 加载，绝对路径会解析到错误位置。
 *    这也是**必须用 hash 路由**的原因之一。
 *
 * 2. **UI 库按需引入，不做大 chunk**。实测（docs/superpowers/plans/2026-10-02-v1-spikes.md）：
 *    把 UI 库合成一个 vendor chunk 会让**登录页也背上数据表格与日期选择器**。
 *    所以：Element Plus 走 `unplugin-element-plus` 按需补样式，Rollup 按动态 import 自然分包，
 *    只把 vue 生态合成 `vendor-vue`（~41KB gzip，处处都要）。
 *
 * 3. **路由级懒加载是硬要求**：每个域路由 `() => import()`，
 *    `check:budget` 按"首屏 ≤150KB gzip / 单路由 chunk ≤130KB gzip"卡。
 *
 * React 插件在 V1 期间保留（旧屏还在树上做对照），V6 删除。
 */
export default defineConfig({
  base: './',
  plugins: [
    vue(),
    react(),
    /*
     * Element Plus 的按需样式：把 `import { ElButton } from 'element-plus'`
     * 自动补成同时 import 该组件的 CSS。
     *
     * 为什么不引 `element-plus/dist/index.css`（全量）：那是 ~40KB gzip，
     * 而首屏预算只有 150KB。按需引入后首屏只带它真正用到的几个组件。
     */
    ElementPlus({ useSource: false }),
  ],
  resolve: {
    // 只 dedupe vue。**不要**把 UI 库的传递依赖放进来：dedupe 会强制从项目根解析它们，
    // 而它们不在 apps/web/node_modules 里，会让 Rollup 报 "failed to resolve import"。
    dedupe: ['vue'],
  },
  optimizeDeps: {
    /*
     * 预打包 Element Plus。
     *
     * 不写这一条的后果在开发态很具体：路由是懒加载的，某个域第一次被打开时
     * Vite 才发现新依赖 → **触发一次整页 reload** → 内存里的会话（mock 桥的登录态）丢掉，
     * 用户被踢回登录屏。冒烟测试里表现为"第四阶段之后所有断言都停在 #/login"，
     * 而手动点的时候只是"偶尔刷新一下"，很难联想到依赖预打包。
     */
    include: ['element-plus', '@element-plus/icons-vue'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules/react')) {
            return 'vendor-react';
          }
          if (
            id.includes('node_modules/vue/') ||
            id.includes('node_modules/@vue/') ||
            id.includes('node_modules/vue-router') ||
            id.includes('node_modules/pinia')
          ) {
            return 'vendor-vue';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
