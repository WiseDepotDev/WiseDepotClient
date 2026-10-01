<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElButton, ElInput } from 'element-plus';
import { asList, humanize, useMutation, useResource, useResourceCacheStore } from '@wise/stores';
import {
  ActionDock,
  ConfirmDialog,
  KeyValuePanel,
  PageHeader,
  SectionBlock,
  StateHost,
  StatusChip,
  type KeyValueItem,
} from '@wise/ui';
import {
  actionMetaOf,
  activeText,
  alertActionsOf,
  alertDetailOf,
  alertStateOf,
  alertStateText,
  alertStateTone,
  deviceText,
  levelText,
  levelTone,
  logResultText,
  logStateOf,
  sourceModuleText,
  timeText,
  type AlertActionKind,
  type AlertDetail,
  type HandleLog,
} from './alertState.js';

/**
 * 告警详情（`alert.detail` + `alert.logs` + `alert.ack` / `alert.status`）。
 *
 * 三条业务规则**原样搬自 React 版**（那里是踩过坑写下来的，不是风格偏好）：
 *
 * 1. **动作按状态决定，不能做的把原因写在按钮旁边**。服务端 `acknowledgeAlert`
 *    对非「未处理」的告警没有任何副作用地直接返回，而 `updateAlertStatus` 对状态流转
 *    **不做任何校验**（照请求里的数字写库）。"这一步能不能点"只有界面说得清 ——
 *    让操作员点一下才发现没反应，等于把服务端实现细节丢给用户。
 * 2. **结束类动作不可撤销 → 二次确认**；且本屏**不提供"重新打开"**（服务端没这能力，
 *    摆一个点了没用的按钮比没有按钮更糟）。
 * 3. **忽略必须写原因**（至少 2 个字）：原因会进处理记录。忽略一条告警而不说为什么，
 *    下一个翻记录的人只会看到一个没有解释的「已忽略」。
 */
const route = useRoute();
const cache = useResourceCacheStore();

/** 路由参数 → 告警序号。转不出来就当"没有目标"，不发一个必然是错的请求（服务端只认数字序号）。 */
const eventId = computed<number | undefined>(() => {
  const raw = route.params.alertId;
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
});
const hasTarget = computed(() => eventId.value !== undefined);
const params = computed(() => (eventId.value === undefined ? undefined : { eventId: eventId.value }));

const detail = useResource<unknown>('alert.detail', params, { enabled: hasTarget });
const logsCall = useResource<unknown>('alert.logs', params, { enabled: hasTarget });

const alert = computed<AlertDetail | undefined>(() => alertDetailOf(detail.data.value));
const logs = computed(() => asList<HandleLog>(logsCall.data.value));
const state = computed(() => alertStateOf(alert.value));
const actions = computed(() => alertActionsOf(state.value));

const infoItems = computed<KeyValueItem[]>(() => {
  const a = alert.value;
  return [
    { key: 'content', label: '告警内容', value: a?.message ?? '未上报' },
    { key: 'source', label: '来源', value: sourceModuleText(a?.sourceModule) },
    { key: 'level', label: '等级', value: levelText(a?.level), tone: levelTone(a?.level) },
    { key: 'device', label: '设备', value: deviceText(a) },
    { key: 'active', label: '是否仍在发生', value: activeText(a) },
    { key: 'time', label: '发生时间', value: timeText(a?.createTime, '未上报'), mono: true },
    { key: 'resolvedTime', label: '解除时间', value: timeText(a?.resolvedTime, '未解除'), mono: true },
    { key: 'resolvedBy', label: '解除人', value: a?.resolvedBy === undefined ? '未登记' : String(a.resolvedBy), mono: true },
    { key: 'extended', label: '扩展信息', value: a?.extendedData ?? '无' },
  ];
});

// ---- 动作 ----

