import type { Bridge } from '@wise/bridge-client';
import { NotMigratedScreen, screenFor, type ScreenParams } from '@wise/features';
import type { NavLeaf } from './navigation.js';

/**
 * 页面内容 = **按桥方法 id 取屏**。
 *
 * 这个文件曾经内联了看板的取数与渲染（W1 的样板）。W5 起它退化成一层薄分发：
 * 业务屏全部住在 `@wise/features`，壳只负责"当前这个路由该画哪一屏"。
 *
 * 好处是**迁移进度可度量**：`MIGRATED_METHODS` 就是已迁入的方法集合，
 * 没登记的路由会画出显式的"待迁入"占位，而不是悄悄空白。
 *
 * `params` 是壳到屏的只读参数袋（例：扫码枪扫到的标签编码 → 标签详情屏）。
 * 屏签名里它是可选的，所以老屏不受影响。
 */
export function PageBody({
  bridge,
  leaf,
  params,
}: {
  bridge: Bridge;
  leaf: NavLeaf;
  params?: ScreenParams | undefined;
}): React.ReactElement {
  const Screen = screenFor(leaf.primaryMethod);
  return Screen ? (
    <Screen bridge={bridge} screenParams={params} />
  ) : (
    <NotMigratedScreen method={leaf.primaryMethod} />
  );
}
