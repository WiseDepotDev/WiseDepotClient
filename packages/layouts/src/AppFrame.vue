<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElAvatar, ElButton, ElDrawer, ElIcon, ElMenu, ElMenuItem, ElSubMenu } from 'element-plus';
import { ArrowLeft, Box, Cpu, Expand, Fold, Grid, Menu, Odometer, User } from '@element-plus/icons-vue';
import { useBridgeStore, useCurrentAccount, useScanStore } from '@wise/stores';
import { useViewport } from '@wise/ui';
import BridgeStatusChip from './BridgeStatusChip.vue';
import PageSearch from './PageSearch.vue';
import ScanResultCard from './ScanResultCard.vue';
import { useScanGun } from './useScanGun.js';
import {
  DOMAINS,
  SCAN_TARGET_METHOD,
  destinationOf,
  domainOf,
  findLeafByMethod,
  type DomainId,
} from './navigation.js';

/**
 * 双端外壳（**同一个组件**，只换 chrome）。
 *
 * ## 桌面布局（按用户要求）
 *
 * ```
 * ┌──────────┬──────────────────────────────────────────────┐
 * │ 慧仓智控  │ 面包屑 库存/库存查询   [搜索页面]  [Bridge · 正常 · 18ms] │
 * │ WISEDEPOT│                                              │
 * │（最左上角）├──────────────────────────────────────────────┤
 * │ 运营 ▾    │  .w-content —— **唯一的滚动容器**            │
 * │  看板     │      <RouterView/>                           │
 * │ 库存 ▾    │                                              │
 * │  …（可滚）│                                              │
 * │ ─────────│                                              │
 * │ 头像 名字 │                                              │
 * │     职位 │                                              │
 * └──────────┴──────────────────────────────────────────────┘
 * ```
 *
 * 关键点：
 *  1. **品牌在最左上角**：左列是整屏高度，品牌贴它的顶部；顶栏属于**右列**，
 *     所以"面包屑 / 搜索 / Bridge 状态"出现在每个子页面的上方，而不是横跨整个窗口；
 *  2. **侧栏可展开/收起**，菜单区自己滚动（`overflow-y:auto`），永不把页脚挤出屏幕；
 *  3. **整页固定高度**，只有 `.w-content` 滚动（见 styles/shell.css 的说明）；
 *  4. 桌面与手机**共用同一个 `<RouterView>`**，跨断点不重建屏（未提交表单不丢）。
 */
const route = useRoute();
const router = useRouter();
const bridge = useBridgeStore();
const scan = useScanStore();
const { isCompact } = useViewport();

// ---- 当前域 / 页 ----

const currentDomainId = computed<DomainId>(() => {
  const first = route.path.split('/').filter((s) => s !== '')[0];
  return (DOMAINS.find((d) => d.id === first)?.id ?? 'overview') as DomainId;
});
const domain = computed(() => domainOf(currentDomainId.value));
const leafHit = computed(() => findLeafByMethod(String(route.name ?? '')));
const destination = computed(() => destinationOf(String(route.name ?? '')));
const pageTitle = computed(() => route.meta.title ?? leafHit.value?.leaf.label ?? destination.value?.label ?? '页面');
const isDetail = computed(() => destination.value !== undefined);
const activeMethod = computed(() => leafHit.value?.leaf.primaryMethod ?? '');

// ---- 侧栏展开/收起 ----

const collapsed = ref(false);

/**
 * 菜单项的属性整块给，且**故意放宽成 any**。
 *
 * 在 `packages/*` 里 `vue-tsc` 解析不到 Element Plus 的 `buildProps` 结果类型，
 * 模板会把 `index="…"` 当成"属性定义对象"来校验而报错（同样的写法在 `apps/web` 里是好的）。
 * 运行期完全一样，所以这里做的是**类型层绕行**，不是行为差异。
 */
function menuProps(index: string): any {
  return { index };
}

function onMenuSelect(index: string): void {
  for (const d of DOMAINS) {
    const hit = d.children.find((c) => c.primaryMethod === index);
    if (hit) {
      void router.push(hit.path);
      return;
    }
  }
}

// ---- 左下的账号块：头像 + 姓名 + 职位 ----
//
// 姓名与职位的**唯一出处**是 `@wise/stores` 的 `useCurrentAccount()`：
// 它优先取 `user.current`（服务端真值，冷启动恢复登录态后同样可用），
// 再退化到会话里的 username。这里只负责画，不再自己算一份 ——
// 两处各算一份的后果就是同一个人在两屏显示两个名字。
const account = useCurrentAccount();
const displayName = account.displayName;
const roleText = account.roleText;
const avatarText = computed(() => displayName.value.slice(0, 1));

