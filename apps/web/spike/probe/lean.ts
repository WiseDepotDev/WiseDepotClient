/** 体积探针 1：登录/首屏最小集合。 */
import { createApp, h } from 'vue';
import { NButton, NConfigProvider, NForm, NFormItem, NInput, NMessageProvider, NTag } from 'naive-ui';
import { fullOverridesWithInverted } from '../theme.spike';

const App = {
  render: () =>
    h(NConfigProvider, { themeOverrides: fullOverridesWithInverted }, {
      default: () =>
        h(NMessageProvider, null, {
          default: () => [
            h(NForm, null, {
              default: () => [
                h(NFormItem, { label: '账号' }, { default: () => h(NInput, { placeholder: '账号' }) }),
                h(NFormItem, { label: '密码' }, { default: () => h(NInput, { type: 'password' }) }),
                h(NButton, { type: 'primary', size: 'large', block: true }, { default: () => '登录' }),
              ],
            }),
            h(NTag, { type: 'info' }, { default: () => '开发态假桥' }),
          ],
        }),
    }),
};

createApp(App).mount(document.createElement('div'));
