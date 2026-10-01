<script setup lang="ts">
import type { StatusTone } from '../types';

/**
 * 状态芯片。
 *
 * 存在的唯一理由是**把颜色规则钉在一处**：文字必须用 `--w-state-*-text`、
 * 底色必须用 `--w-state-*-fill`。反过来用（拿 fill 当文字色）在浅色下会掉到
 * WCAG AA 以下 —— 旧仓为此修过 24 处，所以不让各屏自己拼 class。
 */
withDefaults(
  defineProps<{
    readonly text: string;
    readonly tone?: StatusTone | undefined;
  }>(),
  { tone: 'neutral' },
);
</script>

<template>
  <span class="w-chip" :class="`w-chip--${tone ?? 'neutral'}`">{{ text }}</span>
</template>
