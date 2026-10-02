<script setup lang="ts" generic="T">
import { computed } from 'vue';
import { ElTable, ElTableColumn } from 'element-plus';
import type { ColumnDef } from '../types';
import { useViewport } from '../composables/useViewport';
import Mono from '../primitives/Mono.vue';
import StatusChip from '../primitives/StatusChip.vue';

/**
 * **同一份数据 + 同一份列定义，两端两种渲染**。
 *
 * 桌面出 Element Plus 表格，手机出业务卡片，中间没有任何一份数据模型是分叉的。
 * 屏只需要给一次 `columns` 与 `rows`。
 *
 * 卡片只挑得出来的列（`compact` 槽位）：主标识 / 主文案 / 次要信息 / 状态芯片。
 *
 * ## 关于虚拟滚动（换库时的一处能力变化，如实记下）
 *
 * 之前的 naive-ui 版用 `virtualScroll` 做过 1000 行压测。**Element Plus 的表格没有内置虚拟滚动**，
 * 而这个能力在本仓其实用不上：所有列表都是**服务端分页**（每页 20 条），
 * 不是"一次拉 1000 条在前端滚"。所以这里用 `max-height` 给固定表头 + 内部滚动即可。
 * 真出现"单页上千行"的屏，再引入 `el-table-v2`（EP 的虚拟表格），而不是把虚拟滚动塞进这一层。
 */
const props = defineProps<{
  readonly columns: readonly ColumnDef<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string | number;
  readonly mode?: 'auto' | 'table' | 'cards' | undefined;
  /** 给定高度时表格内部滚动、表头固定；不传则随内容高度。 */
  readonly maxHeight?: number | undefined;
  readonly clickable?: boolean | undefined;
  readonly emptyText?: string | undefined;
}>();

const emit = defineEmits<{ (e: 'row-click', row: T): void }>();

/**
 * 有没有传 `#actions` 插槽。
 *
 * 有它时表格会多出一列「操作」、手机卡片底部也渲染同一份操作按钮 ——
 * CRUD 屏（商品 / 仓库 / 用户）都需要"每行一个删除"，而**不该为此各自重写一遍表格**。
 */
const slots = defineSlots<{
  actions?: (props: { row: T }) => unknown;
  lead?: (props: { row: T }) => unknown;
}>();
const hasActions = computed(() => slots.actions !== undefined);
const hasLead = computed(() => slots.lead !== undefined);

const { isCompact } = useViewport();
const mode = computed(() => props.mode ?? 'auto');
const asCards = computed(() => mode.value === 'cards' || (mode.value === 'auto' && isCompact.value));

function valueOf(row: T, col: ColumnDef<T>): string {
  if (col.value) {
    return col.value(row) ?? '';
  }
  const raw = (row as Record<string, unknown>)[col.key];
  return raw === null || raw === undefined ? '' : String(raw);
}

/**
 * 列属性单独算一份。
 *
 * 为什么不在模板里直接 `:width="col.width"`：`width` 是可选的，本项目开着
 * `exactOptionalPropertyTypes`，把 `undefined` 传给 Element Plus 的可选属性会被类型系统拦下。
 */
const columnProps = computed(() =>
  props.columns.map((col) => ({
    label: col.title,
    ...(col.width !== undefined ? { width: col.width } : {}),
    ...(col.align !== undefined ? { align: col.align } : {}),
  })),
);

/**
 * 卡片槽位。**取不到就不画** —— 卡片上不摆空行。
 */
const primaryCol = computed<ColumnDef<T> | undefined>(
  () => props.columns.find((c) => c.compact === 'primary') ?? props.columns[0],
);
const secondaryCol = computed<ColumnDef<T> | undefined>(() => props.columns.find((c) => c.compact === 'secondary'));
const chipCol = computed<ColumnDef<T> | undefined>(
  () => props.columns.find((c) => c.compact === 'chip') ?? props.columns.find((c) => c.type === 'status'),
);

/*
 * ElTable 对行的类型是它自己的 `DefaultRow`，而这里是**无约束泛型 T**。
 * 运行期是直传、没有任何转换；这两处 cast 只是把类型对齐。
 * `row-key` 统一转成字符串：EP 要求 string，而业务键可能是数字（eventId 这类）。
 */
const tableData = computed(() => [...props.rows] as unknown as Record<string, unknown>[]);
const rowKeyOf = (row: T): string => String(props.rowKey(row));

