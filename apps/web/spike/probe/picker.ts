/** 体积探针 5：lean + NSelect + NDatePicker，用于把日期/选择器的代价单独摘出来。 */
import { createApp, h } from 'vue';
import {
  NButton,
  NConfigProvider,
  NDatePicker,
  NForm,
  NFormItem,
  NInput,
  NMessageProvider,
  NSelect,
  NTag,
} from 'naive-ui';
import { fullOverridesWithInverted } from '../theme.spike';

const App = {
  render: () =>
    h(NConfigProvider, { themeOverrides: fullOverridesWithInverted }, {
      default: () =>
        h(NMessageProvider, null, {
          default: () => [
            h(NForm, { inline: true }, {
              default: () => [
                h(NFormItem, { label: '账号' }, { default: () => h(NInput, { placeholder: '账号' }) }),
                h(NFormItem, { label: '状态' }, { default: () => h(NSelect, { options: [] }) }),
                h(NFormItem, { label: '时间' }, { default: () => h(NDatePicker, { type: 'daterange' }) }),
                h(NButton, { type: 'primary', size: 'large' }, { default: () => '登录' }),
              ],
            }),
            h(NTag, { type: 'success' }, { default: () => '正常' }),
          ],
        }),
    }),
};

createApp(App).mount(document.createElement('div'));
