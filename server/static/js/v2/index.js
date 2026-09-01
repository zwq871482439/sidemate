// 桌伴 0.10.1 新版 UI 入口（M1-D 三栏组件迁移时填充）。
// M1-A 仅为构建链占位：证明 esbuild 可构建、CI 可验证。
// 新旧 UI 并行期：index.html 不引用本产物；index-0101.html 才引用 v2/dist/bundle.js。
window.SidemateV2 = {
  version: '0.10.1-m1a',
  mounted: false,
  mount() {
    throw new Error('SidemateV2 界面尚未实装（M1-D 迁移中）');
  },
};
