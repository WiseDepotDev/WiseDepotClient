<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElButton, ElDialog, ElInput, ElOption, ElSelect } from 'element-plus';
import { asList, humanize, shortTime, useMutation, useResource, useResourceCacheStore } from '@wise/stores';
import { ActionDock, ConfirmDialog, KeyValuePanel, LoadingLayer, PageHeader, SectionBlock, StateHost, StatusChip } from '@wise/ui';
import type { KeyValueItem } from '@wise/ui';

/** 绑定目标商品的选项量（与建单屏同一手法：少量选项不做异步搜索）。 */
const OPTION_PAGE_SIZE = 50;

/**
 * 标签详情面板（`tag.detail` / `tag.byCode`）。
 *
 * 从 `TagDetailView` 整体搬过来的 —— 它对外只差一个"看哪一条"的参数，
 * 于是能同时服务两种落点：
 *  · 独立路由屏（`TagDetailView` 把路由参数解析成正整数传进来）；
 *  · 桌面宽档的主从右栏（标签列表把选中的那一条传进来）。
 *
 * 为什么序号必须是 prop、不能自己读路由：主从右栏换选中项时路由并不改变，
 * 只读 `route.params.tagId` 的组件拿不到新 id，右栏会一直显示第一次点开的那一条。
 * 这与"详情屏把看哪一条写成 setup 期常量"是同一个坑的两种表现。
 *
 * ## 两条入口、同一屏
 *
 * `tag.detail`（带 `tagId`）与扫码落点 `tag.byCode`（带 `code`）只是取数方式不同，
 * 展示完全一致。byCode 这一支仍然读路由参数："编码"不是本面板的 prop
 * （主从右栏永远按 id 打开，用不到它），让薄壳去解析一个它本来就拿不到的东西，
 * 只会把两边都写坏。这也是"扫码到底去哪"的唯一落点（`SCAN_TARGET_METHOD = 'tag.byCode'`）。
 */
interface TagDetail {
  readonly tagId?: number;
  readonly productId?: number;
  readonly barcode?: string;
  readonly nfcUid?: string;
  readonly rfid?: string;
  readonly status?: number;
  readonly createTime?: string;
  readonly updateTime?: string;
  readonly productName?: string;
  readonly productCode?: string;
}

/**
 * `inline` 表示这一份被当成主从右栏挂进来（要脱掉 `.w-page` 的居中限宽与左右内边距）。
 *
 * 判据只能由调用点显式传入，不能按「id 有值」推：独立路由屏的薄壳（`TagDetailView`，
 * 含手机档从列表点进详情、扫码深链）传的也是路由里解析出来的 id —— 按 id 判断会把那些
 * 独立详情屏的内边距与居中一起脱掉，内容贴到屏幕两边。
 */
const props = defineProps<{ readonly tagId: number | undefined; readonly inline?: boolean | undefined }>();

/**
 * 删除成功后的通知。
 *
 * 为什么要这个事件：**内联挂载（主从右栏）时"回列表"是个空操作** ——
 * 列表屏本来就在当前路由上，`router.push({name:'tag.list'})` 不会触发任何变化，
 * 于是右栏会继续显示一条**已经被删掉**的标签（点它的动作全部会失败）。
 * 窄档（独立路由屏）不受影响：push 真的会换页。
 */
const emit = defineEmits<{ (e: 'deleted'): void }>();

const route = useRoute();
const router = useRouter();
const cache = useResourceCacheStore();

const byCode = computed(() => route.name === 'tag.byCode');
const code = computed(() => {
  const raw = route.params.code;
  return (Array.isArray(raw) ? raw[0] : raw) ?? '';
});

/**
 * 取数参数：byCode 入口按编码，其余按 prop 里的序号。
 *
 * 无论哪一支，取不到目标时都给 `undefined` —— `enabled` 会跟着变 false，
 * 不发一个必然是错的请求（空态由 StateHost 画）。
 */
const params = computed(() =>
  byCode.value ? (code.value === '' ? undefined : { code: code.value }) : props.tagId === undefined ? undefined : { tagId: props.tagId },
);
const enabled = computed(() => params.value !== undefined);

const { data, loading, error, reload } = useResource<TagDetail>(
  byCode.value ? 'tag.byCode' : 'tag.detail',
  params,
  // 退出自动刷新：这个详情是服务端读缓存里会发霉的那一个（见下面 `display` 的说明），
  // 每 15 秒后台重取会把写操作刚更新上去的值盖回旧值。
  { enabled, autoRefresh: false },
);

