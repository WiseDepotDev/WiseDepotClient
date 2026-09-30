import { useEffect, useState } from 'react';
import type { Bridge } from '@wise/bridge-client';
import type { NavLeaf } from './navigation.js';
import { useBridgeCall } from './useBridgeCall.js';

interface DashboardSummary {
  readonly inventoryTotal: number;
  readonly todayAlertCount: number;
  readonly inspectionProgress: number;
  readonly deviceOnlineCount: number;
  readonly currentTask?: { readonly taskCode?: string; readonly progress?: number } | undefined;
}

/**
 * 页面内容。
 *
 * W1 阶段只在"看板"这一页做**真实取数**，其余页给占位骨架 ——
 * 目的是让 W1 的验收物是"一条打通的链路"，而不是一堆好看的空壳：
 * 引导 → 桥 → 方法白名单 → 后端数据 → 令牌化的界面。
 */
export function PageBody({ bridge, leaf }: { bridge: Bridge; leaf: NavLeaf }): React.ReactElement {
  if (leaf.primaryMethod === 'dashboard.summary') {
    return <Dashboard bridge={bridge} />;
  }
  return (
    <div className="w-card">
      <div className="w-mono w-muted">{leaf.primaryMethod}</div>
      <p>该页在 W5–W7 逐域迁入。当前占位，用于验证外壳、导航与令牌。</p>
      <div className="w-skeleton" />
    </div>
  );
}

function Dashboard({ bridge }: { bridge: Bridge }): React.ReactElement {
  const { loading, data, error, reload } = useBridgeCall<DashboardSummary>(bridge, 'dashboard.summary');

  if (error) {
    return (
      <div className="w-card w-error">
        <div>{error.code}</div>
        <div className="w-muted">{error.messageKey ?? '取数失败'}</div>
        <button type="button" className="w-btn" onClick={reload}>
          重试
        </button>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="w-grid">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="w-card">
            <div className="w-skeleton" />
          </div>
        ))}
      </div>
    );
  }

  const kpis = [
    { label: '库存总量', value: data.inventoryTotal },
    { label: '今日告警', value: data.todayAlertCount },
    { label: '巡检进度', value: `${data.inspectionProgress}%` },
    { label: '设备在线', value: data.deviceOnlineCount },
  ];

  return (
    <>
      <div className="w-grid">
        {kpis.map((k) => (
          <div key={k.label} className="w-card">
            <div className="w-kpi__value">{k.value}</div>
            <div className="w-kpi__label">{k.label}</div>
          </div>
        ))}
      </div>
      {data.currentTask?.taskCode ? (
        <div className="w-card" style={{ marginTop: 'var(--w-space-group-gap)' }}>
          <div className="w-kpi__label">当前任务</div>
          <div className="w-mono">{data.currentTask.taskCode}</div>
        </div>
      ) : null}
      <ScanFeed bridge={bridge} />
    </>
  );
}

/** 扫码事件流：验证 `evt` 通道（订阅、解绑、重连后重订阅）。 */
function ScanFeed({ bridge }: { bridge: Bridge }): React.ReactElement {
  const [codes, setCodes] = useState<readonly string[]>([]);

  useEffect(() => bridge.subscribe('scan.code', (data) => {
    const code = (data as { code?: string } | undefined)?.code;
    if (code) {
      setCodes((prev) => [code, ...prev].slice(0, 5));
    }
  }), [bridge]);

  return (
    <div className="w-card" style={{ marginTop: 'var(--w-space-group-gap)' }}>
      <div className="w-kpi__label">最近扫码（事件通道）</div>
      {codes.length === 0 ? (
        <div className="w-muted">等待事件…（mock 每 20 秒推一条）</div>
      ) : (
        codes.map((c) => (
          <div key={c} className="w-mono">
            {c}
          </div>
        ))
      )}
    </div>
  );
}
