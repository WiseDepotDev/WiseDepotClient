import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 唯一 Web 产物。
 *
 * 两个必须在构建期定死的东西：
 *
 * 1. **`base: './'`** —— 产物会被两种非 HTTP 的标准 origin 加载
 *    （桌面 `app://wise/`、手机 `https://appassets.androidplatform.net/`）。
 *    绝对路径 `/assets/…` 在自定义协议下会解析到错误位置，只能走相对路径。
 *
 * 2. **路由级分包** —— 首屏 JS 预算是 250KB(gzip)（docs/architecture.md §10）。
 *    vendor 单独切出来是为了让"业务代码增长"和"依赖体积"在报告里分得开。
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('node_modules/react') ? 'vendor-react' : undefined),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
