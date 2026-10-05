/**
 * 跨语言对账门禁的打包入口（由 `check-bridge-crypto-vectors.mjs` 用 esbuild 打包后执行）。
 *
 * 只要两样东西：`seal.ts`（加密原语）与 `wire.ts`（v5 加密封装）。
 *
 * 为什么不直接打 `packages/bridge-client/src/index.ts`：那条链会带进
 * transport / client / mock（浏览器专用），而这里要验的是**字节**——
 * 无关代码越少，红了越容易看出是哪一层。
 */
export * from '../../packages/bridge-client/src/seal.js';
export * from '../../packages/bridge-client/src/wire.js';
