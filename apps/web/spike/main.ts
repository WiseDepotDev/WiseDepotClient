/**
 * Spike B 页面：1000 行 NDataTable + virtual-scroll，暴露 window.__spike() 供 CDP 调用。
 *
 * 要回答的问题（设计稿 R4）：
 *  1. 虚拟滚动是否真的只渲染少量行（DOM 里 tr 的条数）？
 *  2. 滚动时的帧时间 p50/p95 是否满足"长列表 99 分位 ≤16.6ms"？
 *  3. 行高/密度令牌（48px）能否作用到虚拟滚动的行上？
 */
import { createApp, h } from 'vue';
import { NConfigProvider, NDataTable } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { fullOverrides } from './theme.spike';

const ROW_COUNT = 1000;

interface Row {
  id: number;
  code: string;
  name: string;
  bin: string;
  stock: string;
  status: string;
  updated: string;
}

const STATUS = ['正常', '低库存', '待补货'];

const data: Row[] = Array.from({ length: ROW_COUNT }, (_, i) => ({
  id: i + 1,
  code: `RFID-UHF-${String(i + 1).padStart(4, '0')}`,
  name: '工业级 RFID 标签',
  bin: `${String.fromCharCode(65 + (i % 8))}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 60) + 1).padStart(2, '0')}`,
  stock: `${100 + (i % 400)} / ${120 + (i % 400)}`,
  status: STATUS[i % 3] ?? '正常',
  updated: `1${String(i % 10)}:${String(i % 60).padStart(2, '0')}`,
}));

const columns: DataTableColumns<Row> = [
  { title: '物料', key: 'name', width: 200 },
  { title: '物料编码', key: 'code', width: 180 },
  { title: '库位', key: 'bin', width: 120 },
  { title: '可用 / 在库', key: 'stock', width: 140 },
  { title: '状态', key: 'status', width: 100 },
  { title: '更新时间', key: 'updated', width: 120 },
];

const mountedAt = performance.now();

const App = {
  render: () =>
    h(
      NConfigProvider,
      { themeOverrides: fullOverrides },
      {
        default: () =>
          h(NDataTable, {
            columns,
            data,
            rowKey: (r: Row) => r.id,
            size: 'large',
            virtualScroll: true,
            maxHeight: 520,
            scrollX: 860,
            bordered: false,
            striped: false,
          }),
      },
    ),
};

createApp(App).mount('#app');

let mountMs = -1;
requestAnimationFrame(() => {
  mountMs = Math.round((performance.now() - mountedAt) * 100) / 100;
});

interface SpikeResult {
  totalRows: number;
  domRowsFirstPaint: number;
  domRowsMax: number;
  domRowsEnd: number;
  firstRowHeightPx: number;
  mountedMs: number;
  scrollHeight: number;
  frameP50: number;
  frameP95: number;
  frameMax: number;
  frameCount: number;
  /** 真实卡顿：>20ms 的帧（用 16.7 当阈值会被浮点噪声喂出一堆假阳性）。 */
  framesOver20: number;
  scrollRangeCovered: number;
}

declare global {
  interface Window {
    __spike?: () => Promise<SpikeResult>;
    __spikeResult?: SpikeResult;
  }
}

function findScroller(): HTMLElement | null {
  let best: HTMLElement | null = null;
  document.querySelectorAll<HTMLElement>('*').forEach((el) => {
    const range = el.scrollHeight - el.clientHeight;
    if (range > 200 && el.clientHeight > 100) {
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
  });
  return best;
}

const pct = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round((sorted[idx] ?? 0) * 100) / 100;
};

window.__spike = async (): Promise<SpikeResult> => {
  const tr = () => document.querySelectorAll('.n-data-table-tr').length;
  const scroller = findScroller();
  const firstRow = document.querySelector<HTMLElement>('.n-data-table-tr');
  const domRowsFirstPaint = tr();
  const startTop = scroller?.scrollTop ?? 0;

  const deltas: number[] = [];
  let domRowsMax = domRowsFirstPaint;
  let last = performance.now();

  await new Promise<void>((res) => {
    let i = 0;
    const step = (now: number): void => {
      deltas.push(now - last);
      last = now;
      if (scroller) scroller.scrollTop += Math.max(1, scroller.scrollHeight / 120);
      domRowsMax = Math.max(domRowsMax, tr());
      if (++i >= 120) {
        res();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  const sorted = [...deltas].sort((a, b) => a - b);
  const result: SpikeResult = {
    totalRows: ROW_COUNT,
    domRowsFirstPaint,
    domRowsMax,
    domRowsEnd: tr(),
    firstRowHeightPx: firstRow ? Math.round(firstRow.getBoundingClientRect().height * 100) / 100 : -1,
    mountedMs: mountMs,
    scrollHeight: scroller?.scrollHeight ?? -1,
    frameP50: pct(sorted, 50),
    frameP95: pct(sorted, 95),
    frameMax: Math.round((sorted[sorted.length - 1] ?? 0) * 100) / 100,
    frameCount: deltas.length,
    framesOver20: deltas.filter((d) => d > 20).length,
    scrollRangeCovered: scroller ? scroller.scrollTop - startTop : -1,
  };
  window.__spikeResult = result;
  return result;
};
