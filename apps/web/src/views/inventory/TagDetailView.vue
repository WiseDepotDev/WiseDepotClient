<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { ElButton } from 'element-plus';
import { humanize, shortTime, useResource } from '@wise/stores';
import { ActionDock, KeyValuePanel, PageHeader, SectionBlock, StateHost, StatusChip } from '@wise/ui';
import type { KeyValueItem } from '@wise/ui';

/**
 * 标签详情（`tag.detail` / `tag.byCode`）。
 *
 * **两条入口、同一屏**：从标签管理点一行是 `tag.detail`（带 `tagId`），
 * 扫码落点是 `tag.byCode`（带 `code`）。两者只是取数方式不同，展示完全一致 ——
 * 所以只有一个组件，按路由名决定调哪个方法。
 *
 * 这也是"扫码到底去哪"的唯一落点（`SCAN_TARGET_METHOD = 'tag.byCode'`）。
 */
interface TagDetail {
  readonly tagId?: number;
  readonly productId?: number;
  readonly barcode?: string;
  readonly nfcUid?: string;
  readonly rfid?: string;
  readonly status?: number;
  readonly createTime?: string;
  readonly updateTime?: string;
  readonly productName?: string;
  readonly productCode?: string;
}

const route = useRoute();

const byCode = computed(() => route.name === 'tag.byCode');
const code = computed(() => {
  const raw = route.params.code;
  return (Array.isArray(raw) ? raw[0] : raw) ?? '';
});
const tagId = computed<number | undefined>(() => {
  const raw = route.params.tagId;
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
});

const params = computed(() =>
  byCode.value ? (code.value === '' ? undefined : { code: code.value }) : tagId.value === undefined ? undefined : { tagId: tagId.value },
);
const enabled = computed(() => params.value !== undefined);

const { data, loading, error, reload } = useResource<TagDetail>(
  byCode.value ? 'tag.byCode' : 'tag.detail',
  params,
  { enabled },
);

const items = computed<KeyValueItem[]>(() => {
  const d = data.value;
  return [
    { key: 'barcode', label: '条码', value: d?.barcode ?? null, mono: true },
    { key: 'rfid', label: 'RFID', value: d?.rfid ?? null, mono: true },
    { key: 'nfc', label: 'NFC UID', value: d?.nfcUid ?? null, mono: true },
    { key: 'productName', label: '绑定商品', value: d?.productName ?? null },
    { key: 'productCode', label: '商品编码', value: d?.productCode ?? null, mono: true },
    {
      key: 'status',
      label: '绑定状态',
      value: d?.status === undefined ? null : d.status === 1 ? '已绑定' : '未绑定',
      tone: d?.status === 1 ? 'success' : 'neutral',
    },
    { key: 'createTime', label: '创建时间', value: shortTime(d?.createTime) || null, mono: true },
    { key: 'updateTime', label: '更新时间', value: shortTime(d?.updateTime) || null, mono: true },
  ];
});
</script>

<template>
  <div class="w-page">
    <PageHeader
      :title="data?.productName ?? '标签详情'"
      :note="byCode ? `按编码查找：${code || '—'}` : `标签 #${tagId ?? '—'}`"
    >
      <template #actions>
        <StatusChip :text="data?.status === 1 ? '已绑定' : '未绑定'" :tone="data?.status === 1 ? 'success' : 'neutral'" />
        <ElButton size="large" :loading="loading" @click="reload">刷新</ElButton>
      </template>
    </PageHeader>

    <StateHost
      :loading="loading"
      :error="error"
      :error-text="error ? humanize(error) : undefined"
      :empty="!enabled"
      skeleton="detail"
      empty-text="没有指定要查看的标签；请从标签管理点开一条，或扫一个条码。"
      @retry="reload"
    >
      <SectionBlock title="标签信息">
        <div class="w-card">
          <KeyValuePanel :items="items" />
        </div>
      </SectionBlock>
    </StateHost>

    <ActionDock>
      <ElButton size="large" :loading="loading" @click="reload">刷新</ElButton>
    </ActionDock>
  </div>
</template>

<style scoped>
.w-card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}
</style>