// ---- 手机：域内导航 ----

const mobileDrawerOpen = ref(false);
/** ≤4 项用分段控件；>4 项改用抽屉里的入口列表（**不做横向滚动**：现场手指找不到） */
const useSegmented = computed(() => domain.value.children.length <= 4);

/**
 * 当前是不是**应用中心**（`/`）。
 *
 * 它不属于任何域，所以有三处要特判：标题（不能写"运营"）、域内分段控件（没有"当前域"可言）、
 * 底栏高亮（一个域都不该亮，"应用"那一项亮）。
 */
const isHome = computed(() => route.name === 'home');

/**
 * 底栏图标：**每个域一个图标**（手机底栏的通用做法是"图标 + 文字"，只有文字时
 * 看上去像一排链接而不是 App）。
 *
 * 图标只在这里做 id → 组件的映射，不写进 `navigation.ts`：那里的职责是信息架构，
 * 图标是外壳的呈现细节，两者混在一起会让"加一个域"变成"必须同时想一个图标"。
 */
const DOMAIN_ICONS: Readonly<Record<DomainId, Component>> = {
  overview: Odometer,
  inventory: Box,
  field: Cpu,
  me: User,
};

/** 底栏是否高亮某一项：在域里时高亮那个域，在应用中心时高亮「应用」。 */
function domainActive(id: DomainId): boolean {
  return !isHome.value && id === currentDomainId.value;
}

function goLeaf(path: string): void {
  mobileDrawerOpen.value = false;
  void router.push(path);
}

function goDomain(id: DomainId): void {
  const first = domainOf(id).children[0];
  if (first) {
    void router.push(first.path);
  }
}

/**
 * 回应用中心（`/`）。
 *
 * 手机上原先**没有任何入口**能回应用中心：底栏点域是"进该域第一个叶子"，
 * 抽屉里只有当前域的子页，扫码/详情都往更深处走 —— 首页一旦离开就只能靠系统返回键。
 * 现在上方情景头与下方底栏各给一个入口（见模板里的说明）。
 */
function goHome(): void {
  void router.push({ name: 'home' });
}

/**
 * 返回 = **回上一屏**。
 *
 * 判据用 `history.state.back`（vue-router 4 自己维护的"上一屏 fullPath"）——
 * 它比 `window.history.length` 可靠：后者在有登录页的 SPA 里**永远 > 1**，
 * 于是"有没有上一屏"这个问题会被恒定回答成"有"。
 *
 * 原先这里是：详情屏才 `back()`，否则 push **当前域的第一个叶子**。那有两个毛病：
 *   1. 按钮叫"返回"，做的却是"跳到域首屏"；
 *   2. 已经在域首屏时（例如"库存查询"）push 到自己 —— 点返回**什么都不发生**。
 * 手机上确实需要一个"回应用中心"的入口，所以没有上一屏时兜底去首页。
 */
function hasHistoryBack(): string | null {
  const state = router.options.history.state as { back?: string | null } | null;
  return state?.back ?? null;
}

const canGoBack = computed(() => {
  // 显式依赖路由：`history.state` 不是响应式的，不读 route 的话导航后不会重算
  void route.fullPath;
  /*
   * **首页不出「返回」**。
   *
   * 真机实测（WSA 冷启动的应用中心）：`history.state.back` 在 WebView 里**不是 null**
   * （初始那个 webview entry 被算了进去），于是按钮显示出来 —— 而点它 `router.back()`
   * 没有任何可回退的真实路由，**页面一动不动**（两张截图字节完全一致）。
   * 这正是原先那条 `isDetail || …` 条件留下的同一类毛病：按钮在，动作没意义。
   */
  if (route.name === 'home') {
    return false;
  }
  return hasHistoryBack() !== null;
});

function goBack(): void {
  if (hasHistoryBack() !== null) {
    router.back();
    return;
  }
  void router.push({ name: 'home' });
}

// ---- 扫码 ----

const canScanGun = computed(() => bridge.supports('scan.gun.keyboard'));

/**
 * 扫码三分支的路由结果处理。
 *
 * `input` 不需要处理：字符已经落进焦点输入框了（监听器不 preventDefault）。
 * `fallback` 才跳转，`screen` 只提示"已交给当前页面"。
 */
function handleScan(code: string): void {
  const where = scan.routeScan(code);
  if (where === 'fallback') {
    scan.showCard();
    void router.push({ name: SCAN_TARGET_METHOD, params: { code } });
    return;
  }
  if (where === 'screen') {
    scan.showCard();
  }
}

