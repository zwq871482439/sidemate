// 最小 ESLint 配置（sidemate-dev#21）：只做 no-undef 机器卡点。
// 背景：934a1c7 在 _renderConfirmCard 里引用了不在作用域的 _kind2，
// 运行期 ReferenceError 炸掉整个聊天区渲染，而 node --check 只查语法查不出。
// 规则面刻意收窄——本配置不承担风格/质量审查，只拦「未定义变量」这一类缺陷。
export default [
  {
    files: ["server/static/js/v2/**/*.js"],
    ignores: ["server/static/js/v2/dist/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // 浏览器环境（v2 UI 运行在 Electron/浏览器里）
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        console: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        FormData: "readonly",
        Event: "readonly",
        CustomEvent: "readonly",
        KeyboardEvent: "readonly",
        MouseEvent: "readonly",
        FileReader: "readonly",
        Blob: "readonly",
        history: "readonly",
        location: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        getComputedStyle: "readonly",
        matchMedia: "readonly",
        ResizeObserver: "readonly",
        MutationObserver: "readonly",
        IntersectionObserver: "readonly",
        DOMParser: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        EventSource: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        alert: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        marked: "readonly",        // 静态 vendor 脚本（index.html 先于 bundle 加载）
        DOMPurify: "readonly",     // 同上
        mermaid: "readonly",       // 懒加载 vendor：cards_content._loadMermaid 首个图表块出现时注入 <script>，使用前有 typeof 守卫
      },
    },
    rules: {
      "no-undef": "error",
    },
  },
];
