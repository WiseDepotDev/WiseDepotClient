<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElAutocomplete } from 'element-plus';
import { allNavEntries, type NavEntry } from './navigation.js';

/**
 * 顶栏「页面跳转」搜索（Element Plus 的 `ElAutocomplete`）。
 *
 * ## 它搜什么、不搜什么
 *
 * 搜的是**页面名字**（本地那张导航表），用来"快速翻到某一页"。
 * 它**不搜业务数据** —— 本仓没有全局数据搜索方法，把两者混在一起，
 * 用户会把"搜不到"理解成"库里没有这条记录"，那是个会误导排障的错误印象。
 * 所以提示语（placeholder）里就写明"不搜数据"，下拉项也带域标签，一眼能看出是页面。
 *
 * 键盘行为由组件自带：↑↓ 选择、Enter 选中、Esc 关闭。
 */
const router = useRouter();
const keyword = ref('');

const entries: readonly NavEntry[] = allNavEntries();

const suggestions = entries.map((e) => ({
  value: e.label,
  method: e.method,
  path: e.path,
  domainLabel: e.domainLabel,
}));

type Suggestion = (typeof suggestions)[number];

/** 最近一次的下拉结果，供"回车直接跳第一个"用。 */
const lastResults = ref<Suggestion[]>([]);

function fetchSuggestions(query: string, cb: (results: Suggestion[]) => void): void {
  const q = query.trim().toLowerCase();
  if (q === '') {
    lastResults.value = [];
    cb([]);
    return;
  }
  const matched = suggestions
    .filter((s) => s.value.toLowerCase().includes(q) || s.domainLabel.toLowerCase().includes(q) || s.method.includes(q))
    .slice(0, 8);
  lastResults.value = matched;
  cb(matched);
}

function goTo(entry: Suggestion | undefined): void {
  if (!entry) {
    return;
  }
  keyword.value = '';
  lastResults.value = [];
  void router.push(entry.path);
}

/** 鼠标点选（Element Plus 的 `select` 事件）。 */
function onSelect(item: Record<string, unknown>): void {
  const path = typeof item.path === 'string' ? item.path : '';
  keyword.value = '';
  lastResults.value = [];
  if (path !== '') {
    void router.push(path);
  }
}

/**
 * 回车直接跳第一个匹配。
 *
 * 为什么需要它：Element Plus 的 autocomplete 在**没有高亮项**时按 Enter 不做任何事
 * （要先按 ↓ 选中）。对一个"跳页"输入框来说，"打完字按回车"是最自然的用法，
 * 让它没反应就是没做到"真的能用"。
 *
 * 不会和 EP 自己的选中重复触发：EP 选中后会把值写回输入框并触发 `select`，
 * 我们已在 `onSelect` 里清空了 keyword —— 这个处理器随后冒泡上来时 keyword 已空，
 * 守卫直接返回。
 */
function onEnter(): void {
  if (keyword.value.trim() === '') {
    return;
  }
  goTo(lastResults.value[0]);
}
</script>

<template>
  <ElAutocomplete
    v-model="keyword"
    class="w-pagesearch"
    size="large"
    clearable
    value-key="value"
    placeholder="搜索页面名称（不搜数据），回车跳转"
    :fetch-suggestions="fetchSuggestions"
    :trigger-on-focus="false"
    @select="onSelect"
    @keydown.enter="onEnter"
  >
    <template #default="{ item }">
      <div class="w-pagesearch__item">
        <span>{{ item.value }}</span>
        <span class="w-pagesearch__item-domain">{{ item.domainLabel }}</span>
      </div>
    </template>
  </ElAutocomplete>
</template>
