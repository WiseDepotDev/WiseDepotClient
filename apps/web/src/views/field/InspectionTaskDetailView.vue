<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import InspectionTaskDetailPanel from './InspectionTaskDetailPanel.vue';

/**
 * 巡检任务详情屏（`inspection.taskDetail`）—— 薄壳。
 *
 * 内容全在 `InspectionTaskDetailPanel` 里：那一份既能当独立路由屏，
 * 也能在桌面宽档下当主从右栏（任务列表把选中的那一个传给它）。
 *
 * 这里只做一件事：把路由参数解析成正整数任务序号。
 *
 * 解析口径与拆分前逐字一致（只拒"不是数"和"非正数"），窄档走路由时的行为一个字节都没动 ——
 * 收紧到整数那一条校验仍然只属于面板里手输任务序号的那个入口（那里的提示语写的就是正整数）。
 *
 * `noUncheckedIndexedAccess` 下 `params.taskId` 本来就可能是 `string[]`，
 * 再叠上"路由段可能是空的"，所以这里自己兜全：只要不是正数就给 `undefined` ——
 * 面板据此进空态，而不是拿一个解析坏的值去请求（`Number('')` 是 0，不判就会去查 0 号任务）。
 */
const route = useRoute();

const taskId = computed<number | undefined>(() => {
  const raw = route.params['taskId'];
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(String(text).trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
});
</script>

<template>
  <InspectionTaskDetailPanel :task-id="taskId" />
</template>
