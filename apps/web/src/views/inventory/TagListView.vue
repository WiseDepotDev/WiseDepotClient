<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton, ElCheckbox, ElDialog, ElInput, ElOption, ElSelect } from 'element-plus';
import { asList, asTotal, humanize, useMutation, useNavStore, useResource, useResourceCacheStore } from '@wise/stores';
import {
  ActionDock,
  MasterDetail,
  PageHeader,
  PaginationBar,
  ResponsiveDataView,
  SectionBlock,
  StateHost,
  StatusChip,
  useViewport,
  type ColumnDef,
} from '@wise/ui';
import CaptchaField from '../../components/CaptchaField.vue';
import { useCaptcha } from '../../components/useCaptcha';
import TagDetailPanel from './TagDetailPanel.vue';

/**
 * 标签管理（`tag.list` + 批量绑定 / 批量解绑）。
 *
 * ## 三条业务约束
 *
 * 1. **批量绑定必须带验证码**（服务端 `tag.batchBindWithCaptcha` 的入参就有
 *    `captchaId`/`captchaCode`）—— 这是"影响多件物料"的破坏性操作，验证码是确认动作。
 *    绑定失败后**必须换一张**：验证码一次性，不换会让用户对着作废的图反复提交。
 * 2. **批量解绑不需要验证码**，但仍走二次确认（同样是多件物料）。
 * 3. **选中态由本屏自己持有**（不用表格的内置 selection）：批处理成功后要能干净地清空，
 *    把状态交给表格会出现"操作完了勾还在"。
 *
 * ## 主从视图（接上）
 *
 * 桌面宽档（≥1440）时左列表右详情并排；窄屏与手机维持"点行进详情路由"。
 */
interface TagRow {
  readonly tagId?: number;
  readonly barcode?: string;
  readonly nfcUid?: string;
  readonly rfid?: string;
  readonly status?: number;
  readonly productName?: string;
  readonly productCode?: string;
}

interface ProductRow {
  readonly productId?: number;
  readonly productName?: string;
  readonly productCode?: string;
}

const PAGE_SIZE = 20;
const OPTION_PAGE_SIZE = 50;

const router = useRouter();
const nav = useNavStore();
const cache = useResourceCacheStore();
const view = nav.viewStateOf('tag.list');

const selected = ref<number[]>([]);
const batch = ref<'bind' | 'unbind' | undefined>(undefined);
const productId = ref('');
const actionError = ref<string | undefined>(undefined);
/** 成功回执。"做完没反应"会让操作员重复点，这也是本仓一贯要求把结果说出来的原因。 */
const notice = ref<string | undefined>(undefined);
const captcha = useCaptcha();

// **`pageSize`，不是 `size`**：`TagController:112` 只认 `pageSize`（发 `size` 被静默忽略 →
// 永远 10 条/页）。真后端实测见 `tools/bench/inventory-tag-probe.mjs`。
const params = computed(() => ({ page: view.page, pageSize: PAGE_SIZE }));
const { data, loading, error, reload } = useResource<unknown>('tag.list', params);
const rows = computed(() => asList<TagRow>(data.value));
const total = computed(() => asTotal(data.value));

/** 绑定目标商品：拿第一页做选项（与建单屏同一手法：少量选项不做异步搜索）。 */
const products = useResource<unknown>('product.list', { page: 1, pageSize: OPTION_PAGE_SIZE });
const productOptions = computed(() =>
  asList<ProductRow>(products.data.value)
    .filter((p): p is ProductRow & { productId: number } => typeof p.productId === 'number')
    .map((p) => ({ value: String(p.productId), label: `${p.productName ?? '未命名'}（${p.productCode ?? '—'}）` })),
);

const bindMutation = useMutation('tag.batchBindWithCaptcha');
const unbindMutation = useMutation('tag.unbind');
const createMutation = useMutation('tag.create');
const busy = computed(() => bindMutation.pending.value || unbindMutation.pending.value || createMutation.pending.value);