/*
 * 写操作成功后不要 reload。
 *
 * 服务端 `getTag` 带 `@Cacheable(prefix="tag", timeout=1800)`，而 `updateTag` / `deleteTag` /
 * `bindTag` / `unbindTag` 上都没有 `@CacheEvict` —— 写完立刻重取会拿到旧值，
 * 把刚写的东西在界面上一秒钟抹回去，看起来像"操作没生效"。
 * 2026-10-03 真后端实测（`tools/bench/inventory-tag-probe.mjs`）：解绑后 `tag.detail` 仍回
 * `status=1 productId=7`，而同一条在 `tag.list` 里已经是 `status=0 productId=null`。
 *
 * 所以这里用写操作自己的响应更新显示：服务端返回的就是改后的 DTO —— 那是真值，不是乐观更新。
 * （合并而不是整体替换：万一某个字段没回，也不该把已有信息抹掉。）
 */
const written = ref<TagDetail | undefined>(undefined);
const display = computed<TagDetail | undefined>(() => {
  const base = data.value;
  if (written.value === undefined) {
    return base;
  }
  return { ...base, ...written.value };
});

/** 动作能不能做，取决于"拿不拿得到 tagId"：从列表进来有 prop，扫码进来要从响应里取。 */
const effectiveTagId = computed<number | undefined>(() => props.tagId ?? display.value?.tagId);
const canAct = computed(() => effectiveTagId.value !== undefined);

const notice = ref<string | undefined>(undefined);
const actionError = ref<string | undefined>(undefined);

const bindMutation = useMutation('tag.bind');
const unbindMutation = useMutation('tag.unbind');
const updateMutation = useMutation('tag.update');
const deleteMutation = useMutation('tag.delete');
const busy = computed(
  () =>
    bindMutation.pending.value ||
    unbindMutation.pending.value ||
    updateMutation.pending.value ||
    deleteMutation.pending.value,
);

// ---- 绑定商品 ----
const bindOpen = ref(false);
const bindProductId = ref('');
const products = useResource<unknown>('product.list', { page: 1, pageSize: OPTION_PAGE_SIZE });
const productOptions = computed(() =>
  asList<{ productId?: number; productName?: string; productCode?: string }>(products.data.value)
    .filter((p): p is { productId: number; productName?: string; productCode?: string } => typeof p.productId === 'number')
    .map((p) => ({ value: String(p.productId), label: `${p.productName ?? '未命名'}（${p.productCode ?? '—'}）` })),
);

function openBind(): void {
  notice.value = undefined;
  actionError.value = undefined;
  bindProductId.value = '';
  bindOpen.value = true;
}

/**
 * Element Plus 的属性整块给、放宽成 `any`。
 *
 * `ElSelect` / `ElOption` 在少数上下文里会被 vue-tsc 当成"属性定义对象"来校验而报类型错
 * （`StockOrderCreateView` 与 `TagListView` 里是同一处理，运行期完全一样）。
 */
const selectProps: any = { size: 'large', placeholder: '选择要绑定的商品', class: 'w-tag-field' };
function optionProps(opt: { value: string; label: string }): any {
  return { label: opt.label, value: opt.value };
}

