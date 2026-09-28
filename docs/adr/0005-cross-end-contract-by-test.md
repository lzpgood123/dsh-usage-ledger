# 跨端共享的规则靠契约测试钉住，而不是抽共享模块

宿主端与浏览器端共用同一套口径（接口前缀、范围词表、热力图天数），很自然会想「把它们抽成一个共享模块，两端 import 同一份」。**这条路在本平台上是堵死的**，而且堵它的两个原因都不在代码里，看代码只会得出相反的结论。

其一，浏览器端的 bundle 是传统 `<script src>` 加载的，**不是 ES module**：引导批次由宿主作为 `script-src` 注入，渲染成 `<script src="...">`，不带 `type="module"`；其余包（含本插件的 `client.js`）则由模块系统的 transport 用 `document.createElement("script")` 挂上去，同样是传统脚本。所以 `src/client.js` 里写静态 `import` 会直接 `SyntaxError: Cannot use import statement outside a module`。

其二，客户端模块系统交给 factory 的 `require` **只认包名与平台 seed，不解析相对路径**。它按「seed 词 → 已物化模块 → 已注册的包 factory」依次查找，找不到就抛 `require("./view") missed the module table`。`require("./view")`、`require("../scan.js")` 都不例外；`require.async("./view")` 则报 `invalid relative chunk request`（动态相对路径只接受 `client.*.js` 这种包内 chunk 名）。

于是**决定**：共享不了的规则靠测试钉住一致性，而不是抽模块。`test/contract.test.js` 把 `src/client.js` 当**文本**读进来，用正则取出它写死的字面量，再与 `src/index.js` 导出的 `BASE_PATH` / `RANGE_KINDS` / `ACTIVITY_DAYS` 比较——「两端必须一致」就从一句注释变成了会失败的断言。

代价：新增一种范围仍要在两处各写一次（宿主端 `RANGE_KINDS` 与 `resolveRange`，浏览器端 `tabs`），但漂移会被测试立刻抓住，而不是面板静默 404、热力图窗口悄悄变短。ADR-0004 排除了构建步骤，所以也没有 bundler 能替我们把相对路径解析掉——这条约束不会随时间消失。