// ---- 新建标签 ----
const createOpen = ref(false);
const createForm = ref({ barcode: '', rfid: '', nfcUid: '' });
const createError = ref<string | undefined>(undefined);

function openCreate(): void {
  notice.value = undefined;
  actionError.value = undefined;
  createError.value = undefined;
  createForm.value = { barcode: '', rfid: '', nfcUid: '' };
  createOpen.value = true;
}

/**
 * 新建标签。
 *
 * **刻意不带 `productId`**：服务端 `createTag` 不按 productId 推导状态
 * （`TagApplicationService:80-95`），带商品建出来的标签 `status` 仍是 0 ——
 * 那是"有商品却显示未绑定"这种自相矛盾界面的根源。绑定统一走 `tag.bind`（它会把 status 覆写成 1）。
 */
async function confirmCreate(): Promise<void> {
  const f = createForm.value;
  const barcode = f.barcode.trim();
  const rfid = f.rfid.trim();
  const nfcUid = f.nfcUid.trim();
  if (barcode === '' && rfid === '' && nfcUid === '') {
    createError.value = '条形码、RFID 与 NFC 至少要填一个 —— 三个都空就没法标识这件物料。';
    return;
  }
  createError.value = undefined;
  try {
    // 空字段**不传**（不是传空串）：传空串在服务端会被当成有效值写进去
    await createMutation.run({
      ...(barcode === '' ? {} : { barcode }),
      ...(rfid === '' ? {} : { rfid }),
      ...(nfcUid === '' ? {} : { nfcUid }),
    });
    createOpen.value = false;
    cache.invalidate('tag');
    reload();
    notice.value = '标签已创建。要绑定商品，点开这条标签用「绑定商品」。';
  } catch (e) {
    createError.value = humanize(e as never);
  }
}

/**
 * Element Plus 的属性整块给、放宽成 `any`（见 StockOrderCreateView 里的同一说明）：
 * `ElSelect` / `ElOption` / `ElCheckbox` 这批组件的 `buildProps` 类型在 `vue-tsc` 下解析不出来。
 */
function optionProps(opt: { value: string; label: string }): any {
  return { label: opt.label, value: opt.value };
}
const selectProps: any = { size: 'large', placeholder: '选择要绑定的商品', class: 'w-inv-field' };
const checkboxProps: any = { size: 'large' };

const columns: readonly ColumnDef<TagRow>[] = [
  { key: 'barcode', title: '条码', type: 'mono', width: 160, compact: 'primary' },
  { key: 'productName', title: '绑定商品', compact: 'secondary', value: (r) => r.productName ?? '未绑定' },
  { key: 'rfid', title: 'RFID', type: 'mono', width: 150 },
  { key: 'nfcUid', title: 'NFC', type: 'mono', width: 130 },
  {
    key: 'status',
    title: '状态',
    type: 'status',
    width: 110,
    compact: 'chip',
    value: (r) => (r.status === 1 ? '已绑定' : '未绑定'),
    tone: (r) => (r.status === 1 ? 'success' : 'neutral'),
  },
];

/*
 * ---------------------------------------------------------------- 主从视图
 *
 * 为什么宽档点行只改组件状态、不 push 详情路由：本仓 `<RouterView :key="route.fullPath">`
 * 会强制整树重挂 —— 走了详情路由，左栏会被销毁重建（页码回 1、勾选与滚动位置全丢），
 * 表现是"点一行整屏闪一下"。所以宽档点行只设 `selectedId`。
 *
 * 为什么窄档那条老路必须原样留着：手机上并排两个栏目谁都看不清，
 * 而且按 hash 导航是深链 / 扫码 / 返回键的基础。
 *
 * 为什么主从要另备一套列定义：主从左栏只有约 700px，而完整列定义的固定宽加起来
 * 已经到 550px（再加表头内边距与批选列）—— 硬塞会被 `.w-content` 的 `overflow-x: hidden`
 * 裁掉（不是出滚动条，是右半边直接没了）。所以主从只留"认标签"最要紧的几列。
 */
