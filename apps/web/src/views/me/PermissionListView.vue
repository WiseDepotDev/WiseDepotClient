<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElButton, ElInput } from 'element-plus';
import { asList, asTotal, humanize, shortTime, useResource } from '@wise/stores';
import { KeyValuePanel, PageHeader, ResponsiveDataView, SectionBlock, StateHost, type ColumnDef } from '@wise/ui';
import type { KeyValueItem } from '@wise/ui';

/**
 * 权限管理（`permission.*` 域）—— 一屏里同时是**清单**与**明细**，外加一个"按编码查找"。
 *
 * ## 这一族是 net-new，不是补历史缺口
 *
 * 旧 React 版**从未调用过** `permission.*`（在回滚点 tag `v0-react-freeze` 上全代码面搜不到），
 * 所以这不是"移植漏了"，而是新做的一屏。因此下面每条口径都是**对着真后端重新核的**
 * （2026-10-03，`tools/bench/inventory-tag-probe.mjs`）。
 *
 * ## 三条实测事实，直接决定了这一屏长什么样
 *
 * 1. **不分页**：`permission.list` 返回裸数组（控制器没有 `page`/`size` 参数），
 *    所以本屏**不画分页条** —— 画一条点了没反应的装饰，违反"不可用的按钮不得渲染"。
 * 2. **没有层级**：`permission.tree` 返回的东西与 `list` **一模一样** ——
 *    实体与表都没有 `parentId`，`PermissionMapper` 也不填它，四个节点全是根、`children` 是 `null`。
 *    所以**不画树**：画出来的树会是一排平行的根节点，那是把"没有层级"包装成"有层级"。
 *    界面上把这件事说出来，而不是让用户以为"树怎么展不开"。
 * 3. **写入不可用**：`permission.create` 实测 `HTTP 500 SYS-0001`
 *    （`permission.create_by` / `update_by` 是 `NOT NULL` 且外键到 `user_core`，
 *    而服务层从不设置它们）。`update` / `delete` 没有实测过（delete 会撞 `role_permission`
 *    外键，默认四条权限被角色引用着，拿它们去试等于修库），所以**一个写入口都不提供**。
 */