/**
 * 表格属性整块给：`ElTable` 的行类型是它自己的 `DefaultRow`，
 * 与这里的无约束泛型 `T` 对不上；`row-key` 也要求 string 而业务键可能是数字。
 * 运行期是直传 + `String()` 转换，没有任何结构转换。
 */
const tableProps = computed<any>(() => ({
  data: tableData.value,
  rowKey: rowKeyOf,
  size: 'large',
  border: false,
  ...(props.maxHeight !== undefined ? { maxHeight: props.maxHeight } : {}),
}));

function onRowClick(row: T): void {
  emit('row-click', row);
}
</script>

<template>
  <div v-if="rows.length === 0" class="w-empty">
    <span>{{ emptyText ?? '没有符合条件的数据' }}</span>
  </div>

  <div v-else-if="!asCards" class="w-datatable" :class="{ 'w-datatable--clickable': clickable }">
    <ElTable v-bind="tableProps" @row-click="(row: T) => onRowClick(row)">
      <!--
        `#lead` 放在**第一列**，由调用方自己放复选框/图标。
        为什么不直接用 ElTable 的 `type="selection"`：那套选中态由表格自己持有，
        父组件清空选中（批量操作成功后）时表格不一定跟着清 —— 现场表现是"操作完了勾还在"。
        自己控制状态就没有这个问题。
      -->
      <ElTableColumn v-if="hasLead" width="48">
        <template #default="{ row }">
          <slot name="lead" :row="row" />
        </template>
      </ElTableColumn>
      <ElTableColumn
        v-for="(col, index) in columns"
        :key="col.key"
        v-bind="columnProps[index] ?? {}"
      >
        <template #default="{ row }">
          <StatusChip
            v-if="col.type === 'status'"
            :text="valueOf(row, col)"
            :tone="col.tone ? col.tone(row) : 'neutral'"
          />
          <Mono v-else-if="col.type === 'mono'" :text="valueOf(row, col)" />
          <template v-else>{{ valueOf(row, col) }}</template>
        </template>
      </ElTableColumn>
      <!--
        有 #actions 插槽时追加「操作」列：CRUD 屏（商品/仓库/计划）都需要"每行一个删除"。
        宽度 140 是按"两枚 small 文字按钮 + 两倍单元格内边距"算的，窄一点就会换行；
        右对齐让表头与按钮同一条竖线（左对齐时表头在左、按钮在右，怎么看都不齐）。
      -->
      <ElTableColumn v-if="hasActions" label="操作" width="140" align="right">
        <template #default="{ row }">
          <div class="w-datatable__actions">
            <slot name="actions" :row="row" />
          </div>
        </template>
      </ElTableColumn>
    </ElTable>
  </div>

  <ul v-else class="w-cardlist">
    <li v-for="row in rows" :key="rowKey(row)" class="w-cardrow">
      <button type="button" class="w-card" @click="emit('row-click', row)">
        <span class="w-card__head">
          <span v-if="hasLead" class="w-card__lead" @click.stop>
            <slot name="lead" :row="row" />
          </span>
          <span v-if="primaryCol" class="w-card__primary">
            <Mono v-if="primaryCol.type === 'mono'" :text="valueOf(row, primaryCol)" />
            <template v-else>{{ valueOf(row, primaryCol) }}</template>
          </span>
          <StatusChip
            v-if="chipCol"
            :text="valueOf(row, chipCol)"
            :tone="chipCol.tone ? chipCol.tone(row) : 'neutral'"
          />
        </span>
        <span v-if="secondaryCol" class="w-card__secondary">{{ valueOf(row, secondaryCol) }}</span>
      </button>
      <!--
        手机卡片同一份操作（不再另写一套）。

        **放在按钮外面是硬要求**：卡片整体是一个 `<button>`，按钮里再嵌按钮是非法 HTML，
        浏览器会把内层按钮提到外面，行为变得不可预测。
        但"提到外面"不等于"另起一行右对齐"—— 那样每张卡片下面吊着一个孤零零的红色「移除」，
        视觉上像浮在卡片外面的东西（实测截图就是这么难看的）。
        所以外面再包一层 flex：卡片占满剩余宽度，操作贴在右侧、与卡片垂直居中。
      -->
      <div v-if="hasActions" class="w-card__actions">
        <slot name="actions" :row="row" />
      </div>
    </li>
  </ul>
</template>