const { isWide } = useViewport();
const selectedId = ref<number | undefined>(undefined);

/** 主从版列定义：条码 / 绑定商品 / RFID / 状态。NFC 与完整视图里的其余列留给宽屏以外的完整视图。 */
const masterColumns: readonly ColumnDef<TagRow>[] = [
  { key: 'barcode', title: '条码', type: 'mono', width: 150, compact: 'primary' },
  { key: 'productName', title: '绑定商品', compact: 'secondary', value: (r) => r.productName ?? '未绑定' },
  { key: 'rfid', title: 'RFID', type: 'mono', width: 140 },
  {
    key: 'status',
    title: '状态',
    type: 'status',
    width: 100,
    compact: 'chip',
    value: (r) => (r.status === 1 ? '已绑定' : '未绑定'),
    tone: (r) => (r.status === 1 ? 'success' : 'neutral'),
  },
];

const activeColumns = computed(() => (isWide.value ? masterColumns : columns));

function toggle(tagId: number | undefined, checked: boolean): void {
  if (tagId === undefined) {
    return;
  }
  const set = new Set(selected.value);
  if (checked) {
    set.add(tagId);
  } else {
    set.delete(tagId);
  }
  selected.value = [...set];
}

function openBatch(kind: 'bind' | 'unbind'): void {
  actionError.value = undefined;
  notice.value = undefined;
  productId.value = '';
  batch.value = kind;
  if (kind === 'bind') {
    void captcha.refresh();
  }
}

async function confirmBatch(): Promise<void> {
  const kind = batch.value;
  const tagIds = selected.value;
  if (kind === undefined || tagIds.length === 0) {
    batch.value = undefined;
    return;
  }
  actionError.value = undefined;
  try {
    if (kind === 'bind') {
      const pid = Number(productId.value);
      if (!Number.isFinite(pid) || pid <= 0) {
        actionError.value = '请先选择要绑定的商品。';
        return;
      }
      if (captcha.code.value.trim() === '') {
        actionError.value = '请填写验证码：批量绑定会影响多件物料，必须确认。';
        return;
      }
      await bindMutation.run({
        tagIds,
        productId: pid,
        captchaId: captcha.captcha.value?.captchaId ?? '',
        captchaCode: captcha.code.value.trim(),
      });
    } else {
      /*
       * **"批量解绑"只能逐条做**：服务端的 `tag.batchUnbind` 签名是 `@RequestBody List<Long>`
       * （整个 body 就是数组），与网关的信封结构不兼容 —— 两种形态都 400
       * （真后端实测见 `tools/bench/inventory-tag-probe.mjs`）。单条的 `tag.unbind` 是好的。
       *
       * **必须串行，不能用 `Promise.all`**：资源层的 `mutate()` 单飞键是**方法名**
       * （`resource.ts` 的 `inflightMutations.get(method)`），并发发同一个方法会**共享同一个 promise** ——
       * 一条请求的成败会被当成所有条的结果。串行还顺带能做到"哪几条没成"说得清，
       * 而"批量操作静默失败"正是本仓最忌的。
       */
      let okCount = 0;
      const failures: string[] = [];
      for (const tagId of tagIds) {
        try {
          await unbindMutation.run({ tagId });
          okCount += 1;
        } catch (e) {
          failures.push(`#${tagId}（${humanize(e as never)}）`);
        }
      }
      selected.value = [];
      batch.value = undefined;
      cache.invalidate('tag');
      reload();
      if (failures.length === 0) {
        notice.value = `已解绑 ${okCount} 个标签。`;
      } else {
        actionError.value = `已解绑 ${okCount} 个；下面 ${failures.length} 个没成功：${failures.join('、')}`;
      }
      return;
    }
    selected.value = [];
    batch.value = undefined;
    cache.invalidate('tag');
    reload();
  } catch (e) {
    actionError.value = humanize(e as never);
    // 危险操作的验证码是一次性的：失败就换一张，不让用户对着作废的图重试
    if (kind === 'bind') {
      captcha.refreshAfterFailure();
    }
  }
}