interface PermissionRow {
  readonly permissionId?: number;
  readonly permissionName?: string;
  readonly permissionCode?: string;
  readonly description?: string;
  readonly parentId?: number | null;
  readonly parentName?: string | null;
  readonly children?: readonly unknown[] | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/** 无参、不分页：服务端返回裸数组（见文件头第 1 条）。 */
const list = useResource<unknown>('permission.list');
const rows = computed(() => asList<PermissionRow>(list.data.value));
const total = computed(() => asTotal(list.data.value));

// ---- 按编码查找：知道编码的人不用在清单里翻 ----
const codeInput = ref('');
const appliedCode = ref('');
const hasCode = computed(() => appliedCode.value !== '');
const byCode = useResource<unknown>('permission.byCode', computed(() => ({ code: appliedCode.value })), {
  enabled: hasCode,
});
const found = computed<PermissionRow | undefined>(() => asList<PermissionRow>(byCode.data.value)[0]);

function runSearch(): void {
  const next = codeInput.value.trim();
  if (next === '') {
    appliedCode.value = '';
    return;
  }
  appliedCode.value = next;
  if (hasCode.value) {
    byCode.reload();
  }
}

function clearSearch(): void {
  codeInput.value = '';
  appliedCode.value = '';
}

// ---- 明细：点一行才去取（不点就不发一个必然是空的请求）----
const selectedId = ref<number | undefined>(undefined);
const detailParams = computed(() => (selectedId.value === undefined ? undefined : { id: selectedId.value }));
const detailEnabled = computed(() => selectedId.value !== undefined);
const detail = useResource<unknown>('permission.detail', detailParams, { enabled: detailEnabled });
const detailRow = computed<PermissionRow | undefined>(() => {
  const value = detail.data.value;
  return value === undefined || value === null ? undefined : (value as PermissionRow);
});

const detailItems = computed<KeyValueItem[]>(() => {
  const d = detailRow.value;
  return [
    { key: 'permissionName', label: '权限名称', value: d?.permissionName ?? null },
    { key: 'permissionCode', label: '权限编码', value: d?.permissionCode ?? null, mono: true },
    { key: 'description', label: '说明', value: d?.description ?? null },
    { key: 'createdAt', label: '创建时间', value: shortTime(d?.createdAt) || null, mono: true },
    { key: 'updatedAt', label: '更新时间', value: shortTime(d?.updatedAt) || null, mono: true },
  ];
});

const columns: readonly ColumnDef<PermissionRow>[] = [
  { key: 'permissionName', title: '权限名称', compact: 'primary' },
  { key: 'permissionCode', title: '权限编码', type: 'mono', width: 180, compact: 'secondary' },
  { key: 'description', title: '说明', value: (r) => r.description ?? '—' },
];

function openDetail(row: PermissionRow): void {
  if (row.permissionId !== undefined) {
    selectedId.value = row.permissionId;
  }
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="权限管理" :note="total !== undefined ? `共 ${total} 项权限` : '系统预置的权限清单'">
      <template #actions>
      </template>
    </PageHeader>

    <p class="w-permission__readonly">
      权限由系统预置，当前只能查看与查找 —— 客户端不提供新增、修改与删除（服务端的权限写入接口尚不可用，点了会失败）。权限之间目前没有上下级关系，所以这里是平铺清单，不是树。
    </p>

    <div class="w-toolbar">
      <ElInput
        v-model="codeInput"
        size="large"
        clearable
        class="w-permission__search"
        placeholder="权限编码，如 user:view"
        @keydown.enter="runSearch"
        @clear="clearSearch"
      />
      <ElButton size="large" type="primary" @click="runSearch">查找</ElButton>
      <ElButton v-if="hasCode" size="large" @click="clearSearch">回到全部</ElButton>
    </div>

    <SectionBlock v-if="hasCode" :title="`按编码查找：${appliedCode}`">
      <StateHost
        :loading="byCode.loading.value"
        :error="byCode.error.value ?? null"
        :error-text="byCode.error.value ? humanize(byCode.error.value) : undefined"
        :empty="found === undefined"
        skeleton="detail"
        :empty-text="`没有编码为「${appliedCode}」的权限。权限编码区分大小写，且要写全（例如 user:view）。`"
        @retry="byCode.reload"
      >
        <div class="w-card">
          <KeyValuePanel
            :items="[
              { key: 'permissionName', label: '权限名称', value: found?.permissionName ?? null },
              { key: 'permissionCode', label: '权限编码', value: found?.permissionCode ?? null, mono: true },
              { key: 'description', label: '说明', value: found?.description ?? null },
            ]"
          />
        </div>
      </StateHost>
    </SectionBlock>

    <SectionBlock :title="`权限清单${selectedId !== undefined ? ` · 已选 #${selectedId}` : ''}`">
      <StateHost
        :loading="list.loading.value"
        :error="list.error.value ?? null"
        :error-text="list.error.value ? humanize(list.error.value) : undefined"
        :empty="rows.length === 0"
        skeleton="list"
        empty-text="还没有登记任何权限。"
        @retry="list.reload"
      >
        <ResponsiveDataView
          :columns="columns"
          :rows="rows"
          :row-key="(r: PermissionRow) => String(r.permissionId ?? r.permissionCode ?? '')"
          clickable
          @row-click="openDetail"
        />
      </StateHost>
    </SectionBlock>

    <SectionBlock v-if="selectedId !== undefined" :title="`权限明细 · #${selectedId}`">
      <StateHost
        :loading="detail.loading.value"
        :error="detail.error.value ?? null"
        :error-text="detail.error.value ? humanize(detail.error.value) : undefined"
        :empty="detailRow === undefined"
        skeleton="detail"
        empty-text="没有取到这条权限的明细。"
        @retry="detail.reload"
      >
        <div class="w-card">
          <KeyValuePanel :items="detailItems" />
        </div>
      </StateHost>
    </SectionBlock>
  </div>
</template>

<style scoped>
/*
 * 只读说明：摆一个"新建"按钮点不了，比没有按钮更糟；但只字不提又会被当成功能缺失。
 * 所以按钮不渲染，把来由写在这里。
 */
.w-permission__readonly {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-color-outline);
  background: var(--w-color-surface-alt);
  color: var(--w-color-on-surface-muted);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-permission__search {
  max-width: 320px;
}

.w-card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}
</style>
