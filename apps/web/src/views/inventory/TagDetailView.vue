<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import TagDetailPanel from './TagDetailPanel.vue';

/**
 * 标签详情屏（`tag.detail` / `tag.byCode`）—— 薄壳。
 *
 * 内容全在 `TagDetailPanel` 里：那一份既能当独立路由屏，
 * 也能在桌面宽档下当主从右栏（标签列表把选中的那一条传给它）。
 *
 * 这里只做一件事：把路由参数解析成正整数序号。
 * 解析失败（缺参、空串、非数字、0）一律给 `undefined` —— 面板据此进空态，
 * 而不是拿一个解析坏的值去请求（`Number('')` 是 0，不判就会去查 0 号标签）。
 *
 * byCode 入口（`tag.byCode`，参数是 `code`，扫码落点）在这里拿不到数字序号，
 * 所以那一支由面板自己按路由名与 `code` 参数取数 —— 与改造前完全一致。
 */
const route = useRoute();

const tagId = computed<number | undefined>(() => {
  const raw = route.params.tagId;
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
});
</script>

<template>
  <TagDetailPanel :tag-id="tagId" />
</template>
