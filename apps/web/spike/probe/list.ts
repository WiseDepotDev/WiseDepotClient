/** 体积探针 2：列表页（在主从工作台里再加数据表/筛选/分页/抽屉）。 */
import { createApp, h } from 'vue';
import {
  NButton,
  NCard,
  NConfigProvider,
  NDataTable,
  NDatePicker,
  NDrawer,
  NForm,
  NFormItem,
  NInput,
  NMessageProvider,
  NPagination,
  NSelect,
  NTag,
} from 'naive-ui';
import { fullOverridesWithInverted } from '../theme.spike';

const columns = [
  { title: '单号', key: 'code' },
  { title: '状态', key: 'status' },
];
const data = [{ code: 'WD-0001', status: '正常' }];

const App = {
  render: () =>
    h(NConfigProvider, { themeOverrides: fullOverridesWithInverted }, {
      default: () =>
        h(NMessageProvider, null, {
          default: () => [
            h(NForm, { inline: true }, {
              default: () => [
                h(NFormItem, { label: '状态' }, { default: () => h(NSelect, { options: [] }) }),
                h(NFormItem, { label: '时间' }, { default: () => h(NDatePicker, { type: 'daterange' }) }),
                h(NFormItem, { label: '搜索' }, { default: () => h(NInput, { placeholder: '搜索' }) }),
              ],
            }),
            h(NCard, { title: '库存明细' }, {
              default: () => [
                h(NDataTable, { columns, data, size: 'large', virtualScroll: true, maxHeight: 520 }),
                h(NPagination, { page: 1, pageCount: 12 }),
              ],
            }),
            h(NDrawer, { show: false }, { default: () => '详情' }),
            h(NButton, { type: 'primary', size: 'large' }, { default: () => '新建' }),
            h(NTag, { type: 'success' }, { default: () => '正常' }),
          ],
        }),
    }),
};

createApp(App).mount(document.createElement('div'));
