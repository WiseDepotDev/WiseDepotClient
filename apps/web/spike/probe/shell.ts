/** 体积探针 3：双壳（在列表页基础上加 Layout / Sider / Menu / 顶栏）。 */
import { createApp, h } from 'vue';
import {
  NBadge,
  NButton,
  NCard,
  NConfigProvider,
  NDataTable,
  NDatePicker,
  NDrawer,
  NForm,
  NFormItem,
  NInput,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NLayoutSider,
  NMenu,
  NMessageProvider,
  NPagination,
  NSelect,
  NTag,
  NTooltip,
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
          default: () =>
            h(NLayout, { hasSider: true }, {
              default: () => [
                h(NLayoutSider, { width: 232, inverted: true }, {
                  default: () => h(NMenu, { inverted: true, options: [{ label: '工作台', key: 'd' }] }),
                }),
                h(NLayout, null, {
                  default: () => [
                    h(NLayoutHeader, { style: { height: '56px' } }, {
                      default: () => [
                        h(NInput, { placeholder: '搜索', style: { width: '280px' } }),
                        h(NBadge, { value: 6 }, { default: () => h(NButton, { quaternary: true }, { default: () => '消息' }) }),
                        h(NTooltip, null, { trigger: () => h(NButton, { quaternary: true }, { default: () => '状态' }) }),
                      ],
                    }),
                    h(NLayoutContent, null, {
                      default: () => [
                        h(NForm, { inline: true }, {
                          default: () => [
                            h(NFormItem, { label: '状态' }, { default: () => h(NSelect, { options: [] }) }),
                            h(NFormItem, { label: '时间' }, { default: () => h(NDatePicker, { type: 'daterange' }) }),
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
                  ],
                }),
              ],
            }),
        }),
    }),
};

createApp(App).mount(document.createElement('div'));
