/**
 * `@wise/scan` —— **键盘式扫码枪的识别内核**（`assembler`），与框架无关。
 *
 * V6 收口：这里原本还导出两个 React hook（`useScanGun` / `useCameraScan`），
 * 它们是 React 外壳时代的东西，且**没有任何 Vue 侧代码引用**（Vue 用的是
 * `@wise/scan/assembler` + `packages/layouts/src/useScanGun.ts`）。
 * 删掉之后本包只剩"纯逻辑"这一件事 —— 也正因为如此，它才能被两端共用。
 */
export { ScanAssembler } from './assembler.js';
export type { ScanAssemblerOptions, ScanStep } from './assembler.js';
