# ADR-0008：未定价模型的「面板内认领」机制

- 状态：**已接受**（已实现）
- 日期：2026-10-02
- 相关：ADR-0001（按官方挂牌价折算）、ADR-0005（跨端契约由测试固定）、ADR-0007（模型表按渠道分行）

## 背景

定价表是**人工维护**的。当出现下列情况时，模型会落到「未定价」：

1. **新模型发布** —— 表里没有这一行
2. **同一模型换了 id** —— 渠道专有 id、区域后缀（`-sg`）、大小写差异（`DeepSeek-V4.1-Flash`）、命名空间前缀（`deepseek/DeepSeek-V4.1-Flash`）

今天的处理路径是：面板上看到一句「未定价：N 个模型」→ 自己去 `$DSH_HOME/usage-ledger-pricing.json` 里手改 → 等 30 秒热重载。

**痛点**：面板只告诉你「有多少个未定价」，不告诉你「是哪些」、也不告诉你「它们可能是谁」。调用次数、候选等价模型、自定义价格，全都要靠人肉判断。

## 目标

把「发现未定价」到「登记价格」的闭环搬进面板，且**不破坏插件现有的克制**（宁可不显示，也不猜）。

## 非目标（重要）

- **不做自动应用推荐**。`claude-opus-5-5`(4/20) 与 `claude-opus-5`(5/25) 名字极像但是两个模型、价差 25%。任何「一键采用推荐」都会静默用错价。推荐只能作为**待确认的建议**。
- **不修改主定价表** `usage-ledger-pricing.json`。它是仓库同步来的目录，手工修正必须落在独立文件里，否则下次同步就被覆盖。
- **不改 `resolvePricingFile()` 的默认路径**，不加「找不到就回退读包内」的分支（见 #10 的结论）。
- **不引入构建步骤**（ADR-0004），客户端仍是手写 `__ModuleLoader__` bundle + 运行时 `createElement`。
- **不依赖宿主 UI primitives**（图标名在宿主版本间漂移过，见 `src/client.js` 头注）。

## 设计

### 1. 数据：独立的 overrides 文件

新增 `$DSH_HOME/usage-ledger-overrides.json`，与主表分离：

```json
{
  "version": 1,
  "models": {
    "some-new-model-x": {
      "input": 1.5, "output": 6, "currency": "CNY",
      "note": "面板手工录入", "source": "manual"
    }
  },
  "aliases": {
    "workbuddy/deepseek-v4.2-sg": {
      "model": "deepseek-flash",
      "reason": "同型号新加坡区",
      "addedAt": "2026-10-02T21:40:00+08:00",
      "origin": "panel"
    }
  }
}
```

**合并顺序**：`内联 config < 主表 pricingFile < overrides`

理由：overrides 是用户最新的意图，优先级最高；主表可整份从仓库替换而不丢手工修正。

**兼容**：`aliases` 的值允许是**字符串**（旧格式）或**对象**（新格式）。解析时统一成对象，字符串视为 `{model: <str>}`。这样主表的 27 条别名不用改。

### 2. 宿主端：新增只读探测接口

现有路由只接受 `GET`/`HEAD`（`src/index.js:386`）。新增：

```
GET /api/usage-ledger/unpriced
→ {
    ok: true,
    items: [
      {
        id: "workbuddy/deepseek-v4.2-sg",
        provider: "workbuddy",
        model: "deepseek-v4.2-sg",
        tokens: 1234, requests: 12,
        suggestions: [
          { model: "deepseek-flash", score: 0.82, reason: "同前缀 + 同后缀族" }
        ]
      }
    ],
    candidates: [ {id, vendor, modelName, input, output, currency, context} ]
  }
```

`candidates` 供**搜索选择**用（前端本地过滤，无需再发请求）。

### 3. 候选与推荐：只用「可解释」的规则

推荐**只做归一化**，不做语义猜测：

- 去命名空间前缀后的尾部匹配（R1）
- 大小写折叠匹配（R2）
- 已知别名键的**反向**映射（R3）

⚠️ **勘误**：本文早期版本举的例子 `deepseek/DeepSeek-V4.1-Flash` → `deepseek-v4.1-flash` 是**错的**。实测 `deepseek-v4.1-flash` 在两张定价表里**都只是别名键、不是模型行**（`Object.hasOwn(models, "deepseek-v4.1-flash") === false`），所以它走 **R3 而非 R1**，正确答案是 `deepseek-flash`（该别名的目标）。照早期字面实现 R1 会得到**空建议**。规则表与断言以 `docs/specs/0008-unpriced-claiming-spec.md` 第 6 节为准。

