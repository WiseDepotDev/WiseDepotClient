<script setup lang="ts">
import { computed } from 'vue';
import { ElButton, ElInput, ElOption, ElSelect } from 'element-plus';
import type { FilterDef, FilterValues } from '../types';

/**
 * 筛选条。
 *
 * 一条**必须遵守的诚实规则**（旧设计稿 §逐页布局规则）：
 * 搜索框是"筛选本页"还是"服务端搜索"必须写清楚 ——
 * 本仓有一批屏的服务端搜索方法存在（如 `inventory.search`），另一些只能在已加载的
 * 20 条里过滤。两者外观一样、行为完全不同，不标注就是在骗用户。
 * 所以 `searchScope` 是必填语义，且 `page` 会在界面上显示"筛选本页"字样。
 */
const props = defineProps<{
  readonly filters?: readonly FilterDef[] | undefined;
  readonly modelValue: FilterValues;
  readonly search?: string | undefined;
  readonly searchPlaceholder?: string | undefined;
  readonly searchScope?: 'page' | 'server' | 'none' | undefined;
  readonly allLabel?: string | undefined;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: FilterValues): void;
  (e: 'update:search', value: string): void;
  (e: 'reset'): void;
}>();

const scope = computed(() => props.searchScope ?? 'none');
const allLabel = computed(() => props.allLabel ?? '全部');

/** 每个筛选都补一条"全部"（空值），这样"清空筛选"有一个统一表达。 */
function optionsOf(def: FilterDef): { value: string; label: string }[] {
  return [{ value: '', label: allLabel.value }, ...def.options.map((o) => ({ value: o.value, label: o.label }))];
}

function onFilter(key: string, value: string): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

function valueOf(def: FilterDef): string {
  return props.modelValue[def.key] ?? def.defaultValue ?? '';
}

const dirty = computed(
  () =>
    (props.search !== undefined && props.search !== '') ||
    Object.values(props.modelValue).some((v) => v !== undefined && v !== ''),
);

/**
 * 传给 Element Plus 的属性**用 `v-bind` 整块给**。
 *
 * 为什么不直接写 `size="large"`：在 `packages/*` 里 `vue-tsc` 解析不到 EP 的
 * `buildProps` 结果类型，模板会把这些属性当成"属性定义对象"来校验，
 * 于是 `size="large"` 报 `Type 'string' is not assignable to '{ PropType<…>; __epPropKey: true }'`
 * （同样的写法在 `apps/web` 里是好的）。整块 v-bind 绕开了单属性的字面量校验，
 * 运行期行为完全一样。这是**类型层的绕行**，不是行为差异。
 */
function selectProps(def: FilterDef): any {
  return { size: 'large', modelValue: valueOf(def), placeholder: def.label };
}

function optionProps(opt: { value: string; label: string }): any {
  return { label: opt.label, value: opt.value };
}
</script>

<template>
  <div class="w-toolbar">
    <ElSelect
      v-for="def in filters ?? []"
      :key="def.key"
      class="w-filterbar__select"
      v-bind="selectProps(def)"
      @update:model-value="(v: string) => onFilter(def.key, v)"
    >
      <ElOption v-for="opt in optionsOf(def)" :key="opt.value" v-bind="optionProps(opt)" />
    </ElSelect>

    <div v-if="scope !== 'none'" class="w-filterbar__search">
      <ElInput
        size="large"
        :model-value="search ?? ''"
        :placeholder="searchPlaceholder ?? '搜索'"
        clearable
        @update:model-value="(v: string) => emit('update:search', v)"
      />
      <span class="w-filterbar__scope">{{ scope === 'page' ? '筛选本页' : '全局搜索' }}</span>
    </div>

    <ElButton v-if="dirty" size="large" text @click="emit('reset')">清空筛选</ElButton>
  </div>
</template>

<style scoped>
.w-filterbar__select {
  min-width: 140px;
}

.w-filterbar__search {
  display: flex;
  align-items: center;
  gap: var(--w-space-inline-gap);
  min-width: 260px;
}

/* 作用域标注必须常驻可见：它决定用户对"搜不到"的理解 */
.w-filterbar__scope {
  font-size: var(--w-type-body-small-size);
  color: var(--w-color-on-surface-muted);
  white-space: nowrap;
}
</style>
