# 面板不依赖宿主 UI 组件库

浏览器端只用 React 原生元素、宿主 CSS 变量与文字符号（↻ × 等），不 require 宿主的 UI primitives，也没有 JSX 与构建步骤——用运行时 `createElement` 直接调用。

原因是一个不可见的约束：宿主图标组件名在版本间变过（`IconCloseOutline16` → `IconCloseOutlineRegular`），require 到 `undefined` 后 React 抛错、整个插槽**静默崩溃**，没有任何提示。代价是视觉要手动对齐宿主的设计 token，而不是靠组件库对齐。