useScanGun({ enabled: canScanGun.value, onScan: handleScan });

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && scan.cardOpen) {
    scan.hideCard();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
});
</script>

<template>
  <div class="w-shell" :class="isCompact ? 'w-shell--mobile' : 'w-shell--desktop'">
    <!-- ============ 桌面：整屏高的左列（品牌在最左上角） ============ -->
    <aside v-if="!isCompact" class="w-sidebar" :class="{ 'w-sidebar--collapsed': collapsed }">
      <div class="w-sidebar__brand">
        <!--
          品牌区可点 → 回应用中心。
          为什么：桌面侧栏列的是"域 → 叶子"，**没有 `/` 这一项** ——
          进了子页面之后同样没有回首页的入口（面包屑只是文字）。
          常见做法就是把左上角品牌当"回首页"，这里照做并给出 title 说明。
        -->
        <button
          type="button"
          class="w-sidebar__brandhome"
          title="回到应用中心"
          aria-label="回到应用中心"
          @click="goHome"
        >
          <span class="w-sidebar__mark" aria-hidden="true">W</span>
          <div v-if="!collapsed" class="w-sidebar__brandtext">
            <div class="w-sidebar__name">慧仓智控</div>
            <div class="w-sidebar__sub">WISEDEPOT</div>
          </div>
        </button>
        <ElButton
          class="w-sidebar__toggle"
          text
          :aria-label="collapsed ? '展开导航' : '收起导航'"
          @click="collapsed = !collapsed"
        >
          <ElIcon><component :is="collapsed ? Expand : Fold" /></ElIcon>
        </ElButton>
      </div>

      <!-- 菜单区自己滚动：条目再多也不会把页脚挤出屏幕 -->
      <div class="w-sidebar__menu">
        <ElMenu
          :default-active="activeMethod"
          :collapse="collapsed"
          :collapse-transition="false"
          @select="onMenuSelect"
        >
          <ElSubMenu v-for="d in DOMAINS" :key="d.id" v-bind="menuProps(d.id)">
            <template #title>{{ d.label }}</template>
            <ElMenuItem v-for="c in d.children" :key="c.primaryMethod" v-bind="menuProps(c.primaryMethod)">
              {{ c.label }}
            </ElMenuItem>
          </ElSubMenu>
        </ElMenu>
      </div>

      <footer class="w-sidebar__footer">
        <ElAvatar :size="32" class="w-sidebar__avatar">{{ avatarText }}</ElAvatar>
        <div v-if="!collapsed" class="w-sidebar__account">
          <div class="w-sidebar__account-name">{{ displayName }}</div>
          <div class="w-sidebar__account-role">{{ roleText }}</div>
        </div>
      </footer>
    </aside>

    <!-- ============ 右列：顶栏 + 内容 + 状态栏 ============ -->
    <div class="w-main">
      <header v-if="!isCompact" class="w-commandbar">
        <nav class="w-commandbar__crumbs" aria-label="位置">
          <span>{{ domain.label }}</span>
          <span aria-hidden="true">/</span>
          <span class="w-commandbar__current">{{ pageTitle }}</span>
        </nav>

        <!-- 右上角：页面跳转搜索 + Bridge 状态（**账号已从右上角移到左下角**） -->
        <div class="w-commandbar__right">
          <PageSearch />
          <BridgeStatusChip />
        </div>
      </header>

      <header v-if="isCompact" class="w-contextheader">
        <!--
          顶栏只放**动作与标题**，一行解决：
            · 左侧：详情屏 → 返回箭头；其它屏 → 应用中心（网格图标）；首页 → 不显示
            · 中间：**当前屏的名字**（`pageTitle`）
            · 右侧：本域的页面入口（图标，域内叶子 >4 时才有）、Bridge 状态
          为什么标题改成"屏名"而不是原来的"域名"：屏内的 `PageHeader` 在手机档已经把标题
          藏起来了（见 `ui.css` 的手机断点），所以这里就是全屏唯一的标题 ——
          两处各写一半的做法（顶栏写域、屏内写页名）会读成"我在库存域 → 我在看库存查询"，
          占两行且都不是重点；现在一行说清"我在哪一屏"。
          动作全部用**图标**（不是文字）：手机上文字按钮占宽、且"应用中心"四个字摆在
          左上角一眼看不出是"回首页"。图标按钮一律带 `aria-label`（可读名字，不是只靠形状）。
        -->
        <ElButton
          v-if="isDetail && canGoBack"
          class="w-contextheader__action"
          text
          circle
          aria-label="返回"
          @click="goBack"
        >
          <ElIcon><ArrowLeft /></ElIcon>
        </ElButton>
        <ElButton
          v-else-if="!isHome"
          class="w-contextheader__action"
          text
          circle
          aria-label="应用中心"
          @click="goHome"
        >
          <ElIcon><Grid /></ElIcon>
        </ElButton>
        <h1 class="w-contextheader__title">{{ pageTitle }}</h1>
        <ElButton
          v-if="!useSegmented && !isHome"
          class="w-contextheader__action"
          text
          circle
          aria-label="本域的页面"
          @click="mobileDrawerOpen = true"
        >
          <ElIcon><Menu /></ElIcon>
        </ElButton>
        <!--
          这里原来有一个「刷新本页」按钮，**已经撤掉**：整仓改成了自动刷新
          （`@wise/stores` 的 `startAutoRefresh`：可见时每 15 秒一次，回到前台 / 重新聚焦 /
          网络恢复各补一次），手动按钮既没必要，也会让人以为"不点它就不会更新"。
          信号仍然走 `bumpRefresh`，只是改由自动刷新调度器来 bump。
        -->
        <BridgeStatusChip compact />
      </header>

      <!--
        分段控件只在**叶子屏**（同域内换页）出现：
          · 详情屏也画一个的话，`activeMethod` 由 `leafHit` 算、而详情路由取不到叶子
            ⇒ **三个分段一个都不高亮**，看起来像"当前在哪个页面"坏了；
          · 首页没有"当前域"可言（`currentDomainId` 会兜底成 overview）⇒ 同样一个都不该亮。

        样式是**胶囊分段**（浅灰轨道 + 白色滑块）：原来那排"描边方框"读起来像一排按钮，
        而它其实是"同一屏的几个视图"—— 胶囊 + 滑块才是现在大家认得的那个控件。
        用原生 button 而不是 `ElButton`：要控制的就是"轨道/滑块"，用组件反而要一路覆盖它的样式。
      -->
      <div v-if="isCompact && useSegmented && !isDetail && !isHome" class="w-segment" role="tablist">
        <button
          v-for="c in domain.children"
          :key="c.id"
          type="button"
          role="tab"
          class="w-segment__item"
          :class="{ 'w-segment__item--active': activeMethod === c.primaryMethod }"
          :aria-selected="activeMethod === c.primaryMethod"
          @click="goLeaf(c.path)"
        >
          {{ c.short }}
        </button>
      </div>

      <!-- 唯一的内容实例、唯一的滚动容器。
           `:key="route.fullPath"`：**同一屏换参数时必须重挂载** ——
           详情页复用时组件会带着上一条的数据（"查 NOPE-999 却还显示上一条的记录"），
           而 store 层的缓存键变化不保证模板里的派生值全部重算。整树重挂是最省心的正确做法。 -->
      <main class="w-content">
        <RouterView :key="route.fullPath" />
      </main>

      <footer v-if="!isCompact" class="w-statusbar">
        <span>本地服务：{{ bridge.origin || '未附着' }}</span>
        <span>平台：{{ bridge.platform || '—' }}</span>
        <span>能力：{{ bridge.capabilities.length }} 项</span>
      </footer>

      <!--
        底栏：**「应用」+ 四个域**。
        「应用」是回应用中心的入口（手机上原先没有）；它在首页高亮，
        首页时四个域**一个都不亮** —— 否则会让人以为"我在概览域"，而应用中心不属于任何域。
      -->
      <nav v-if="isCompact" class="w-tabbar" aria-label="主导航">
        <button
          type="button"
          class="w-tabbar__item"
          :class="{ 'w-tabbar__item--active': isHome }"
          @click="goHome"
        >
          <ElIcon class="w-tabbar__icon"><Grid /></ElIcon>
          <span class="w-tabbar__label">应用</span>
        </button>
        <button
          v-for="d in DOMAINS"
          :key="d.id"
          type="button"
          class="w-tabbar__item"
          :class="{ 'w-tabbar__item--active': domainActive(d.id) }"
          @click="goDomain(d.id)"
        >
          <ElIcon class="w-tabbar__icon"><component :is="DOMAIN_ICONS[d.id]" /></ElIcon>
          <span class="w-tabbar__label">{{ d.short }}</span>
        </button>
      </nav>
    </div>

    <ElDrawer v-model="mobileDrawerOpen" direction="btt" size="420px" :title="`${domain.label} · 页面`">
      <ul class="w-cardlist">
        <li v-for="c in domain.children" :key="c.id">
          <button type="button" class="w-card" @click="goLeaf(c.path)">
            <span class="w-card__primary">{{ c.label }}</span>
          </button>
        </li>
      </ul>
    </ElDrawer>

    <ScanResultCard v-if="isCompact" />
  </div>
</template>