const pendingKind = ref<AlertActionKind | undefined>(undefined);
const remark = ref('');
const actionError = ref<string | undefined>(undefined);
const notice = ref<string | undefined>(undefined);

const meta = computed(() => (pendingKind.value === undefined ? undefined : actionMetaOf(pendingKind.value)));

const ackMutation = useMutation('alert.ack');
const statusMutation = useMutation('alert.status');
const busy = computed(() => ackMutation.pending.value || statusMutation.pending.value);

const dialogTitle = computed(() => meta.value?.title ?? '');
const dialogConfirmText = computed(() => meta.value?.confirmText ?? '确认');

function openDialog(kind: AlertActionKind): void {
  actionError.value = undefined;
  notice.value = undefined;
  remark.value = '';
  pendingKind.value = kind;
}

function closeDialog(): void {
  pendingKind.value = undefined;
  remark.value = '';
}

function reloadAll(): void {
  cache.invalidate('alert');
  detail.reload();
  logsCall.reload();
}

async function confirmAction(): Promise<void> {
  const kind = pendingKind.value;
  const id = eventId.value;
  if (kind === undefined || id === undefined) {
    closeDialog();
    return;
  }
  actionError.value = undefined;
  notice.value = undefined;

  try {
    if (kind === 'ack') {
      await ackMutation.run({ eventId: id });
      notice.value = actionMetaOf('ack').successText;
      closeDialog();
      reloadAll();
      return;
    }

    const text = remark.value.trim();
    if (kind === 'ignore' && text.length < 2) {
      actionError.value = '请写清楚忽略的原因（至少 2 个字），下一个翻记录的人要照着它判断。';
      return;
    }

    // 只带服务端认识的字段；没填说明就不发这个键（服务端写进处理记录的 remark）
    const body: { eventId: number; status: number; remark?: string } = {
      eventId: id,
      status: actionMetaOf(kind).status ?? 2,
    };
    if (text.length > 0) {
      body.remark = text;
    }
    await statusMutation.run(body);
    notice.value = actionMetaOf(kind).successText;
    closeDialog();
    reloadAll();
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}

// 换一条告警（路由参数变）时必须清掉上一条的提示，否则会看到"已忽略"却对着另一条告警
watch(eventId, () => {
  notice.value = undefined;
  actionError.value = undefined;
  closeDialog();
});
</script>

<template>
  <div class="w-page">
    <PageHeader
      :title="alert?.title ?? '告警详情'"
      :note="`序号 #${eventId ?? '—'} · ${sourceModuleText(alert?.sourceModule)} · ${timeText(alert?.createTime, '时间未上报')}`"
    >
      <template #actions>
        <StatusChip :text="alertStateText(state)" :tone="alertStateTone(state)" />
        <ElButton size="large" :loading="detail.loading.value" @click="reloadAll">刷新</ElButton>
      </template>
    </PageHeader>

    <p v-if="notice" class="w-alert-notice" role="status">{{ notice }}</p>

    <StateHost
      :loading="detail.loading.value"
      :error="detail.error.value"
      :error-text="detail.error.value ? humanize(detail.error.value) : undefined"
      :empty="!hasTarget"
      skeleton="detail"
      empty-text="没有指定要查看的告警；请从告警中心点开一条。"
      @retry="reloadAll"
    >
      <SectionBlock title="告警信息">
        <div class="w-card">
          <KeyValuePanel :items="infoItems" />
        </div>
      </SectionBlock>

      <SectionBlock :title="`处理记录${logs.length > 0 ? `（${logs.length} 条）` : ''}`">
        <StateHost
          :loading="logsCall.loading.value"
          :error="logsCall.error.value"
          :error-text="logsCall.error.value ? humanize(logsCall.error.value) : undefined"
          :empty="logs.length === 0"
          empty-text="还没有处理记录"
          skeleton="list"
          @retry="logsCall.reload"
        >
          <ul class="w-log-list">
            <li v-for="(log, index) in logs" :key="log.logId ?? index" class="w-log">
              <div class="w-log__head">
                <span class="w-log__who">{{ log.handlerName ?? (log.handlerId === undefined ? '未登记处理人' : `处理人 ${log.handlerId}`) }}</span>
                <StatusChip :text="logResultText(log)" :tone="alertStateTone(logStateOf(log))" />
              </div>
              <div class="w-log__meta">
                <span class="w-mono">{{ timeText(log.handleTime, '时间未上报') }}</span>
              </div>
              <p v-if="log.remark" class="w-log__remark">{{ log.remark }}</p>
            </li>
          </ul>
        </StateHost>
      </SectionBlock>

      <SectionBlock title="可以做的操作">
        <div class="w-alert-actions">
          <div class="w-alert-action">
            <ElButton
              size="large"
              :disabled="!actions.ack.enabled || busy"
              :loading="ackMutation.pending.value"
              @click="openDialog('ack')"
            >
              确认收到
            </ElButton>
            <span v-if="!actions.ack.enabled" class="w-alert-reason">{{ actions.ack.reason }}</span>
          </div>

          <div class="w-alert-action">
            <ElButton
              size="large"
              type="primary"
              :disabled="!actions.resolve.enabled || busy"
              :loading="statusMutation.pending.value && pendingKind === 'resolve'"
              @click="openDialog('resolve')"
            >
              处理完成
            </ElButton>
            <span v-if="!actions.resolve.enabled" class="w-alert-reason">{{ actions.resolve.reason }}</span>
          </div>

          <div class="w-alert-action">
            <ElButton
              size="large"
              type="danger"
              :disabled="!actions.ignore.enabled || busy"
              :loading="statusMutation.pending.value && pendingKind === 'ignore'"
              @click="openDialog('ignore')"
            >
              忽略
            </ElButton>
            <span v-if="!actions.ignore.enabled" class="w-alert-reason">{{ actions.ignore.reason }}</span>
          </div>
        </div>
      </SectionBlock>
    </StateHost>

    <ActionDock>
      <ElButton size="large" :loading="detail.loading.value" @click="reloadAll">刷新</ElButton>
    </ActionDock>

    <ConfirmDialog
      :show="pendingKind !== undefined"
      :title="dialogTitle"
      :confirm-text="dialogConfirmText"
      :danger="meta?.danger === true"
      :pending="busy"
      @confirm="confirmAction"
      @cancel="closeDialog"
    >
      <p v-if="meta?.needsRemark" class="w-alert-dialog-hint">
        {{ pendingKind === 'ignore' ? '忽略原因会写进处理记录（至少 2 个字）' : '处理说明可以不填' }}
      </p>
      <ElInput
        v-if="meta?.needsRemark"
        v-model="remark"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 4 }"
        :placeholder="pendingKind === 'ignore' ? '例如：设备已返厂检修，暂不处理' : '例如：已更换读头并复核'"
      />
      <p v-if="actionError" class="w-alert-error" role="alert">{{ actionError }}</p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.w-card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-alert-notice {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-success-text);
  background: var(--w-state-success-fill);
  color: var(--w-state-success-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-size);
}

.w-log-list {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-row-gap);
  list-style: none;
  margin: 0;
  padding: 0;
}

.w-log {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-log__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--w-space-inline-gap);
}

.w-log__who {
  font-weight: var(--w-type-label-weight);
}

.w-log__meta {
  margin-top: var(--w-space-inline-gap);
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}

.w-log__remark {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-body-size);
}

.w-alert-actions {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-group-gap);
}

.w-alert-action {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-inline-gap);
  align-items: flex-start;
}

/* 不能点的原因必须写在按钮旁边：让操作员点一下才发现没反应，等于把服务端实现细节丢给用户 */
.w-alert-reason {
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-alert-dialog-hint {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}

.w-alert-error {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-state-danger-text);
  font-size: var(--w-type-body-small-size);
}
</style>