**明确不做**：去日期后缀、去尾部数字。实测反例：`claude-opus-5-5` 会被并到 `claude-opus-5`（**实测价差 25%**：4/20 vs 5/25 USD）、`qwen3.8-max-0902` 与 `qwen3.8-max` 是两行。

每条推荐必须带 `reason`，前端原样展示。

### 4. 写入：POST 接口 + 校验

```
POST /api/usage-ledger/overrides
body: { op: "setModel" | "setAlias" | "remove", ... }
```

**服务端必须校验**（前端不可信）：

- 价格必须是有限正数或 0；`currency` 必须在 `rates` 里有汇率
- 别名目标**必须是合并后 models 的自有键**（`Object.hasOwn`）

  ⚠️ **勘误**：本文早期版本写「不能是另一个别名」。实测运行时表 27 条别名里 **23 条**的目标同时是别名键（`deepseek-flash`、`glm-5.3`、`kimi-k3` 等 9 个键既是模型行又是自映射别名键），按字面实现会让**最常用的目标全部不可写**。「不能写出死别名」的真意图已由「自有键」判据完整覆盖——实测两张表的死别名数都是 **0**。细则见规格 D6。

- 写入走**原子替换**（临时文件 + rename），避免半截文件
- 路径固定在 `$DSH_HOME`，不接受任意路径（防目录穿越）
- 拒绝原型污染键（`__proto__` / `constructor` / `prototype`）

  ⚠️ **现存缺陷（本方案顺带修复）**：`src/index.js` 的 `officialIdOf` 用 `in` 判存在，会走原型链。实测 `model = "constructor"` 或别名指向 `"constructor"` 时该行被算成 **`cost: 0`** 且**不进 `unpriced`** —— 面板显示 ¥0.00 而不是「—」，直接违反 ADR-0001「不拿 0 冒充免费」。须改为 `Object.hasOwn`。

### 5. 前端：面板内新增「未定价」区块

- 列出每个未定价 id + 调用次数（按次数降序，真在用的排前面）
- 每行两个动作：
  - **认领为已有模型** → 打开搜索框（本地过滤 `candidates`），选中后**必须**展示该模型的价格并要求确认
  - **自定义价格** → 输入 input/output/cacheRead/cacheWrite + 币种
- 确认后 POST，成功后提示「已写入 overrides，**立即生效**」并触发一次刷新

  ⚠️ **勘误**：本文早期版本此处写「30 秒内生效」。写入成功后实现会强制重读（`pricingStamp = 0`），面板紧跟的那次请求即读到新值，所以是**立即**生效；写「30 秒内」与行为不符。裁决记录见规格第 10 节第 2 条。

## 验收

1. `GET /unpriced` 返回的每个 id 都能在会话日志里找到对应记录；`suggestions` 的每条都带非空 `reason`
2. **推荐不会跨价格档乱建议**：对 `claude-opus-5-5` 不给出 `claude-opus-5` 的推荐（构造用例断言）
3. `POST` 写入的别名目标不存在时**返回 4xx 且不落盘**（不能写出死别名）
4. 写入后 `loadPricingFile` 的合并结果里该模型可定价；把 overrides 文件删掉后**回到未定价**（可回退）
5. 主表被整份替换后，overrides 里的手工修正**仍然生效**
6. `npm test` 全绿；`npm run mutate` 通过
7. 现有 27 条字符串格式别名**继续可用**（兼容性断言）

## 风险与对策

| 风险 | 对策 |
|---|---|
| 用户点错推荐导致静默错价 | 推荐必须展示理由 + 确认对话框里显示实际价格 |
| overrides 写坏导致面板挂掉 | 解析失败按空表处理（沿用 `loadPricingFile` 的容错口径）；原子写 |
| 与主表别名冲突 | overrides 优先；冲突时记 warn 日志 |
| 引入写入后插件不再「只读」 | README 的「设计取舍」需同步更新，明确写入范围仅限 `$DSH_HOME` 下的 overrides 文件 |

## 分阶段

- **阶段一（只读）**：`GET /unpriced` + 面板未定价清单 + 推荐展示。**不含写入**。可独立交付。
- **阶段二（可写）**：`POST /overrides` + 认领/自定义价格 UI + 兼容性处理。

阶段一已能消除「不知道是哪些模型」的痛点，且零写入风险。
