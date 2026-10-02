<script setup lang="ts">
import { useViewport } from '../composables/useViewport.js';

/**
 * 主从两栏：宽屏时"左列表 + 右详情"并排，窄屏时只出列表（点行进详情路由）。
 *
 * ## 为什么移动端/窄屏**不渲染**详情槽
 *
 * 窄屏放不下两栏，硬塞只会把两边都挤坏。这里用 `v-if="isWide"` 而不是 CSS 隐藏 ——
 * 视觉上藏起来的话，详情面板仍然会被**创建并取数**（多一次白跑的请求，
 * 而且它的错误态会在看不见的地方累积）。所以是"不渲染"，不是"藏起来"。
 *
 * ## 为什么用 `:key` 强制换项时重挂载
 *
 * 详情面板内部把"看哪一条"存成了自己的状态（setup 期读一次 id）。换选中项时若不重挂，
 * 组件会带着上一条的数据继续画 —— 这正是 `<RouterView :key="route.fullPath">` 当初要修的那个坑，
 * 同一个道理在组件层同样成立。
 *
 * ## 宽度
 *
 * 主从屏需要比普通屏更宽：两栏各自的表格列固定宽加起来能到 700px 上下，
 * 挤在默认的内容宽度里会把右栏推出可视区（`.w-content` 是 `overflow-x: hidden`，
 * 溢出被**裁掉**而不是出滚动条 —— 表现是"右半边没了"）。
 * 所以宽屏时给一层 `--wide` 修饰类，由外壳决定它能占多宽。
 */
const { isWide } = useViewport();
</script>

<template>
  <div class="w-masterdetail" :class="{ 'w-masterdetail--wide': isWide }">
    <div class="w-masterdetail__list">
      <slot name="list" />
    </div>
    <aside v-if="isWide" class="w-masterdetail__detail">
      <slot name="detail" />
    </aside>
  </div>
</template>

<style scoped>
.w-masterdetail {
  display: block;
}

/*
 * 只在宽档变成两栏。列宽用 `minmax(0, …)` 而不是固定值 ——
 * 固定值会在内容比预期宽时把 grid 撑破（`minmax(0, …)` 才允许子项收缩）。
 *
 * 注意令牌名是 `--w-space-detail-column-width`（**space** 前缀，不是 size）：
 * 写错名字的后果很隐蔽 —— `grid-template-columns` 整条声明作废、`display: grid` 仍在，
 * 于是两栏静默退化成**上下堆叠**，看起来像"主从没生效"。
 * `check:css-vars` 目前只扫 3 个全局 CSS 文件，管不到组件里的 scoped style（已知盲区）。
 */
.w-masterdetail--wide {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, var(--w-space-detail-column-width));
  gap: var(--w-space-section-gap);
  align-items: start;
}

/*
 * 左栏自己横向滚动。
 *
 * 主从的左栏只有约 700px，而列表的列定义固定宽加起来能到 750px 以上 ——
 * 外层 `.w-content` 是 `overflow-x: hidden`，溢出会被**裁掉**（不是出滚动条，是右半边直接没了）。
 * 让左栏自己滚，比强制每个列表屏再维护一套"主从专用精简列"省事得多；
 * 库里那屏（库存查询）额外准备了精简列，所以它通常不需要滚，两条路并不冲突。
 */
.w-masterdetail--wide > .w-masterdetail__list {
  min-width: 0;
  overflow-x: auto;
}

/*
 * 右栏自己滚动而不是整页滚动：列表可能很长，跟着一起滚会让"选中项"跑出视野。
 * 高度用 `100%` 会被 grid 的 `align-items: start` 压成内容高度，所以给一个视口相关的上限。
 *
 * 注：`min-height: 100%` 在这里**不起作用**（实测）—— grid 行高是内容驱动的，
 * 百分比 min-height 没有可比的确定高度，会被当成 `auto`。所以详情加载遮罩
 * （`LoadingLayer`）盖的是**面板自己的盒子**，而不是整栏高度；这是刻意的：
 * 面板有多高就盖多高，不会凭空撑出一块空白。
 */
.w-masterdetail--wide > .w-masterdetail__detail {
  position: sticky;
  top: 0;
  max-height: 100%;
  overflow-y: auto;
}
</style>