async function confirmBind(): Promise<void> {
  const pid = Number(bindProductId.value);
  if (!Number.isFinite(pid) || pid <= 0) {
    actionError.value = '请先选择要绑定的商品。';
    return;
  }
  actionError.value = undefined;
  try {
    const saved = await bindMutation.run({ tagId: effectiveTagId.value, productId: pid });
    written.value = (saved ?? {}) as TagDetail;
    bindOpen.value = false;
    cache.invalidate('tag.list');
    notice.value = '已绑定。注意：绑定会把标签状态置为「已入库」。';
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}

// ---- 解绑 ----
async function doUnbind(): Promise<void> {
  notice.value = undefined;
  actionError.value = undefined;
  try {
    const saved = await unbindMutation.run({ tagId: effectiveTagId.value });
    written.value = (saved ?? {}) as TagDetail;
    cache.invalidate('tag.list');
    notice.value = '已解绑，标签回到「未绑定」。';
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}

// ---- 改标识 ----
const editOpen = ref(false);
const editForm = ref({ barcode: '', rfid: '', nfcUid: '' });
const editError = ref<string | undefined>(undefined);

function openEdit(): void {
  notice.value = undefined;
  actionError.value = undefined;
  editError.value = undefined;
  // 必须预填当前值：这个接口的空白串是"清空"（与 `product.update` 的"空白=保留"相反），
  // 表单空着提交就等于把三个标识全擦了。
  editForm.value = {
    barcode: display.value?.barcode ?? '',
    rfid: display.value?.rfid ?? '',
    nfcUid: display.value?.nfcUid ?? '',
  };
  editOpen.value = true;
}

async function confirmEdit(): Promise<void> {
  const f = editForm.value;
  if (f.barcode.trim() === '' && f.rfid.trim() === '' && f.nfcUid.trim() === '') {
    editError.value = '条形码、RFID 与 NFC 至少要留一个 —— 三个都空就没法标识这件物料了。';
    return;
  }
  editError.value = undefined;
  try {
    /*
     * 三个字段原样提交（含空串）：清空输入框的意图就是"清掉它"，而这个接口的语义正是
     * 空白串 = 写 null。不这么做就得猜用户"是想清空还是没改"，而猜错会静默改库。
     */
    const saved = await updateMutation.run({
      tagId: effectiveTagId.value,
      barcode: f.barcode.trim(),
      rfid: f.rfid.trim(),
      nfcUid: f.nfcUid.trim(),
    });
    written.value = (saved ?? {}) as TagDetail;
    editOpen.value = false;
    cache.invalidate('tag.list');
    notice.value = '标识已更新（清空的字段就是已清空）。';
  } catch (e) {
    editError.value = humanize(e as never);
  }
}

// ---- 删除 ----
const deleteConfirm = ref(false);
const deleteError = ref<string | undefined>(undefined);

async function doDelete(): Promise<void> {
  deleteError.value = undefined;
  try {
    await deleteMutation.run({ tagId: effectiveTagId.value });
    deleteConfirm.value = false;
    /*
     * 只失效**列表**，不写 `'tag'`：`'tag'` 会连本屏自己的 `tag.detail#…` 一起清掉，
     * 而缓存层现在会给挂载中的键补一次取数 —— 那一次拿到的是服务端 `@Cacheable(1800)`
     * 里的**旧值**（这条标签在服务端缓存里还存在），等于把刚删掉的东西又写回缓存。
     * 本屏紧接着就卸载了，它的详情没有任何理由再取一遍。
     */
    cache.invalidate('tag.list');
    // 内联（主从右栏）：交给列表清掉选中项；独立路由屏：回列表页
    // （列表走的是另一条读路径，不吃 `tag.detail` 那个缓存，能看到真实的"少了一条"）
    if (props.tagId !== undefined) {
      emit('deleted');
    } else {
      void router.push({ name: 'tag.list' });
    }
  } catch (e) {
    deleteConfirm.value = false;
    actionError.value = humanize(e as never);
  }
}

const items = computed<KeyValueItem[]>(() => {
  const d = display.value;
  return [
    { key: 'barcode', label: '条码', value: d?.barcode ?? null, mono: true },
    { key: 'rfid', label: 'RFID', value: d?.rfid ?? null, mono: true },
    { key: 'nfc', label: 'NFC UID', value: d?.nfcUid ?? null, mono: true },
    { key: 'productName', label: '绑定商品', value: d?.productName ?? null },
    { key: 'productCode', label: '商品编码', value: d?.productCode ?? null, mono: true },
    {
      key: 'status',
      label: '绑定状态',
      value: d?.status === undefined ? null : d.status === 1 ? '已绑定' : '未绑定',
      tone: d?.status === 1 ? 'success' : 'neutral',
    },
    { key: 'createTime', label: '创建时间', value: shortTime(d?.createTime) || null, mono: true },
    { key: 'updateTime', label: '更新时间', value: shortTime(d?.updateTime) || null, mono: true },
  ];
});
</script>

<template>
  <!--
    挂进主从右栏时脱掉"整屏"那套外壳（居中限宽 + 两侧内边距由右栏提供）。
    判据是"有没有拿到序号"而不是"在不在宽档"：独立路由屏同样可能出现在宽档，
    那时它仍然是整屏，不该被脱壳。
  -->
  <div class="w-page" :class="{ 'w-page--inline': props.inline === true }">
    <PageHeader
      :title="display?.productName ?? '标签详情'"
      :note="byCode ? `按编码查找：${code || '—'}` : `标签 #${props.tagId ?? '—'}`"
    >
      <template #actions>
        <StatusChip :text="display?.status === 1 ? '已绑定' : '未绑定'" :tone="display?.status === 1 ? 'success' : 'neutral'" />
      </template>
    </PageHeader>

    <StateHost
      :loading="loading"
      :error="error"
      :error-text="error ? humanize(error) : undefined"
      :empty="!enabled"
      skeleton="detail"
      empty-text="没有指定要查看的标签；请从标签管理点开一条，或扫一个条码。"
      @retry="reload"
    >
      <SectionBlock title="标签信息">
        <div class="w-card">
          <KeyValuePanel :items="items" />
        </div>
      </SectionBlock>
    </StateHost>

    <p v-if="notice" class="w-tag-notice" role="status">{{ notice }}</p>
    <p v-if="actionError" class="w-tag-error" role="alert">{{ actionError }}</p>

    <ActionDock>
      <!-- 主操作按状态互斥（一个标签不可能同时"要绑定"又"要解绑"），符合"主操作 ≤2"的既有口径 -->
      <ElButton v-if="canAct && display?.status !== 1" size="large" type="primary" :disabled="busy" @click="openBind">
        绑定商品
      </ElButton>
      <ElButton v-if="canAct && display?.status === 1" size="large" :disabled="busy" @click="doUnbind">
        解绑
      </ElButton>
      <ElButton v-if="canAct" size="large" text :disabled="busy" @click="openEdit">改标识</ElButton>
      <ElButton v-if="canAct" size="large" text type="danger" :disabled="busy" @click="deleteConfirm = true">
        删除标签
      </ElButton>
    </ActionDock>

    <ElDialog
      :model-value="bindOpen"
      title="绑定商品"
      width="var(--w-size-dialog-max-width)"
      append-to-body
      :close-on-click-modal="false"
      @update:model-value="(v: boolean) => { if (!v) bindOpen = false; }"
    >
      <p class="w-tag-hint">
        绑定会把标签状态置为「已入库」。若这个标签已经绑着别的商品，绑定会直接改嫁到新商品 —— 服务端不报错、也不会留旧记录。
      </p>
      <ElSelect v-model="bindProductId" v-bind="selectProps">
        <ElOption v-for="opt in productOptions" :key="opt.value" v-bind="optionProps(opt)" />
      </ElSelect>
      <p v-if="products.error.value" class="w-tag-error" role="alert">
        商品选项没取到：{{ humanize(products.error.value) }}。请关掉重开一次。
      </p>
      <template #footer>
        <ElButton size="large" :disabled="busy" @click="bindOpen = false">取消</ElButton>
        <ElButton size="large" type="primary" :loading="busy" :disabled="busy" @click="confirmBind">确认绑定</ElButton>
      </template>
    </ElDialog>

    <ElDialog
      :model-value="editOpen"
      title="修改标签标识"
      width="var(--w-size-dialog-max-width)"
      append-to-body
      :close-on-click-modal="false"
      @update:model-value="(v: boolean) => { if (!v) editOpen = false; }"
    >
      <p class="w-tag-hint">
        已预填当前值。把某一项清空再保存，就等于把这一项清掉（服务端的语义是"空白即清空"，与商品那边的"空白=保留"相反）。
      </p>
      <ElInput v-model="editForm.barcode" size="large" class="w-tag-field" placeholder="条形码" />
      <ElInput v-model="editForm.rfid" size="large" class="w-tag-field" placeholder="RFID" />
      <ElInput v-model="editForm.nfcUid" size="large" class="w-tag-field" placeholder="NFC UID" />
      <p v-if="editError" class="w-tag-error" role="alert">{{ editError }}</p>
      <template #footer>
        <ElButton size="large" :disabled="busy" @click="editOpen = false">取消</ElButton>
        <ElButton size="large" type="primary" :loading="busy" :disabled="busy" @click="confirmEdit">保存</ElButton>
      </template>
    </ElDialog>

    <ConfirmDialog
      :show="deleteConfirm"
      title="删除标签"
      :text="`将删除标签 #${effectiveTagId ?? '—'}（${display?.barcode ?? display?.rfid ?? display?.nfcUid ?? '无标识'}）。删除后无法恢复；若这个标签已被巡检或单据引用，服务端会拒绝并给出原因。`"
      confirm-text="确认删除"
      danger
      :pending="deleteMutation.pending.value"
      @confirm="doDelete"
      @cancel="deleteConfirm = false"
    />

    <!-- 换了要看的那条、数据还没回来时盖住整块：宽档是右栏，手机档是整屏详情 -->
    <LoadingLayer :show="loading" text="正在加载标签详情…" />
  </div>
</template>

<style scoped>
.w-card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-tag-notice,
.w-tag-error {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-size);
}

.w-tag-notice {
  border-left: 2px solid var(--w-state-success-text);
  background: var(--w-state-success-fill);
  color: var(--w-state-success-text);
}

.w-tag-error {
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  font-size: var(--w-type-body-small-size);
}

.w-tag-hint {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-tag-field {
  width: 100%;
  margin-bottom: var(--w-space-inline-gap);
}
</style>
