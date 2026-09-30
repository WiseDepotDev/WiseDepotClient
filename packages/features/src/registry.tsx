import type { Bridge } from '@wise/bridge-client';
import { Card, Mono, Section, Stack } from '@wise/patterns';
import { DashboardScreen } from './overview/DashboardScreen.js';
import { AlertListScreen } from './overview/AlertListScreen.js';

/**
 * 屏注册表：**桥方法 id → 屏组件**。
 *
 * 为什么用注册表而不是在壳里写 `if/switch`：
 *  · 壳（布局）不该知道业务屏有哪些 —— 那是 features 的知识；
 *  · W5–W7 逐域迁移时，**每一屏就是加一行**，不需要动壳；
 *  · 没登记的方法自动落到"待迁入"占位，`docs/feature-parity.md` 的清单与它一一对应，
 *    漏迁会以"占位屏"的形式显式存在，而不是悄悄消失。
 */
export type ScreenComponent = (props: { bridge: Bridge }) => React.ReactElement;

const REGISTRY: Readonly<Record<string, ScreenComponent>> = {
  'dashboard.summary': DashboardScreen,
  'alert.list': AlertListScreen,
};

export function screenFor(primaryMethod: string): ScreenComponent | undefined {
  return REGISTRY[primaryMethod];
}

/** 已迁入的桥方法 id 列表（供对照清单与测试使用）。 */
export const MIGRATED_METHODS: readonly string[] = Object.keys(REGISTRY);

/** 未迁入时的占位：把"该页会调什么"显示出来，而不是给一片空白。 */
export function NotMigratedScreen({ method }: { method: string }): React.ReactElement {
  return (
    <Stack>
      <Section title="待迁入">
        <Card>
          <Stack tight>
            <Mono>{method}</Mono>
            <span className="w-muted">
              该页在 W5–W7 逐域迁入。当前占位 —— 它会一直显式存在，直到对应的屏注册进
              registry。
            </span>
          </Stack>
        </Card>
      </Section>
    </Stack>
  );
}
