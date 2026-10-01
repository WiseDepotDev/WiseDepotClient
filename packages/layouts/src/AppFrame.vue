<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElAvatar, ElButton, ElDrawer, ElIcon, ElMenu, ElMenuItem, ElSubMenu } from 'element-plus';
import { Expand, Fold } from '@element-plus/icons-vue';
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
        <span class="w-sidebar__mark" aria-hidden="true">W</span>
        <div v-if="!collapsed" class="w-sidebar__brandtext">
          <div class="w-sidebar__name">慧仓智控</div>
          <div class="w-sidebar__sub">WISEDEPOT</div>
        </div>
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
          「返回」的显示条件必须**有意义**：原先写的是 `isDetail || domain.children.length > 0`，
          而每个域都有 ≥2 个子项 ⇒ 第二个条件恒真 ⇒ 按钮在手机上无条件出现，
          同时 `goBack()` 在非详情屏做的是"跳到域首屏"。现在条件如实表达"有没有上一屏可回"。
        -->
        <ElButton v-if="canGoBack" text size="small" @click="goBack">返回</ElButton>
        <!--
          手机上这里显示**所属域**（库存 / 现场 / 我的…），不是页名。
          为什么：每一屏自己的页头（`PageHeader`）已经写着页名了，情景头再写一遍
          就是同一句话占两行 —— 手机一屏才 844px，顶部那 200px 里有两行是重复的（实测截图即如此）。
          换成域名之后，两行合起来读是"我在库存域 → 我在看库存查询"，既去重又给了方位感。
        -->
        <h1 class="w-contextheader__title">{{ domain.label }}</h1>
        <ElButton v-if="!useSegmented" text size="small" @click="mobileDrawerOpen = true">页面</ElButton>
        <BridgeStatusChip compact />
      </header>

      <!--
        分段控件只在**叶子屏**（同域内换页）出现。详情屏也画一个的话，
        `activeMethod` 由 `leafHit` 算、而详情路由取不到叶子 ⇒ **三个分段一个都不高亮**，
        看起来像"当前在哪个页面"坏了。
      -->
      <div v-if="isCompact && useSegmented && !isDetail" class="w-toolbar w-segment">
        <ElButton
          v-for="c in domain.children"
          :key="c.id"
          size="large"
          :type="activeMethod === c.primaryMethod ? 'primary' : 'default'"
          @click="goLeaf(c.path)"
        >
          {{ c.short }}
        </ElButton>
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

      <nav v-if="isCompact" class="w-tabbar" aria-label="主导航">
        <button
          v-for="d in DOMAINS"
          :key="d.id"
          type="button"
          class="w-tabbar__item"
          :class="{ 'w-tabbar__item--active': d.id === currentDomainId }"
          @click="goDomain(d.id)"
        >
          {{ d.short }}
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