onMounted(() => {
  void products.reload();
});

function openDetail(row: TagRow): void {
  if (row.tagId === undefined) {
    return;
  }
  if (isWide.value) {
    selectedId.value = row.tagId;
    return;
  }
  void router.push({ name: 'tag.detail', params: { tagId: String(row.tagId) } });
}

/**
 * 右栏删掉了这条标签：清掉选中项，并且**显式重取列表**。
 *
 * 为什么必须重取：面板里做的是 `cache.invalidate('tag')` —— 那只是**清缓存**，
 * 不会自己发请求。窄档之所以看起来正常，是因为它 push 回列表路由、列表屏重挂载后顺手取了一次；
 * 宽档列表屏一直在原地，不重取就会继续显示那条已经被删掉的标签。
 */
function onPanelDeleted(): void {
  selectedId.value = undefined;
  reload();
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="标签管理" :note="total !== undefined ? `共 ${total} 个标签` : '条码 / RFID / NFC 标签'">
      <template #actions>
        <!-- 桌面档留在页头；手机档移到底部动作条 -->
        <ElButton class="w-hide-compact" size="large" @click="openCreate">新建标签</ElButton>
        <!--
          批量动作**没选中就不渲染**（原来是"渲染但禁用"）。
          在手机档尤其重要：没选中时页头因此整块不占位（`:has()` 那条规则），
          选中之后它才出现 —— 这正是"不可用的按钮不得渲染"的落点。
        -->
        <ElButton v-if="selected.length > 0" size="large" @click="openBatch('unbind')">
          批量解绑（{{ selected.length }}）
        </ElButton>
        <ElButton v-if="selected.length > 0" size="large" type="primary" @click="openBatch('bind')">
          批量绑定（{{ selected.length }}）
        </ElButton>
      </template>
    </PageHeader>

    <ActionDock>
      <ElButton class="w-show-compact-only w-actiondock__block" size="large" type="primary" @click="openCreate">
        新建标签
      </ElButton>
    </ActionDock>

    <p v-if="notice && batch === undefined" class="w-inv-notice" role="status">{{ notice }}</p>
    <p v-if="actionError && batch === undefined" class="w-inv-error" role="alert">{{ actionError }}</p>

    <MasterDetail>
      <template #list>
        <SectionBlock :title="`标签列表${selected.length > 0 ? ` · 已选 ${selected.length} 项` : ''}`">
          <StateHost
            :loading="loading"
            :error="error"
            :error-text="error ? humanize(error) : undefined"
            :empty="rows.length === 0"
            empty-text="还没有标签。入库后系统会为每件物料生成标签。"
            skeleton="list"
            @retry="reload"
          >
            <ResponsiveDataView
              :columns="activeColumns"
              :rows="rows"
              :row-key="(r: TagRow) => String(r.tagId ?? r.barcode ?? '')"
              clickable
              @row-click="openDetail"
            >
              <template #lead="{ row }">
                <ElCheckbox
                  v-bind="checkboxProps"
                  :model-value="row.tagId !== undefined && selected.includes(row.tagId)"
                  @update:model-value="(v: unknown) => toggle(row.tagId, v === true)"
                />
              </template>
            </ResponsiveDataView>
            <PaginationBar
              :page="view.page"
              :page-size="PAGE_SIZE"
              :total="total ?? rows.length"
              :loading="loading"
              @update:page="(p: number) => (view.page = p)"
            />
          </StateHost>
        </SectionBlock>
      </template>
      <template #detail>
        <!--
          右栏：选中了才渲染面板（没选中时不发一个必然是空的请求）；
          未选中时给一句话说明怎么用，而不是留一片空白 ——
          空白会让人以为"右栏坏了"，而它其实只是在等一次点击。
        -->
        <TagDetailPanel v-if="selectedId !== undefined" inline :tag-id="selectedId" @deleted="onPanelDeleted" />
        <div v-else class="w-inv-pick">从左边点一条标签，这里显示它的明细。</div>
      </template>
    </MasterDetail>

    <ElDialog
      :model-value="batch !== undefined"
      :title="batch === 'bind' ? '批量绑定标签' : '批量解绑标签'"
      width="var(--w-size-dialog-max-width)"
      append-to-body
      :close-on-click-modal="false"
      @update:model-value="(v: boolean) => { if (!v) batch = undefined; }"
    >
      <p class="w-inv-hint">将对已选中的 {{ selected.length }} 个标签执行此操作，操作前请再核对一次。</p>

      <template v-if="batch === 'bind'">
        <ElSelect v-model="productId" v-bind="selectProps">
          <ElOption v-for="opt in productOptions" :key="opt.value" v-bind="optionProps(opt)" />
        </ElSelect>
        <CaptchaField :state="captcha" />
      </template>

      <p v-if="actionError" class="w-inv-error" role="alert">{{ actionError }}</p>

      <template #footer>
        <ElButton size="large" :disabled="busy" @click="batch = undefined">取消</ElButton>
        <ElButton
          size="large"
          :type="batch === 'unbind' ? 'danger' : 'primary'"
          :loading="busy"
          :disabled="busy"
          @click="confirmBatch"
        >
          {{ batch === 'bind' ? '确认绑定' : '确认解绑' }}
        </ElButton>
      </template>
    </ElDialog>

    <ElDialog
      :model-value="createOpen"
      title="新建标签"
      width="var(--w-size-dialog-max-width)"
      append-to-body
      :close-on-click-modal="false"
      @update:model-value="(v: boolean) => { if (!v) createOpen = false; }"
    >
      <p class="w-inv-hint">
        条形码、RFID、NFC 至少填一个 —— 它们是这件物料的身份。新建出来的标签是「未绑定」，绑定商品请在标签详情里做（绑定会同时把状态置为已入库）。
      </p>
      <ElInput v-model="createForm.barcode" size="large" class="w-inv-field" placeholder="条形码，如 6901234567890" />
      <ElInput v-model="createForm.rfid" size="large" class="w-inv-field" placeholder="RFID，如 E28278020000000029D0FD6D" />
      <ElInput v-model="createForm.nfcUid" size="large" class="w-inv-field" placeholder="NFC UID，如 04A1B2C3" />
      <p v-if="createError" class="w-inv-error" role="alert">{{ createError }}</p>
      <template #footer>
        <ElButton size="large" :disabled="busy" @click="createOpen = false">取消</ElButton>
        <ElButton size="large" type="primary" :loading="busy" :disabled="busy" @click="confirmCreate">
          创建标签
        </ElButton>
      </template>
    </ElDialog>
  </div>
</template>

<style scoped>
/* 主从右栏"还没选"时的提示：muted 小字 + 虚线框，明说它在等一次点击。 */
.w-inv-pick {
  padding: var(--w-space-card-padding);
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
  background: var(--w-color-surface-alt);
  border: 1px dashed var(--w-color-outline);
  border-radius: var(--w-radius-card);
}

.w-inv-hint {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}

.w-inv-field {
  width: 100%;
  margin-bottom: var(--w-space-inline-gap);
}

.w-inv-notice {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-success-text);
  background: var(--w-state-success-fill);
  color: var(--w-state-success-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-size);
}

.w-inv-error {
  margin: var(--w-space-inline-gap) 0 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}
</style>
