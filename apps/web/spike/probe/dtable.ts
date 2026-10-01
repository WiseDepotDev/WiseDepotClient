/** 体积探针 4：lean + NDataTable + NPagination，用于把 DataTable 的代价单独摘出来。 */
import { createApp, h } from 'vue';
import {
  NButton,
  NCard,
  NConfigProvider,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NMessageProvider,
  NPagination,
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
            h(NForm, null, {
              default: () => [
                h(NFormItem, { label: '账号' }, { default: () => h(NInput, { placeholder: '账号' }) }),
                h(NButton, { type: 'primary', size: 'large' }, { default: () => '登录' }),
              ],
            }),
            h(NCard, { title: '库存明细' }, {
              default: () => [
                h(NDataTable, { columns, data, size: 'large', virtualScroll: true, maxHeight: 520 }),
                h(NPagination, { page: 1, pageCount: 12 }),
              ],
            }),
            h(NTag, { type: 'success' }, { default: () => '正常' }),
          ],
        }),
    }),
};

createApp(App).mount(document.createElement('div'));
