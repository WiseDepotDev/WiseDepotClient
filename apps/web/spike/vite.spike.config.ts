import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * Spike 专用 Vite 配置（与产品构建 `apps/web/vite.config.ts` 完全隔离）。
 *
 * - `root` 指到 spike 目录，产物落在 `apps/web/spike/dist`（跑完即删）
 * - SSR 走 `vite build --ssr`（见 run-ssr.mjs），因此这里 `ssr.noExternal: true`：
 *   让 vue / naive-ui / css-render 全部被打进同一个 bundle，保证 css-render 只有一份实例，
 *   `@css-render/vue3-ssr` 的 setup() 才能收集到 naive-ui 产生的样式。
 *   （dev 的 ssrLoadModule 在 pnpm 隔离布局下会解析不到 naive-ui 的传递依赖，故不走那条路。）
 */
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [vue()],
  resolve: {
    // 只 dedupe vue。**不要**把 css-render / @css-render/* 放进 dedupe：
    // dedupe 会强制从项目根解析该包，而它是 naive-ui 的传递依赖（不在 apps/web/node_modules 里），
    // 结果是 Rollup "failed to resolve import css-render"。
    // 单一实例由 ssr.noExternal: true 的整体打包保证，不需要 dedupe。
    dedupe: ['vue'],
  },
  ssr: {
    noExternal: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: { port: 5199, strictPort: false },
});
