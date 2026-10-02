# 实现规格：未定价模型的面板内认领（ADR-0008）

- 状态：**已实现**（本文件是 ADR-0008 的实现契约；实现与测试见 `src/index.js`、`src/client.js` 与 `test/`）
- 日期：2026-10-02
- 相关：ADR-0001（按官方挂牌价折算）、ADR-0004（无第三方 UI 组件）、ADR-0005（跨端契约由测试固定）、ADR-0006（外观只用宿主 token）、ADR-0007（模型表按渠道分行）
- 上游：`docs/adr/0008-in-panel-model-claiming.md`（已接受）
- 范围：**只读**（本文件不改 `src/`）。所有「必须」都是给实现者的约束，每条都配一个可写断言。

## 0. 本文的写法

每节是一个决策 `D#`，结构固定为：

1. **决策** —— 实现者直接照做的那句话；
2. **依据** —— 代码/ADR/实测里的出处（可复现）；
3. **断言** —— 会失败的测试怎么写，编号 `A#`，并在第 9 节汇总。

无法从代码或 ADR 推出唯一答案的点，一律进第 10 节（该节已由用户授权「按推荐执行」**全部裁决完毕**），本文不替用户拍板。少数必须由规格给出具体数字的常量（规则权重、体积上限）进第 12 节，明确标注**非推导**。

## 1. 先读代码得到的既有事实（全部实测）

这些事实决定了下文所有决策的形状。命令在 `D:\agent\dsh\workspace\dsh-usage-ledger` 下执行。

| # | 事实 | 出处 / 复现 |
|---|---|---|
| F1 | 主路由 `BASE_PATH = "/api/usage-ledger"` 以 `kind: "exact"` 注册；handler 内先做方法闸门，`GET`/`HEAD` 之外一律 405 | `src/index.js:22`、`src/index.js:379-397`（闸门在 386 行） |
| F2 | 路由表按 `(kind, path)` 建键，重复注册**抛错**；匹配时先查 exact 表，再在 prefix 表里取最长前缀 | `@deepseek-ai/dsh-host-webserver/lib/index.js:177-184`、`:322-332`（从 `app.asar` 解出后读的） |
| F3 | 别名解析是**精确匹配 + 一跳**：`aliasOf = aliases[model] ?? model`，`officialIdOf` 用 `canonical in pricing` 判存在 | `src/index.js:151-155` |
| F4 | `costOf` 在「无价格行」与「币种不同且 `rates` 里没有有限数汇率」两种情况下都返回 `undefined`；条目币种等于目标币种时**根本不查 `rates`** | `src/index.js:101-118` |
| F5 | 「未定价」的集合 = `costOf(...) === undefined` 的 `provider/model`，在 `buildPayload` 里生成 | `src/index.js:173-195`（`unpriced.add` 在 183 行） |
| F6 | `loadPricingFile` 的容错口径：拿不到路径 / ENOENT → 空表且**不 warn**；损坏或结构不可用 → 空表 + **一次** warn；返回值恒为 `{models, aliases, rates}` 三键 | `src/index.js:287-308`、`test/pricing-file.test.js` |
| F7 | 合并现状：`pricing = {...inlinePricing, ...fromFile.models}`、`aliases = {...config.aliases, ...fromFile.aliases}`、`rates = {...config.rates, ...fromFile.rates}`；30 秒节流；`pricingFile === undefined` 时**整个 refresh 提前返回** | `src/index.js:331-349`（341-343 是三层展开，337 是节流，337 的早退条件是 `pricingFile === undefined`） |
| F8 | 客户端把接口前缀写成 `const API = "/api/usage-ledger"`，所有 `fetch` 的第一个实参必须引用 `API`（契约测试强制） | `src/client.js:32`、`test/contract.test.js:43-129` |
| F9 | 未定价提示 `UnpricedNotice` 已存在：`未定价：N 个模型，占 X% 的 token 量`，按 **tokens 降序**取前 6，行文 `· provider/model　tokens`，末尾一句「在 $DSH_HOME/usage-ledger-pricing.json 里按每百万 token 填价格即可…」 | `src/client.js:787-820`；占比口径被 `test/client.test.js:1070-1093` 钉住 |
| F10 | 面板 Esc 监听挂在面板容器上（不是 window），遮罩 `aria-hidden="true"` 且不是唯一出口 | `src/client.js:1041-1065`、`test/appearance.test.js` |
| F11 | 契约测试用「读 `src/client.js` 源码 + 正则」对比宿主端导出常量；浏览器端不能 import 宿主端 | `test/contract.test.js:1-41`、ADR-0005 |
| F12 | 客户端测试用 stub-loader 夹具（`loadClient`）取导出，且有可重放的 `useState` 桩 `statefulReact` 用来断言交互 | `test/client-harness.js:106-173`、`test/client.test.js:80-134` |
| F13 | 仓库底表 `usage-ledger-pricing.json`：76 个模型、20 条别名，**别名值全是字符串**；`rates = {USD:7.3, CNY:1}`；`claude-opus-5-5` = 4/20 USD，`claude-opus-5` = 5/25 USD | 直接读文件；见 §6 的实测输出 |
| F14 | 运行时表 `$DSH_HOME/usage-ledger-pricing.json`（本机）：147 个模型、**27 条**别名，值全是字符串；`qwen3.8-max` 与 `qwen3.8-max-0902` **并存**（同价 12/36/1.5/15 CNY），`qwen3.8-max-prime` 24/72 | 直接读文件；见 §6 |
| F15 | 两张表里「别名键同时是模型行」的键**全部自映射**（仓库 10/10、运行时 9/9）；**所有**别名值都是模型行（`aliasTargetsNotModels` 为空） | 见 §6 |
| F16 | `officialIdOf` 用 `in`（走原型链）：模型 id 恰好叫 `constructor`/`toString` 时会被判成「有价格行」，`costOf` 返回 **0** 而不是 `undefined` → 面板显示 ¥0.00 而不是「—」 | 实测见 §6 复现 4 |
| F17 | 别名目标若指向原型键（如 `constructor`），`pricing["constructor"]` 是函数 → `costOf` 返回 0，该行**被静默算成免费**，且 `unpriced` 集合为空 | 实测见 §6 复现 4 |
| F18 | `obj["__proto__"] = v` 这种**写**操作在普通对象上会被原型 setter 吞掉（键数仍为 0、原型被替换）；`Object.create(null)` 上不会 | 实测见 §6 复现 5 |

## 2. D1 新增路由与注册关系

**决策**：在 `apply()` 的 `attach(server)` 里**新增两条 `kind:"exact"` 路由**，不改造、不复用现有 `BASE_PATH` 那条：

| 常量（新增导出） | 值 | 方法 | 405 之外的响应 |
|---|---|---|---|
| `UNPRICED_PATH` | `` `${BASE_PATH}/unpriced` `` | `GET` / `HEAD` | 405 |
| `OVERRIDES_PATH` | `` `${BASE_PATH}/overrides` `` | 仅 `POST` | 405 |

- 两条都注册为 `kind:"exact"`，`path` 取上面的常量，**不带尾斜杠**。
- 每条用**独立的** `ctx.effect(...)` 包裹，标签分别是 `"usage-ledger: unpriced route"` 与 `"usage-ledger: overrides route"`。
- 现有 `BASE_PATH` 那条路由与它内部的 405 闸门（`src/index.js:386`）**一字不改**：它只覆盖 `/api/usage-ledger` 这一个 pathname，新增路径必须自己实现方法闸门。
- 三个 handler 的顺序都必须是：**先方法闸门，再 `screenRequest(req)`**。这正是现有路由的顺序（`src/index.js:386` 的闸门在前，`onRequest` 内部的 `screenRequest`（`src/index.js:361`）在后），新路由照抄。回环闸门对两条新路由**同样生效**。
- 响应统一走同一个 `send(status, value)` 助手：`{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}`。405 也走它（与现有 405 少一个 `cache-control` 的写法不同，这是有意的：新代码不留两套头）。

**依据**：F1 + F2。`register()` 的表键是 `(kind, path)`，所以「复用同一个 handler 注册两个路径」在宿主端**做不到**（要么 path 不同→就是两条路由，要么重复注册→抛错）。exact 匹配用的是 `new URL(req.url).pathname`，所以查询串不影响匹配，但 `/unpriced/`（带尾斜杠）**不会**命中 exact 表，会落到 SPA fallback —— 这正是「面板 404 却不报错」的同类静默失败，所以尾斜杠不进契约、也不做容错。

**断言**
- **A1**：用假 ctx（`inject` 同步回调、`effect` 立即执行并记标签）驱动 `apply(ctx, {...})`，断言 `registered.map(r => [r.kind, r.path])` 深等于 `[["exact","/api/usage-ledger"],["exact","/api/usage-ledger/unpriced"],["exact","/api/usage-ledger/overrides"]]`。
- **A2**：断言三个 `ctx.effect` 标签互不相同且恰好是上面三个字面量。
- **A3**：断言 `UNPRICED_PATH === `${BASE_PATH}/unpriced`` 且 `OVERRIDES_PATH === `${BASE_PATH}/overrides``（用导出常量算，不写死字符串）。
- **A4**：把三条 handler 都喂一遍 `{method:"DELETE", url:"/api/usage-ledger"}` 之类的请求，断言状态码 405、body 深等于 `{ok:false,error:"method-not-allowed"}`，且 `writeHead` 的第二个实参含 `cache-control: no-store`。
- **A5**：`GET` 与 `HEAD` 打到 `/unpriced` handler → 200；`GET`/`HEAD` 打到 `/overrides` handler → 405；`POST` 打到 `/unpriced` handler → 405。
- **A6**：三条 handler 在 `req.socket.remoteAddress = "192.168.1.9"` 时一律 403（新路由不得漏掉 `screenRequest`）。
- **A7**：契约测试新增一条：`src/client.js` 源码里存在字面量 `` `${API}/unpriced` `` 与 `` `${API}/overrides` ``（模板串形态），并复用既有 `fetchFirstArgs()` 断言每个 fetch 首参仍含 `API`（F8）。

## 3. D2 `GET /api/usage-ledger/unpriced` 响应 schema

**查询参数**：与主接口**同口径**——`range`（`today|week|month|all|custom`，缺省 `all`）、`from`、`to`，一律交给既有的 `resolveRange()`，不新增校验、不新增参数。

> 这是对 ADR-0008 §2 签名的**增补**：ADR 里的 URL 没有参数，但 items 带 `tokens`/`requests`，而面板的「未定价」区块必须与当前标签页的数字自洽（现有 `UnpricedNotice` 吃的就是按范围摊平后的 `modelDetailRows`）。范围口径复用既有函数，零新增语义。

**响应体**（`200`）：

| 字段 | 类型 | 可空 | 含义 / 取值约束 |
|---|---|---|---|
| `ok` | `boolean` | 否 | 恒 `true` |
| `generatedAt` | `number` | 否 | epoch ms，`now.getTime()`，与主载荷同义 |
| `currency` | `string` | 否 | 当前显示币种（`config.currency`，默认 `"CNY"`） |
| `range` | `{from: string\|null, to: string\|null, label: string}` | 否 | 直接来自 `resolveRange()` |
| `items` | `Item[]` | 否（空数组是合法值） | 未定价行，见下表 |
| `items[].id` | `string` | 否 | `` `${provider}/${model}` ``，与 `buildPayload().cost.unpriced` 的元素**逐字相同** |
| `items[].provider` | `string` | 否 | 渠道 |
| `items[].model` | `string` | 否 | 日志里的模型 id（**不是**官方 id，**不是**复合 id） |
| `items[].tokens` | `number` | 否 | 范围内该行消耗总量 |
| `items[].requests` | `number` | 否 | 范围内该行请求数 |
| `items[].inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` | `number` | 否 | 与 `aggregate()` 的桶字段同名同义 |
| `items[].cacheHitRate` | `number` | 否 | 同 `withRate()` |
| `items[].cause` | `"no-price" \| "no-rate"` | 否 | 见下 |
| `items[].suggestions` | `Suggestion[]` | 否（空数组是合法值） | 恒存在；顺序见 D5 |
| `items[].suggestions[].model` | `string` | 否 | **必须是合并后 models 的自有键** |
| `items[].suggestions[].score` | `number` | 否 | 只表达规则确定性，取值见 D5 常量表 |
| `items[].suggestions[].reason` | `string` | 否 | 非空，模板见 D5 |
| `candidates` | `Candidate[]` | 否 | 合并后 models 的**全部**行，按 `id` 升序 |
| `candidates[].id` | `string` | 否 | 模型表键 |
| `candidates[].input` / `output` | `number` | 否 | 每百万 token 单价 |
| `candidates[].cacheRead` / `cacheWrite` | `number \| null` | **是** | 表里没写 → `null`（运行时表 147 个模型里有 **11** 个没写 `cacheRead`、**28** 个没写 `cacheWrite`） |
| `candidates[].currency` | `string` | 否 | 条目币种（缺省时按 `costOf` 的口径理解为显示币种） |
| `candidates[].context` | `number \| null` | **是** | 表里缺失或不是有限数（表里有字面量 `"unknown"`）→ `null` |
| `candidates[].vendor` / `modelName` | `string \| null` | **是** | 表里缺失 → `null`（两张表当前都不缺，但 schema 不假设） |
| `candidates[].source` | `"inline" \| "file" \| "overrides"` | 否 | 该行**最终**来自哪一层（见 D4） |
| `overrides` | `object` | 否 | 见下表 |
| `overrides.path` | `string` | 否 | overrides 文件的**绝对路径**（面板必须显示它） |
| `overrides.exists` | `boolean` | 否 | 文件当前是否存在 |
| `overrides.version` | `number \| null` | **是** | 文件里的 `version`，缺失/不可用 → `null` |
| `overrides.enabled` | `boolean` | 否 | `config.overridesFile !== false` |

**`cause` 的判定（必须是这两支，且互斥）**：

```
officialId = officialIdOf(model)                      // 一跳别名 + 自有键判存在（见 D4 的 hasOwn 修正）
cause = "no-price"   当且仅当 officialId === undefined
cause = "no-rate"    当且仅当 officialId !== undefined 且 costOf(row, price, {currency, rates}) === undefined
```

**跨接口不变式（本规格最重要的一条）**：对同一批 `records`、同一组 `pricing/aliases/rates/currency`、同一个 `range`，

```
new Set(unpricedPayload.items.map(i => i.id))  ≡  new Set(buildPayload(records,{range,...}).cost.unpriced)
```

**依据**：F4 + F5。`cause` 的两支**穷尽**了 `costOf` 返回 `undefined` 的全部路径（F4），所以它不需要第三条取值；面板因此能说清「没有价格行」与「缺汇率」——后者靠「认领成已有模型」是修不好的，必须先去主表补 `rates`。

**纯函数与导出**：新增导出 `buildUnpricedPayload(records, options)`，`options` 与 `buildPayload` 同形再加 `overrides`，返回上表结构。handler 只做「扫日志 → 调它 → send」。理由：本仓库的断言全打在纯函数上（F6/F12 的做法），HTTP 层只留 A1–A6 那几条结构断言。

**断言**
- **A8**：`buildUnpricedPayload(records, {range, pricing, aliases, rates, currency, overrides})` 返回对象恰好含 `ok/generatedAt/currency/range/items/candidates/overrides` 七个键。
- **A9**：对随机/合成语料，逐条断言 §3 的不变式（两个 Set 相等）；再构造一个「有价格行但缺汇率」的行，断言它在 `items` 里 `cause === "no-rate"` 且仍在 `cost.unpriced` 里。
- **A10**：构造 `model = "constructor"` 的行，断言 `cause === "no-price"`、`items[].id` 出现在 `cost.unpriced` 里（杀掉 F16 的 `in` 行为；见 D4 的 hasOwn 修正）。
- **A11**：`candidates` 里每个 `id` 都满足 `Object.hasOwn(mergedModels, id)`；`cacheRead` 缺失的行断言为 `null`（不是 `0`）；`context === "unknown"` 的行断言为 `null`。
- **A12**：`items` 里每条 `suggestions` 都带非空 `reason`，且每个 `suggestions[].model` 都是合并后 models 的自有键（ADR-0008 验收 1）。
- **A13**：缺省（不带 `range`）时 `range.label === "累计"`，且与 `GET /api/usage-ledger` 缺省时的 `range` 逐字段相等。

## 4. D3 overrides 文件 schema 与向后兼容

**文件名与路径**：`$DSH_HOME/usage-ledger-overrides.json`。新增导出 `resolveOverridesFile(config)`，规则**逐条对齐** `resolvePricingFile`（`src/index.js:247-252`）：

| `config.overridesFile` | 结果 |
|---|---|
| 非空字符串 | 原样返回（不做绝对化；测试用的接缝） |
| `false` | `undefined`，且 `overrides.enabled === false`，POST 一律 403 `write-disabled` |
| 其它（空串 / `undefined` / `null` / 数字 / 对象 / 数组） | `join(home, "usage-ledger-overrides.json")`，`home` = 非空 `$DSH_HOME` 否则 `~/.dsh` |

**文件内容 schema**：

```json
{
  "version": 1,
  "models": {
    "<modelId>": {
      "input": 1.5,
      "output": 6,
      "cacheRead": 0.15,
      "cacheWrite": 1.5,
      "currency": "CNY",
      "note": "面板手工录入",
      "source": "manual"
    }
  },
  "aliases": {
    "<aliasId>": {
      "model": "<modelId>",
      "reason": "去掉命名空间前缀后与 deepseek-flash 同名",
      "addedAt": "2026-10-02T21:40:00+08:00",
      "origin": "panel"
    }
  }
}
```

| 字段 | 类型 | 可空 | 写入方 | 约束 |
|---|---|---|---|---|
| `version` | `integer` | 否 | 服务端 | 本插件写 `1`；见下面的版本策略 |
| `models` | `Record<string, Price>` | 否 | 服务端 | 键 = 模型 id |
| `models[*].input` / `output` | `number` | 否 | 客户端值 | 有限、`>= 0` |
| `models[*].cacheRead` / `cacheWrite` | `number` | **可缺** | 客户端值 | 缺省时**不写这个键**（不伪造 0，与主表的既有惯例一致：运行时表 147 个模型里 11 个没写 cacheRead、28 个没写 cacheWrite） |
| `models[*].currency` | `string` | **可缺** | 客户端值 | 缺省时不写；解析时按 `costOf` 口径等价于显示币种（F4） |
| `models[*].note` | `string` | **可缺** | 客户端值 | 长度 ≤ 200 |
| `models[*].source` | `"manual"` | 否 | **服务端强制** | 不接受客户端传入 |
| `aliases` | `Record<string, AliasEntry>` | 否 | 服务端 | 键 = 别名 id |
| `aliases[*].model` | `string` | 否 | 客户端值 | 必须是合并后 models 的自有键 |
| `aliases[*].reason` | `string` | **可缺** | 客户端值 | 非空字符串或省略；长度 ≤ 200 |
| `aliases[*].addedAt` | `string` | 否 | **服务端强制** | 匹配 `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/` |
| `aliases[*].origin` | `"panel"` | 否 | **服务端强制** | 不接受客户端传入 |

**不存在的键**：overrides **没有** `rates` 段。出现 `rates` 时按「不可用附属段」处理：忽略 + 一次 warn（与 `loadPricingFile` 对坏 `aliases`/`rates` 只降级该项、不影响 `models` 的口径同源，F6）。

**向后兼容 / 统一解析**（这是 ADR §1 那句「字符串或对象」的可执行形式）：

新增导出 `normalizeAliasMap(raw)`，返回**对象值**的规范化表 `Record<string, {model, reason?, addedAt?, origin?}>`，规则按顺序：

1. `raw` 不是非数组对象 → 返回 `{}`（不抛错，不 warn，与 `loadPricingFile` 对 `aliases` 的降级一致）；
2. 对每个键值：
   - 值是**字符串**且非空 → `{model: 值}`（**旧格式**，主表现有的 20 条（仓库）/ 27 条（运行时）全走这一支，F13/F14）；
   - 值是**对象**且 `typeof value.model === "string"` 且非空 → 原样收下（额外键忽略）；
   - 键在 `{"__proto__","constructor","prototype"}` 里，或键是空串 / 含控制字符（`/[\u0000-\u001f]/`）→ **丢弃该项**；
   - 其它（`null` / 数字 / 数组 / 缺 `model` 的对象 / 空串 `model`）→ **丢弃该项**；
3. 整表丢弃 ≥ 1 项时，`loadOverridesFile` 记**一次** warn（文案含文件路径与丢弃条数），不是每条一次。

**两层与三层的边界**：`loadPricingFile` 的返回形状与行为**一字不改**（F6 的既有测试是护栏，`test/pricing-file.test.js:274` 断言 `aliases` 原样返回）。规范化只在 `apply()` 的合并处发生：喂给 `buildPayload` 的 `aliases` 永远是**字符串值**的 `Record<string,string>`（因为 `aliasOf = aliases[model] ?? model` 要求字符串，F3），对象值那份只用于面板展示与推荐规则。

**版本策略**：

| 读到 | 读（合并） | 写（POST） |
|---|---|---|
| 无 `version` 键 | 当作 `1`，**不 warn**（手写文件是常态） | 允许，写回时补 `version: 1` |
| `version === 1` | 正常 | 允许 |
| 整数 `> 1` | 尽力合并 `models`/`aliases`，**一次** warn（`unsupported-version`） | **拒绝**，400 `unsupported-version`，**文件一字不动** |
| 非整数 / `< 1` / 非数字 | 当作 `1`，一次 warn | 允许，写回 `version: 1` |

**新增导出**：`loadOverridesFile(file, logger)` → `{version: number|null, models: object, aliases: object, exists: boolean}`。

**容错口径（逐条对齐 `loadPricingFile`）**：

| 情况 | 返回 | warn |
|---|---|---|
| `file` 不是非空字符串 | `{version:null, models:{}, aliases:{}, exists:false}` | **不 warn**（且**不得**去读任何路径，判据是「没 warn」） |
| ENOENT | 同上 | **不 warn**（没写过是常态） |
| 非法 JSON / 顶层不是对象 | 空表 | **一次** warn |
| `models` 不是对象 / 是数组 | 该段降级为 `{}` | 不 warn |
| `aliases` 不是对象 | 该段降级为 `{}` | 不 warn |
| `aliases` 里有被丢弃的项 | 其余项保留 | **一次** warn |
| 键在原型保留名里 | 丢弃该项 | 并入上面那次 warn |

**依据**：F6（容错口径）、F7（合并点）、F13/F14（主表别名是字符串）、ADR-0008 §1。

**断言**
- **A14**：`resolveOverridesFile` 对 `""`/`undefined`/`null`/`0`/`{}`/`[]` 都返回 `join($DSH_HOME,"usage-ledger-overrides.json")`；`false` → `undefined`；非空字符串原样；`$DSH_HOME` 缺失/空串 → `join(homedir(),".dsh",...)`。用 `withEnv` 包住并连「键是否存在」一起还原（照抄 `test/pricing-file.test.js:118-129` 的写法）。
- **A15**：`loadOverridesFile(undefined, logger)` 与 ENOENT 都返回 §4 的空形状且 `warned` 为空数组；喂一个「碰一下就抛」的 Proxy 路径，同样 `warned` 为空（证明没去读任何路径）。
- **A16**：非法 JSON → 空形状 + 恰好一次 warn；`models`/`aliases` 段类型不对 → 只降级该段、`models` 保留。
- **A17**：`normalizeAliasMap({a:"m1", b:{model:"m2", reason:"r"}, c:null, d:{}, e:"", f:42})` 深等于 `{a:{model:"m1"}, b:{model:"m2",reason:"r"}}`；含 `__proto__` 键时该键被丢弃且结果对象的 `Object.keys()` 里没有它、原型仍是 `Object.prototype`。
- **A18**：主表别名兼容：对**仓库表 20 条**与**运行时表 27 条**（两者值全是字符串，F13/F14）分别跑 `normalizeAliasMap`，断言每条都能解析出非空 `model`，且 `Object.keys()` 数量不变、值类型全部变成对象（ADR-0008 验收 7 的兼容性断言）。
- **A19**：`loadPricingFile` 的行为不变——`test/pricing-file.test.js` 全文不改、全绿（这是「规范化没有偷偷塞进旧函数」的判据）。
- **A20**：写一个 `{"version":2,"models":{"x":{"input":1}}}` 的文件，断言 `loadOverridesFile` 的 `version === 2` 且合并仍生效；再 POST 一次，断言 400 `unsupported-version` 且**文件字节与写前完全相同**。

## 5. D4 合并顺序与冲突日志

**决策**：合并顺序（后者赢，逐层覆盖）：

```
models:  config.pricing（内联）  <  usage-ledger-pricing.json  <  usage-ledger-overrides.json
aliases: config.aliases          <  usage-ledger-pricing.json  <  usage-ledger-overrides.json（规范化后）
rates:   config.rates            <  usage-ledger-pricing.json   （overrides 无 rates 段）
```

**新增导出** `mergePricing({inline, file, overrides})` → `{models, aliases, rates, sources, warnings}`：

- `models`：三层展开后的合并表；
- `aliases`：**字符串值**的 `Record<string,string>`（`normalizeAliasMap` 之后取 `.model`）；
- `rates`：两层展开；
- `sources`：`Record<modelId, "inline"|"file"|"overrides">`，同名冲突时记**最终赢的那一层**（D2 的 `candidates[].source` 用它）；
- `warnings`：数组，元素 `{code:"model-shadow"|"alias-shadow", key, layer:"file"|"overrides"}`。

**冲突日志**（`apply()` 里逐条打 `logger.warn`，每个键每次加载**最多一条**）：

| 冲突 | 谁赢 | 日志 |
|---|---|---|
| overrides 的 model 键同时出现在主表（或内联） | overrides | `usage-ledger: overrides file %s overrides model "%s"`，`warn` |
| overrides 的 alias 键同时出现在主表（或内联） | overrides | `usage-ledger: overrides file %s overrides alias "%s"`，`warn` |
| 主表的 model 键同时出现在内联 config | 主表 | **不记日志**（这是既有行为，`src/index.js:340-341` 的注释已写明「文件里的条目覆盖内联配置」） |
| overrides 里出现 `rates` 段 | 忽略 | `warn` 一次（见 D3） |

**依据**：ADR-0008 §1「overrides 是用户最新的意图，优先级最高」+ 风险表「与主表别名冲突 → overrides 优先；冲突时记 warn 日志」；`src/index.js:341-343` 是现有两层展开的位置。

**两个必须同时修掉的陷阱**：

1. **`refreshPricing` 的早退条件**（F7 末句）：现有代码 `if (pricingFile === undefined || now - pricingStamp < 30_000) return;` 会在 `pricingFile: false` 时**连 overrides 一起不读**。改成「`pricingFile === undefined && overridesFile === undefined` 才早退」，两个文件共用同一个 30 秒节流戳（同一趟读盘）。
2. **`officialIdOf` 用 `in`**（F3/F16/F17）：必须改成自有键判据 `Object.hasOwn(pricing, canonical)`。否则：
   - 模型 id 恰好叫 `constructor`/`valueOf`/`toString` 的行会拿到一个**函数**当价格 → `costOf` 返回 `0` → 面板显示 ¥0.00 而 `unpriced` 为空；
   - 别名目标写成 `constructor` 时同样被静默算成免费（实测 `officialModel === "constructor"`、`cost === 0`、`unpriced === []`）。
   这与 ADR-0001「不拿 0 冒充免费」直接冲突，所以它是本规格的**硬要求**，不是可选项。

**写后可见性**：POST 成功后把 `pricingStamp = 0`（强制下一趟读盘）。ADR §5 的文案「30 秒内生效」是**上界**而不是目标：面板在 POST 成功后立刻 `reload()`，如果这里不强制重读，用户会看到刚写进去的模型**仍然显示未定价**——正是本仓库最忌讳的静默失败。

**依据**：`src/index.js:335-344`（节流与早退）、ADR-0008 §5「确认后 POST，成功后…并触发一次刷新」。

**断言**
- **A21**：`mergePricing` 三层冲突用例：`{inline:{m:{input:1}}, file:{m:{input:2}}, overrides:{m:{input:3}}}` → `models.m.input === 3`，`sources.m === "overrides"`。
- **A22**：`aliases` 冲突：内联 `{a:"m1"}`、主表 `{a:"m2", b:"m3"}`、overrides `{b:{model:"m4"}}` → `aliases.a === "m2"`、`aliases.b === "m4"`，且 `warnings` 恰好含一条 `{code:"alias-shadow", key:"b", layer:"overrides"}`。
- **A23**：`rates` 只来自内联与主表；overrides 里塞 `rates` 不影响 `mergePricing().rates`，且 `warnings` 含一条 `rates-ignored`。
- **A24**：`mergePricing` 对 model 冲突产出 `{code:"model-shadow", key:"m", layer:"overrides"}`；内联与主表冲突**不产出** warning。
- **A25**：`Object.hasOwn` 修正：`pricing = {}`、别名 `{"relay":"constructor"}` 时，`buildPayload` 的结果 `officialModel === null`、`cost === null`、`cost.unpriced` 含 `"relay/relay"`（现值是 `"constructor"`/`0`/`[]`，这条断言会先红后绿）。
- **A26**：`{pricingFile: false, overridesFile: tmp}` 下，手写一个 overrides 文件（给 `deepseek-flash` 定价），断言合并后该模型可定价；删掉文件后同一断言回到未定价（ADR-0008 验收 4）。
- **A27**：`{pricingFile: false}` 且**没有** overrides 文件时，`refreshPricing` 的行为与今天一致（不抛错、不 warn）。
- **A28**：用假 ctx + 假 res 驱动「先 POST 写模型 → 紧接着 GET /unpriced」，断言第二次响应里该模型已不在 `items` 中（写后可见性；这条同时守住 `pricingStamp = 0`）。

## 6. D5 推荐规则的精确边界

### 6.1 允许清单（穷尽，只有这三条）

新增导出 `suggestModels(modelId, {models, aliases})` → `Suggestion[]`。

归一化只做两步，**顺序固定**：`fold(s) = s.toLowerCase()`；`tail(s) = s.slice(s.lastIndexOf("/") + 1)`（没有 `/` 时等于原串）。

| 规则 | 触发条件（`X` = 待定价的 `items[].model`） | 建议 | `score` | `reason` 模板 |
|---|---|---|---|---|
| R1 尾部匹配 | `fold(tail(X))` 等于某个模型键的 `fold`（且 `X` 本身不是模型键） | 那个模型 | `0.9` | `去掉命名空间前缀后与 <modelId> 同名` |
| R2 大小写折叠 | `fold(X)` 等于某个模型键的 `fold`（且 `X !== modelId`） | 那个模型 | `1` | `仅大小写不同（<modelId>）` |
| R3 已知别名的反向映射 | `fold(tail(X))` 或 `fold(X)` 等于某个**别名键**的 `fold`，取该别名的目标 `T`，且 `Object.hasOwn(models, T)` | `T` | `0.8` | `已有别名 <aliasKey> → <target>` |

- 同一**目标模型**被多条规则命中时**合并成一条，取最高分那条的 `reason`**（分高者优先：R2 `1` > R1 `0.9` > R3 `0.8`）。不同目标各占一条，各自保留自己的分数。
- **自指建议必须过滤**：`suggestion.model === X`（建议指向待定价模型自己）时丢弃。这不是理论情形——实测仓库表的 `cline-free/muse-spark-1.3-contributor` 既是模型行、又有一个同名别名指向它自己，R3 会原样建议回它自己，而「认领成自己」什么也修不了。
- **折叠撞键时的确定性消歧（必须有，不是可选）**：`fold` 是多对一，实测运行时表的别名键里就有 **2 组**折叠撞键（`deepseek-v4.1-flash` / `DeepSeek-V4.1-Flash`、`deepseek-v4-flash` / `DeepSeek-V4-Flash`）。撞键时按以下顺序取**唯一**一个键：① 与 `tail(X)`（或 `X`）**逐字符相等**的那个键；② 否则取这些候选键里 `localeCompare` 最小的。模型键侧同理（实测两张表当前都没有模型折叠撞键，但规则不能依赖这个巧合）。
- 排序：`score` 降序，再按 `model` 的 `localeCompare` 升序；**最多 3 条**。
- **`reason` 里的 `<aliasKey>` 是折叠前那个真实键名**（大小写原样），因为面板要把它原样展示给用户。

> **给实现者的一个真实陷阱**：ADR-0008 §3 自己的例子 `deepseek/DeepSeek-V4.1-Flash → deepseek-v4.1-flash` 走的是 **R3 而不是 R1**——`deepseek-v4.1-flash` 在两张表里**都是别名键、都不是模型行**（实测 `Object.hasOwn(models,"deepseek-v4.1-flash") === false`）。照 ADR 的字面写 R1 会得到空建议，正确答案是 `deepseek-flash`（`deepseek-v4.1-flash` 这个别名的目标）。
- 大小写折叠只用于**匹配**：别名键与模型键本身仍**区分大小写**（主表里 `deepseek-v4.1-flash` 与 `DeepSeek-V4.1-Flash` 是两个键，实测如此）。
- 命名空间前缀只剥到**最后一个** `/`：`cline-free/muse-spark-1.3-contributor` 这类**本身带 `/` 的模型键**必须先被 R2/`Object.hasOwn` 直接命中，不得被 tail 规则拆成 `muse-spark-1.3-contributor`（实测：这个 tail 在两张表里都不是模型键）。

### 6.2 禁止清单（每条附实测反例）

| 禁止 | 为什么 | 实测反例（断言依据） |
|---|---|---|
| **去日期后缀**（`-0902`、`-20260402`、`-0309` 之类） | 同名不同版本是两行，价差可能很大 | `qwen3.8-max-0902` 与 `qwen3.8-max` 在运行时表里**并存**（各自 12/36/1.5/15 CNY，ctx 1000000）；任何「剥尾部数字」的实现都会把它们并成一行。ADR-0008 §3 点名的就是这个 |
| **去尾部数字 / 剥最后一段 `-N`** | 同上，且与日期后缀是同一个错 | `claude-opus-5-5`（4/20 USD）与 `claude-opus-5`（5/25 USD）：输入与输出**都贵 25%**。`claude-opus-5-5` 一旦被并到 `claude-opus-5`，官方价折算会**静默高估 25%** |
| 编辑距离 / token 重叠 / 任何相似度打分 | 「看起来像」不是「是同一个模型」，且分数不可解释 | `qwen3.8-max-prime`（24/72）与 `qwen3.8-max`（12/36）只差一个词，价差 100% |
| 跨厂商/跨渠道推断（同 cwd、同项目、同时间窗） | ADR-0008 非目标：不做语义猜测 | 现有 `buildPayload` 只吃 `record.provider`/`record.model` 两个字段，没有任何可以支撑推断的输入 |
| 建议里出现非模型键 | 会造成「死别名」，面板点一下就写出一个永远算不出钱的目标 | 见 D6 的硬校验；`suggestModels` 的每个返回值都必须过 `Object.hasOwn(models, s.model)` |
| 网络请求 / 新第三方依赖 | README 的「零网络、零凭据、零外部依赖」是承诺 | `package.json` 没有 `dependencies` 段；客户端 `require` 桩只认 `"react"`（`test/client-harness.js:78-83`） |

### 6.3 实测依据（可复现）

在仓库根目录执行（`node -e` 脚本，输出摘要如下）：

1. **opus 价差**
   `claude-opus-5-5: input=4 output=20 cacheRead=0.2 cacheWrite=5 USD` / `claude-opus-5: input=5 output=25 cacheRead=0.5 cacheWrite=6.25 USD`
   → `5/4 = 1.25`、`25/20 = 1.25`：**25%**。
2. **qwen 两行并存**（运行时表）
   `qwen models: qwen3.8-max | qwen3.8-max-0902 | qwen3.8-max-prime | …`
   `qwen3.8-max = 12/36/1.5/15 CNY`、`qwen3.8-max-0902 = 12/36/1.5/15 CNY`、`qwen3.8-max-prime = 24/72 CNY`。
   注：max 与 max-0902 **当前同价**（所以合并在今天不会算错钱），但它们是**两行**，合并会掩盖将来的分化；prime 则证明同族价差可达 100%。规格因此禁止「按后缀合并」，而不是「按价格相等合并」。
3. **后缀对的穷举**：对两张表做「`^(.+)-(\d{2,8})$` 且基名也在表里」的扫描，仓库表 0 对、运行时表**恰好 1 对**（就是 `qwen3.8-max-0902` / `qwen3.8-max`）。所以这条禁止不是假设，而是唯一的现网反例。
4. **原型链陷阱**（`in` vs `hasOwn`）
   `buildPayload([{model:"constructor",inputTokens:1000,…}], {pricing:{}, …})` →
   `cost = 0`、`officialModel = "constructor"`、`cost.unpriced = []`；
   别名 `{"relay-hostile":"constructor"}` → `officialModel = "constructor"`、`cost = 0`、`unpriced = []`。
   而 `Object.hasOwn({}, "constructor") === false`。
5. **`__proto__` 写入**
   `const o = {models:{}}; o.models["__proto__"] = {input:1};` → `Object.keys(o.models).length === 0` 且 `Object.getPrototypeOf(o.models) !== Object.prototype`（写入被原型 setter 吞掉）。
   `Object.create(null)` 上同样写法得到 1 个键。

**断言**
- **A29**：`suggestModels("claude-opus-5-5", {models: repoModels, aliases: {}})` 的结果里**不含** `claude-opus-5`（ADR-0008 验收 2）；反向也断言 `suggestModels("claude-opus-5", …)` 不含 `claude-opus-5-5`。
- **A30**：`suggestModels("qwen3.8-max-0902", {models: runtimeLikeModels})` 不含 `qwen3.8-max`；`suggestModels("qwen3.8-max", …)` 不含 `qwen3.8-max-0902`；`suggestModels("qwen3.8-max-prime", …)` 不含 `qwen3.8-max`。
- **A31**：`suggestModels("deepseek/DeepSeek-V4.1-Flash", {models: repoModels, aliases: repoAliases})` 给出 **`deepseek-flash`**，`score === 0.8`，`reason` 逐字等于 `已有别名 deepseek-v4.1-flash → deepseek-flash`（**R3**；`deepseek-v4.1-flash` 不是模型行，所以 R1 不成立——这正是 ADR 例子与规则表必须对齐的地方）。反向对照：`suggestModels("deepseek-v4.1-flash-sg", {models: repoModels, aliases: repoAliases})` 给出**空数组**（这个 id 在仓库表里既不是模型行也不是别名键，不得凭「前缀像」猜一个）。
- **A32**：`suggestModels("Doubao-Seed-2.1-Pro", {models: runtimeLikeModels, aliases: runtimeLikeAliases})` 给出 `doubao-seed-2.1-pro`，`score === 1`，`reason` 逐字等于 `仅大小写不同（doubao-seed-2.1-pro）`（**R2**）。再断言 R2 与 R3 同时命中时**只留一条**、且它的 `reason` 是 R2 那条（R2 分更高）。
- **A32b（折叠撞键的确定性）**：构造别名表 `{"DeepSeek-V4.1-Flash":"deepseek-flash", "deepseek-v4.1-flash":"deepseek-flash"}`，断言 `suggestModels("relayX/deepseek-v4.1-flash", …)` 的 `reason` 里的别名键是**逐字符相等**的 `deepseek-v4.1-flash`（不是 `DeepSeek-V4.1-Flash`）；再删掉那个键、只留 `DeepSeek-V4.1-Flash`，断言结果稳定（同一入参调两次深等），且别名键是 `DeepSeek-V4.1-Flash`。
- **A33**：`suggestModels("relayX/deepseek-v4.1-flash", {aliases: runtimeAliases, models: runtimeModels})` 给出 `deepseek-flash`（R3；这是「新命名空间前缀」这个真实痛点的正解）。`suggestModels("DeepSeek-V4-Flash", {aliases: repoAliases, models: repoModels})` 给出 `deepseek-v4-flash`（R2 与 R1 同分指向同一目标，只出现一次）。
- **A34**：所有返回值都满足 `Object.hasOwn(models, s.model)`；返回值长度 ≤ 3；`score` 只能取 `0.8/0.9/1` 三个值之一；同一模型不重复出现。
- **A35**：`suggestModels("cline-free/muse-spark-1.3-contributor", {models: repoModels, aliases: repoAliases})` 返回**空数组**：R2 指向它自己 → 被自指过滤丢弃；R1 的 tail `muse-spark-1.3-contributor` 不是模型键；R3 的目标也是它自己 → 同样被丢弃。断言「认领成自己」这种无操作建议不会出现在面板上。
- **A36**：`suggestModels` 是纯函数：同一入参调两次结果深等，且不修改入参对象（用 `JSON.stringify` 前后比对）。
- **A37**：`package.json` 里 `dependencies` 段保持不存在（不引入第三方依赖）。

## 7. D6 `POST /api/usage-ledger/overrides` 契约与校验清单

### 7.1 请求

```
POST /api/usage-ledger/overrides
content-type: application/json
body: {"op":"setModel"|"setAlias"|"remove", …}
```

| `op` | 必填 | 可选 |
|---|---|---|
| `setModel` | `model: string`、`input: number`、`output: number` | `cacheRead`、`cacheWrite`、`currency`、`note` |
| `setAlias` | `alias: string`、`model: string` | `reason` |
| `remove` | `target: "model"\|"alias"`、`id: string` | — |

**body 是严格 schema**：出现任何未列出的键 → 400 `unknown-field`。这条同时是**防目录穿越**的实现方式——请求体里根本没有路径字段可传（`path`/`file`/`overridesFile` 都属于未列出键）。

body 通过 `for await (const chunk of req)` 读取（真实 `IncomingMessage` 与测试用的假异步可迭代对象都能喂），累计超过 **65536 字节**立即 400 `body-too-large`。

**`content-type` 必须以 `application/json` 开头**（在 `readBody` 之前闸门），否则 400 `unsupported-media-type`。这不是格式洁癖，是本接口唯一挡得住「本机浏览器里的任意网页」的判据：宿主 webserver 的 `handle()` 直接 `await route.handler(req, res)`，**没有鉴权层**；而 `screenRequest` 只查 peer 地址——来自本机网页的请求 peer 同样是 `127.0.0.1`，闸门照常放行。但 `application/json` 属于 CORS 的**非简单** content-type，跨站请求会先发 `OPTIONS` 预检，而本插件不返回任何 CORS 头 → 预检必败 → 真正的 POST 发不出去。`text/plain` 是简单类型、不会被预检拦住，所以必须**明确拒绝**它。

### 7.2 响应

| 情况 | 状态 | body |
|---|---|---|
| 成功 | 200 | `{"ok":true,"op":<op>,"path":<overrides 绝对路径>,"version":1}` |
| 校验失败 | 400 | `{"ok":false,"error":"bad-request","detail":<稳定码>}` |
| 版本比插件新 | 400 | `{"ok":false,"error":"bad-request","detail":"unsupported-version"}` |
| 回环闸门拒绝 | 403 | `{"ok":false,"error":"forbidden"}` |
| 配置关闭写入（`overridesFile:false`） | 403 | `{"ok":false,"error":"write-disabled"}` |
| 方法不是 POST | 405 | `{"ok":false,"error":"method-not-allowed"}` |
| 落盘失败 | 500 | `{"ok":false,"error":"internal"}`，且**文件保持原样** |

`detail` 是**稳定的英文码**（不是给人看的文案）；面板负责把它翻成中文（映射表见 D7）。

### 7.3 服务端校验清单（前端不可信；按顺序短路）

| # | 规则 | 失败 → `detail` |
|---|---|---|
| V1 | 方法必须是 `POST` | 405 `method-not-allowed` |
| V2 | `screenRequest(req)` 必须放行 | 403 `forbidden` |
| V3 | `config.overridesFile !== false` | 403 `write-disabled` |
| V4 | body ≤ 65536 字节 | 400 `body-too-large` |
| V5 | body 能被 `JSON.parse` 成**非数组对象**（`null`、数组、标量都拒） | 400 `invalid-body` |
| V6 | 顶层键 ⊆ `{op, model, input, output, cacheRead, cacheWrite, currency, note, alias, reason, target, id}` | 400 `unknown-field` |
| V7 | `op` ∈ `{setModel, setAlias, remove}` | 400 `unknown-op` |
| V8 | 该 `op` 的键集合必须落在 §7.1 的必填+可选里（`setModel` 不许出现 `alias`，反之亦然） | 400 `unknown-field` |
| V9 | **id 合法性**（`model`/`alias`/`id` 共用）：`string`、非空、长度 ≤ 200、不含 `/[\u0000-\u001f]/`、**不是** `__proto__`/`constructor`/`prototype` | 400 `invalid-id` |
| V10 | `input`、`output`：`typeof === "number"` 且 `Number.isFinite` 且 `>= 0`（**不做字符串强转**，`"1.5"` 拒绝） | 400 `invalid-price` |
| V11 | `cacheRead`、`cacheWrite`：**可缺**；给了就必须满足 V10 | 400 `invalid-price` |
| V12 | `currency`：可缺（缺省 = 显示币种，与 `costOf` 的 `price.currency ?? currency` 同义）；给了必须是非空字符串 | 400 `invalid-currency` |
| V13 | 币种可用性：`currency === 显示币种` **或** `Number.isFinite(rates[currency])`（用自有键判据） | 400 `unknown-currency` |
| V14 | `note` / `reason`：可缺；给了必须是 `string` 且长度 ≤ 200（`reason` 为空串视为缺省） | 400 `invalid-note` / `invalid-reason` |
| V15 | `setAlias.model` 必须是**合并后 models 的自有键**（`Object.hasOwn`） | 400 `unknown-model` |
| V16 | `remove.target` ∈ `{model, alias}` | 400 `unknown-target` |
| V17 | 目标文件 `version` 不 > 1（见 D3 版本策略） | 400 `unsupported-version` |
| V18 | 目标文件**存在但读不出内容**（解析失败，或 `EPERM`/`EACCES` 等读取失败） | 409 `overrides-unreadable`（文件字节不变） |
| V19 | 落盘失败（目标不是普通文件等） | 500 `internal`（文件不变） |

**V18 的三态边界**（第二轮评审补充；判据实现在 `probeOverridesFile` + `classifyOverridesReadError`）：

| 情况 | 判定 | 理由 |
|---|---|---|
| `ENOENT`（没写过） | `absent` → 正常写 | 基于空表写是正确行为 |
| `EISDIR` / `ENOTDIR`（目标不是普通文件） | `ok` → 交给写入路径报 500 | 写入本身必然失败；判成 `unreadable` 会把「原子写失败」误报成「文件内容坏了」 |
| `EPERM` / `EACCES` 等**读取失败** | `unreadable` → **拒绝写** | `rename` 只替换目录项、**不需要读目标文件**，所以写入会**成功**并覆盖掉读不到的内容（实测：`icacls <file> /deny <user>:(R)` 下 `readFile` 抛 EPERM、`rename` 成功） |
| 读得到但 JSON 非法 / 顶层不是对象 | `unreadable` → **拒绝写** | 有内容会被静默丢弃 |

**V15 的精确边界（与 ADR-0008 §4 的字面表述有冲突，见第 11 节）**：硬规则**只有** `Object.hasOwn(mergedModels, model)` 一条。**不**加「目标不能是另一个别名」这条字面规则，因为：

- 解析是精确匹配 + 一跳（F3）：写完 `A → T` 后，插件只看 `pricing[T]` 这个**自有键**。只要 `T` 是模型行，一跳就能定价，无论 `T` 是否也是别名键；
- 而「`T` 是别名键」在现网**极其常见**：运行时表 27 条别名里有 **23** 条的目标同时是别名键；`deepseek-flash`、`glm-5.3`、`kimi-k3` 等 **9** 个键既是模型行又是（自映射）别名键。按字面规则，这些最常用的目标会被全部拒绝——功能基本不可用；
- 「不能写出死别名」这个**真意图**由 V15 的自有键判据完整覆盖：目标不在 models 里（包括「只是别名、没有价格行」）一律 400。实测两张表的 `aliasTargetsNotModels` 都为空，说明现网本来就在守这条不变式。

**一跳的可见性**：若 `T` 同时是别名键且其值 `V !== T`，写入**允许**，但 GET 的 `candidates[].source` 与确认对话框必须显示一行提示（D7）：插件只做一跳，本别名将直接使用 `<T>` 自己的价格行，不会跟随到 `V`。

**`remove` 的语义**：只删 overrides 里的键。`id` 不存在时仍然 200（幂等），响应 `{"ok":true,"op":"remove",…}`；**绝不**触碰主表（主表是仓库同步来的目录，ADR-0008 非目标）。

**写入实现（原子 + 串行）**：

1. 读当前文件（走 `loadOverridesFile` 的同一条解析路径）→ 得到 `next`（`models`/`aliases` 应用本 op，`version` 恒 `1`）；
2. 序列化 `JSON.stringify(next, null, 2) + "\n"`，键顺序固定 `version, models, aliases`；
3. 写同目录临时文件 `usage-ledger-overrides.json.<pid>.<seq>.tmp`（**同一目录**，保证 `rename` 同盘原子），然后 `rename` 覆盖目标；
4. 任何一步失败：`unlink` 临时文件（忽略 ENOENT），目标文件**保持原样**，返回 500；
5. 同一路径的写入用**模块级 promise 链**串行化（后一个 op 必须读到前一个的结果），避免并发 POST 丢更新；
6. 成功后 `pricingStamp = 0`（D4 的写后可见性）。

**依据**：ADR-0008 §4 的四条校验 + 风险表；F4（币种判据）；F3/F15（一跳与别名键重叠）；F17（原型链）；F18（`__proto__` 写入被吞）。

**断言**
- **A38**：`validateOverride` 是纯函数，V5–V17 每条各一个用例（合法通过 + 恰好一个非法字段 → 返回对应的 `detail`）。`"1.5"`（字符串价格）必须 400 `invalid-price`。
- **A39**：`currency: "USD"`（`rates.USD = 7.3`）通过；`currency: "JPY"`（不在 `rates` 里）→ 400 `unknown-currency`；`currency` 省略且显示币种是 `CNY` → 通过（这条覆盖「显示币种不查 `rates`」的 `costOf` 口径）。
- **A40**：`setAlias` 目标 `"deepseek-flash"`（既是模型行又是自映射别名键）→ **通过**；目标 `"constructor"` → 400 `invalid-id`；目标 `"no-such-model"` → 400 `unknown-model`；目标 `"muse-spark-1.3-contributor"`（只是别名键、不是模型键）→ 400 `unknown-model`。
- **A41**：`setModel` 带 `cacheRead` 省略时，落盘 JSON 里该键**不存在**（不是 0）；带 `source:"official"` 或 `origin:"x"` 时 400 `unknown-field`（服务端字段不可伪造）。
- **A42**：`remove` 一个不存在的 `id` → 200；且文件内容与写前逐字节相同（幂等且不空写）。
- **A43**：真实临时目录下并发发起 8 个 `setModel`（不同 model），全部 200 后断言：文件是合法 JSON、8 个键**全部存在**（串行化）、目录里**没有** `.tmp` 残留、文件文本以 `\n` 结尾且以 `{\n  "version": 1,` 开头。
- **A44**：把 overrides 路径设成一个**目录**（`rename` 会失败），断言响应 500、目录未被破坏、且原 overrides 文件（若存在）内容不变。
- **A45**：`overridesFile: false` 时 POST → 403 `write-disabled`，且**没有**任何文件被创建（用临时目录断言目录仍为空）。
- **A46**：非回环 peer → 403 `forbidden`，且没有文件被创建。
- **A47**：写一个 `version: 2` 的文件后 POST → 400 `unsupported-version`，文件字节不变（与 A20 同源，这里从 HTTP 层再断言一次）。
- **A48**：`setAlias` 成功后 GET `/unpriced`（同一次进程内、紧跟着），该 id 不再出现在 `items` 里；再手工删掉 overrides 文件并等过一次节流窗口，它**回到** `items`（ADR-0008 验收 4 的 HTTP 版）。
- **A49**：主表被整份替换（换一份没有该模型的文件）后，overrides 里的手工修正**仍然生效**（ADR-0008 验收 5）。
- **A50**：`GET /unpriced` 的 `overrides.path` 等于 `resolveOverridesFile(config)`，且确认对话框文本里出现这个绝对路径（写入范围可见，对应 ADR-0008 风险表那一行）。

## 8. D7 前端「未定价」区块：状态机与表单

### 8.1 挂载点与既有行为

- 新增组件 `UnpricedSection`，从 `src/client.js` **导出**（`exports.UnpricedSection = UnpricedSection`），以便用 `loadClient` + `statefulReact` 直接断言状态机（F12）。
- 渲染位置：`Panel` 里替换现有 `UnpricedNotice` 的**排序明细**部分（`src/client.js:800-819` 的 `ranked` 那段），`UnpricedNotice` 自身保留并**一字不改**它已被钉住的两句：`未定价：N 个模型，占 X% 的 token 量` 与 `share >= 20` 的后缀（`test/client.test.js:1070-1093` 依赖它们）。**明细段与「在 $DSH_HOME/usage-ledger-pricing.json 里按每百万 token 填价格即可」那句指引一并删除**——两块都画会在同一帧里出现两遍同样的行与**两条互斥的指引**（一句让人去手改 JSON、一句提供面板内认领），用户不知道该听谁的。`test/client.test.js` 有一条用例钉住「那句指引不再出现」与「同一行 id 在整棵树里只出现一次」。
- 排序：**按 `tokens` 降序**（沿用现有 `UnpricedNotice` 的口径；ADR-0008 §5 写的是「按调用次数降序」——见第 10 节，这条按现状冻结为 tokens，避免顺手改掉一个已被断言的既有行为）。
- `items.length === 0` 时整个区块**不渲染**（`null`）——**唯一例外**：`feedback !== null` 时仍渲染一个只含反馈的窄块。认领掉**最后一个**未定价模型是最常见的路径，而那一刻正是「已写入 overrides：<路径>」最该被看见的时候；直接 `return null` 会让反馈随组件卸载一起消失，用户点了确认却什么都没看到，很可能再点一次。
- `overrides.enabled === false` 时只渲染只读清单 + 一句「写入已在配置里关闭（`overridesFile: false`）」，不渲染任何动作按钮。

### 8.2 状态机

状态集合恰好四个，外加两个正交标志：

```
state: "list" | "claim" | "confirm" | "custom"
pending: boolean                      // 有 POST 在飞
feedback: null | {kind:"done"|"error", text:string}
ctx: { itemId: string|null, query: string, selected: string|null, form: FormState }
```

| 当前 | 事件 | 下一个 | 必须发生的副作用 |
|---|---|---|---|
| `list` | 点某行的「认领为已有模型」 | `claim` | `ctx.itemId = item.id`；`ctx.query = ""`；`ctx.selected = null`；搜索框获得焦点 |
| `list` | 点某行的「自定义价格」 | `custom` | `ctx.itemId`；`form.model = item.model`（**只读**）；其余字段清空；`form.currency = currency` |
| `claim` | 输入查询 | `claim` | `ctx.query` 更新；结果列表按 8.3 过滤 |
| `claim` | 点某个候选 | `confirm` | `ctx.selected = candidate.id` |
| `claim` | 「返回」 | `list` | `ctx` 清空 |
| `confirm` | 「确认写入」 | `confirm` | `pending = true`；POST `setAlias`；成功 → `feedback={done}`、`pending=false`、调 `onDone()`；失败 → `feedback={error}`、`pending=false`，**留在 confirm** 且表单内容不丢 |
| `confirm` | 「取消」/「返回」 | `claim` | `ctx.selected` 保留（便于改选） |
| `custom` | 编辑字段 | `custom` | 字段更新；校验状态随之更新 |
| `custom` | 「写入 overrides」（仅当校验通过且 `!pending`） | `custom` | `pending=true`；POST `setModel`；成功 → `feedback={done}` + `onDone()`；失败 → `feedback={error}` |
| `custom` | 「取消」 | `list` | `ctx` 清空 |
| `claim`/`confirm`/`custom` | `Escape` | `list` | **`event.stopPropagation()`**，不得冒泡到面板的 Esc（F10） |
| 任意 | `props.items` 不再含 `ctx.itemId` | `list` | `feedback` 保留（刷新后仍看得到「已写入」） |
| 任意 | `pending === true` | 不变 | 所有提交类按钮 `disabled`（一次只允许一个 POST 在飞） |

`onDone()` 由 `Panel` 传入，实现为：`reload()`（主载荷）+ 重取 `/unpriced`。刷新失败时**不得**把 `feedback.done` 换成错误页（沿用既有「刷新失败保留旧数据、只加一条提示」的口径，`src/client.js:325-337`）。

### 8.3 搜索（`claim` 态）

- 数据源：`props.candidates`（GET 响应里已经带全量，**不再发请求**，ADR §2）。
- 过滤：`query.trim() === ""` → 空列表 + 提示「输入模型 id 或名称搜索」；否则大小写不敏感的子串匹配 `candidate.id` 或 `candidate.modelName`。
- 排序：① `id` 与 `query` 折叠后**完全相等**；② `id` 以 `query` 折叠后**开头**；③ `id` 含 `query`；④ 仅 `modelName` 含 `query`；同级按 `id` 的 `localeCompare` 升序。
- 上限 **50** 行，超出时显示「还有 N 条，请细化关键词」。
- 每行显示：`id`、`modelName`（缺省时留空）、`vendor`（缺省时留空）、四项价格（缺失显示 `—`）、币种。

### 8.4 `confirm` 态必须展示的内容（ADR §5「必须展示该模型的价格并要求确认」）

1. 待认领的 `item.id`；
2. 选中的 `candidate.id` + `modelName` + `vendor`；
3. 四项价格（`input`/`output`/`cacheRead`/`cacheWrite`，缺失显示 `—`）+ `currency`，标注「每百万 token」；
4. **写入路径** `overrides.path`（绝对路径）；
5. 若 `candidate.id` 同时是别名键且其目标 `V !== candidate.id`：一行提示「插件只做一跳解析：本别名将直接使用 `<id>` 自己的价格行，不会跟随到 `<V>`」；
6. 「确认写入」/「取消」两个 `<button type="button">`。

### 8.5 `custom` 表单字段与校验

| 字段 | 控件 | 必填 | 校验（客户端，必须与服务端 V9–V14 **同判据**） |
|---|---|---|---|
| `model` | 只读文本 | — | 恒等于 `item.model`，不可编辑（防止「给另一个模型定价」静默发生） |
| `input` | `type="text"` + `inputMode="decimal"` | 是 | 先 `trim()` 判空（空/纯空白 → 报错）；否则整串必须匹配十进制字面量（`/^[+-]?(?:\d+(?:\.\d*)?\|\.\d+)(?:[eE][+-]?\d+)?$/`），再用 `Number.parseFloat` 并要求 `Number.isFinite && >= 0` |
| `output` | 同上 | 是 | 同上 |
| `cacheRead` | 同上 | 否 | 空（`trim()` 后）→ 视为缺省（**不写键**）；非空 → 同 input |
| `cacheWrite` | 同上 | 否 | 同上 |
| `currency` | `<select>` | 是 | 选项 = `{[显示币种], ...candidates[].currency}` 去重排序 |
| `note` | `type="text"` | 否 | 长度 ≤ 200 |

> **为什么必须 `parseFloat` 且必须加整串判据**（第二轮评审 F1，实测）：
> `Number("  ") === 0` 而服务端 V10 的判据是 `Number.isFinite(p) && p >= 0`——**0 是合法价格**。所以只输入两个空格就会通过前端校验、发出 `input: 0`，该行随即从「—」变成 ¥0.00 并**离开未定价清单**，正是 ADR-0001 禁止的「拿 0 冒充免费」；前端是这条防线上唯一一关。
> 而 `parseFloat` 是**前缀解析**：`parseFloat("0x10") === 0`（不是 16）、`parseFloat("12abc") === 12`，只靠 `isFinite` 会把这两种垃圾输入静默当成合法值（`0x10` 尤其危险——它被当成**免费**）。所以补一条整串匹配的判据。
> 整串判据**不能**写成 `String(parsed) === trimmed`：那会把 `"1.50"`（→ `"1.5"`）与 `"1e3"`（→ `"1000"`）这类完全合法的写法一起误杀。发请求时用**同一套** `trim + parseFloat` 取值——判据与取值用两条不同规则，正是「校验通过但值错了」的典型成因。

- 提交按钮在**任一必填字段非法**或 `pending` 时为 `disabled`。
- 每个非法字段旁显示一行中文错误（例如「价格必须是有限数且 ≥ 0」），不使用浏览器原生 `alert`。
- 字段值原样保存为**数字**再发请求（不发字符串；服务端 V10 会拒字符串）。

### 8.6 反馈与错误文案

- 成功：`role="status"` 的容器里显示 `已写入 overrides：<path>`（`path` 来自 POST 响应）。
- 失败：`role="status"` 的容器里显示按 `detail` 映射的中文，并把原始 `detail` 放在括号里（便于报障）：

| `detail` / `error` | 文案 |
|---|---|
| `invalid-body` | 请求体不是合法的 JSON 对象。 |
| `unknown-field` | 请求体里有未定义的字段。 |
| `unknown-op` | 不认识的操作。 |
| `invalid-id` | 模型 id / 别名不合法（不能为空、不能含控制字符、不能用保留名）。 |
| `invalid-price` | 价格必须是有限数且 ≥ 0。 |
| `invalid-currency` | 币种不合法。 |
| `unknown-currency` | 该币种没有汇率，无法折算：请先在主定价表的 `rates` 里加汇率。 |
| `invalid-note` / `invalid-reason` | 备注 / 理由最长 200 个字符。 |
| `unknown-model` | 目标模型不在合并后的定价表里（不能写出死别名）。 |
| `unknown-target` | `remove` 的目标只能是 model 或 alias。 |
| `body-too-large` | 请求体过大。 |
| `unsupported-media-type` | 请求的 content-type 不是 `application/json`。 |
| `overrides-unreadable` | overrides 文件已存在但内容读不出来（不是合法 JSON，或文件读不出来）。为避免清空你手写的修正，已拒绝写入——请先修好这个文件。（409） |
| `unsupported-version` | overrides 文件版本比本插件新，已拒绝写入（避免覆盖）。 |
| `forbidden` | 只允许本机访问。 |
| `write-disabled` | 插件配置已关闭 overrides 写入。 |
| `method-not-allowed` | 方法不允许。 |
| `internal` | 写入失败，文件未改动。 |
| （网络异常） | 写入失败：`<error.message>`（沿用既有 `刷新失败：…` 的口径） |

### 8.7 外观与可访问性约束（ADR-0004 / ADR-0006）

- 只用 React 原生元素 + 运行时 `createElement`；不新增 `require`（客户端 `require` 桩只认 `"react"`，多一个包会立刻报错，F12）。
- 新增 CSS 只允许引用**已存在于宿主主题包**的 `--dsw-alias-*` token（`test/appearance.test.js:402` 会逐个核对存在性）；不新增 `color-mix()`、不写深色专用 `var()` 兜底值、不用 `opacity` 调暗文字。
- 新增的交互元素必须是真实 `<button type="button">`，且类名要加进既有的 `:focus-visible` 规则选择器列表（`src/client.js:218-219` 那条）。
- 不引入 `@media` 新断点；区块在窄视口下的横向滚动沿用 `.ul-tablewrap`。

**断言**
- **A51**：`UnpricedSection` 在 `items` 为空时返回 `null`；非空时渲染出 `items.length` 行，每行含 `provider/model` 文本与 `fmtTokens(tokens)`。
- **A52**：点第 1 行的「认领为已有模型」→ 状态进入 `claim`，且渲染出一个搜索输入框（`statefulReact` 重放，断言元素树）。
- **A53**：在 `claim` 态输入 `deepseek` → 候选列表只含 `id` 或 `modelName` 含 `deepseek` 的项，且按 8.3 的四级顺序排列（构造一个四条都命中的 fixture 来断言顺序）。
- **A54**：选中候选 → `confirm` 态文本里出现：`item.id`、`candidate.id`、四项价格、`overrides.path`（A50 的另一半）。
- **A55**：`confirm` 态按「确认写入」→ 断言恰好发出一个 `fetch`，其 URL 以 `` `${API}/overrides` `` 结尾、`method === "POST"`、body 解析后深等于 `{op:"setAlias", alias:<item.model>, model:<candidate.id>, reason:<suggestion.reason>}`。
- **A56**：POST 返回 400 `unknown-model` 时，断言 `feedback` 是错误文案、状态**仍在** `confirm`、输入内容未丢；且没有触发 `onDone()`。
- **A57**：POST 成功（200）时断言 `onDone()` 被调用一次、`feedback` 是成功文案且含响应里的 `path`。
- **A58**：`custom` 态：`input` 填 `-1` → 提交按钮 `disabled` 且显示「价格必须是有限数且 ≥ 0」；填 `"abc"` → 同上；`cacheRead` 留空 → 提交的 body **不含** `cacheRead` 键。
- **A59**：`custom` 态的 `model` 字段是只读文本（元素上带 `readOnly` 或 `disabled`，或根本不是 input），且文本等于 `item.model`。
- **A60**：`claim`/`confirm`/`custom` 三态各按一次 Escape：断言状态回到 `list`、`event.stopPropagation()` 被调用（用一个记录调用的假 event）、且**没有**调用 `onClose()`（面板不关）。
- **A61**：`pending === true` 时所有提交按钮 `disabled`（用 `statefulReact` 让 POST 悬停不返回，再断言元素树）。
- **A62**：`overrides.enabled === false` 时区块内**没有**「认领为已有模型」/「自定义价格」按钮，且文本含「写入已在配置里关闭」。
- **A63**：`props.items` 里去掉 `ctx.itemId` 后（模拟刷新），状态回到 `list`，`feedback` 仍保留。
- **A64**：`test/appearance.test.js` 全文不改、全绿（新增 CSS 引用的 token 都真实存在；`UnpricedNotice` 被钉住的两句文案不变——`test/client.test.js:1070-1093` 同样不改）。

## 9. 断言索引

| 断言 | 决策 | 测试文件（建议） | 一句话 |
|---|---|---|---|
| A1–A3 | D1 | `test/routes.test.js`（新） | 三条 exact 路由的注册形状与常量 |
| A4–A6 | D1 | `test/routes.test.js` | 方法闸门与回环闸门覆盖新路由 |
| A7 | D1 | `test/contract.test.js`（追加） | 客户端字面量含 `` `${API}/unpriced` `` / `` `${API}/overrides` `` |
| A8–A13 | D2 | `test/unpriced.test.js`（新） | 响应 schema、`cause`、跨接口不变式 |
| A14 | D3 | `test/overrides-file.test.js`（新） | `resolveOverridesFile` 的 `$DSH_HOME` 口径 |
| A15–A17 | D3 | `test/overrides-file.test.js` | 容错口径与 `normalizeAliasMap` |
| A18–A19 | D3 | `test/overrides-file.test.js` + 既有 `test/pricing-file.test.js` | 字符串别名兼容（仓库 20 条 / 运行时 27 条）；旧函数行为不变 |
| A20 | D3 | `test/overrides-file.test.js` | `version > 1` 拒绝写且不动文件 |
| A21–A24 | D4 | `test/merge-pricing.test.js`（新） | 合并顺序与冲突 warn |
| A25 | D4 | `test/payload.test.js`（追加） | `Object.hasOwn` 修正（原型键不再被算成免费） |
| A26–A28 | D4 | `test/routes.test.js` | `pricingFile:false` 仍读 overrides；写后可见 |
| A29–A37 | D5 | `test/suggest.test.js`（新） | 三条规则、反例、纯函数性（含 A32b 折叠撞键消歧） |
| A38–A50 | D6 | `test/overrides-post.test.js`（新） | 校验清单、原子写、串行化、幂等 |
| A51–A63 | D7 | `test/client.test.js`（追加） | 状态机、搜索、表单、错误映射 |
| A64 | D7 | 既有 `test/appearance.test.js` / `test/client.test.js` | 外观与既有文案零回归 |

**回归闸门**：`npm test` 全绿（含 `test/viewport.test.js` 在 CI 的独立 job 里 `skipped === 0`）；`npm run mutate` 不因新增代码产生 `SURVIVED`；建议为以下三条新增变异体（照 `scripts/mutation-check.mjs` 的 `killer` 必填格式）：

| 变异体 id | 变异 | 期望杀手 |
|---|---|---|
| `unpriced-tail-number-stripped` | 在 `suggestModels` 里加一条「剥尾部数字」规则 | A30 |
| `alias-target-not-own-property` | `officialIdOf` 的 `Object.hasOwn` 改回 `in` | A25 / A10 |
| `overrides-early-return` | `refreshPricing` 的早退条件改回只看 `pricingFile` | A26 |
| `suggest-self-referential` | 去掉 `suggestModels` 的自指过滤 | A35 |
| `alias-fold-first-match` | 折叠撞键时取「遍历到的第一个」而不是「逐字符相等优先」 | A32b |

## 10. 已裁决（用户授权「按推荐执行」；实现已完成，本节是裁决记录）

本节原先列了 5 条无法从代码/ADR 唯一确定的设计点。用户已授权「需要让我裁决的，都按照你的推荐执行」，captain 于实现完成后下达最终裁决。下面逐条记录**裁决、理由、落地证据**。规格其余小节是实现的依据，**不再变动**。

| # | 裁决 | 落地证据 |
|---|---|---|
| ① | **未定价清单按 `tokens` 降序**（采纳本规格冻结的口径） | `src/index.js:808`：`items.sort((a, b) => b.tokens - a.tokens \|\| b.requests - a.requests \|\| a.id.localeCompare(b.id))`；`test/unpriced.test.js:194` 断言 tokens 降序、同 tokens 时按 requests 降序再按 id 升序兜底，并有**反向对照**（请求数最多的那一行**不在**最前，证明排序键真的是 tokens 而不是 requests） |
| ② | **文案改为「立即生效」**（不用 ADR 的「30 秒内生效」） | `README.md:140`：「成功后立刻生效（不是「30 秒内」——面板紧跟的那次请求会强制重读）」；行为侧 `src/index.js:1182` 写成功后 `pricingStamp = 0` |
| ③ | **`config.overridesFile` 写进 README**（作为公开配置项，不只是测试接缝） | `README.md:80`（配置段：`overridesFile: /custom/overrides.json # 默认 $DSH_HOME/usage-ledger-overrides.json；设 false 关闭写入`）、`README.md:84`（`false` 只关写入、面板变只读清单、主表与合并不受影响）、`README.md:168`（「设计取舍」段：写入范围仅限 `$DSH_HOME` 下的独立文件） |
| ④ | **`remove` 本阶段不做面板 UI，只保留服务端 op** | 服务端语义已冻结且有测试：`applyOverride` 的三个 op 落盘内容（`test/overrides-post.test.js:200-218`）、「删不存在的 id 幂等且不动其它键」（`:221-225`）、V16 `target` 只认 model/alias（`:162-167`）；`src/client.js` 只有 `op:"setAlias"`（`:683`）与 `op:"setModel"`（`:784`）两条写路径，**没有**「撤销认领」入口 |
| ⑤ | **`GET /unpriced` 接受 `range`，与主接口同口径**（采纳本规格冻结的方案） | `src/index.js:1093`：`resolveRange(url.searchParams.get("range") ?? "all", …)`，与主接口共用同一个 `resolveRange`；`src/index.js:1079-1081` 的注释写明「必须与当前标签页的数字自洽」 |

**理由（逐条，来自裁决）**：

1. **① tokens 降序**：现有 `UnpricedNotice` 与既有断言都按 tokens（`src/client.js:798`、`test/client.test.js:1070-1093`），改口径会动一条已被断言钉住的既有行为；同一个面板里「未定价」两处口径必须一致。
2. **②「立即生效」**：写后强制重读，面板紧跟的那次请求就会读到新值。写「30 秒内」是**假话**，而本仓库最忌讳静默/误导（与 ADR-0001「不猜」、`loadPricingFile` 的「宁可少算也不报错误导」同源）。
3. **③ 写进 README**：`pricingFile` 已是对外配置项，`overridesFile` 与之对称；且它是**关闭写入能力的唯一开关**（`false` → POST 一律 403 `write-disabled`），属于用户需要知道的安全边界，藏起来不合适。
4. **④ 不做 `remove` UI**：`remove` 的语义（幂等、只删 overrides、绝不碰主表）已冻结并有测试；面板入口属于增量体验，而本阶段重点是「让未定价的能被定价」。手工删 overrides 里的键也能达到同样效果，且 overrides 文件小、可读。不做可以避免为一个边缘操作增加面板状态机的复杂度。
5. **⑤ 接受 `range`**：区块必须与当前标签页的数字自洽——用户切到「今日」时，未定价清单也该是今日口径，否则会出现「卡片说今日、清单说累计」的自相矛盾。

**captain 的附带确认（已记录，不需要本规格再动）**：

- §11 列出的 6 条与 ADR 的差异**全部认可**；其中 3 条（§3 例子走 R3、§4 自有键判据、§1 的 `in` 缺陷）已写进 `docs/adr/0008-in-panel-model-claiming.md` 的勘误段（该文件 94-96、112-114、120 行）。ADR 与规格现已一致。
- `officialIdOf` 的 `in` 缺陷已被实现者修复为 `Object.hasOwn`（`src/index.js:238`、`:780`），并由新变异体 `alias-target-not-own-property` 守住（`scripts/mutation-check.mjs:260`）。
- `refreshPricing` 的早退条件已按要求修改（`src/index.js:1024`：`pricingFile === undefined && overridesFile === undefined` 才早退），并由变异体 `overrides-early-return` 守住（`scripts/mutation-check.mjs:268`）。

**遗留交叉引用已清理**（captain 决定）：原先三处指针与新裁决不一致——本规格 §11 第 3 行、§0 第 17 行，以及 ADR-0008 第 128 行。三处均已改为与本节裁决一致：§11 第 3 行改记「立即生效」，§0 第 17 行改指「第 10 节『已裁决』」，ADR-0008 §5 的提示文案改为「已写入 overrides，立即生效」。

## 11. 与 ADR-0008 提案的差异（逐条列明，不静默覆盖）

| # | ADR-0008 的字面表述 | 本规格 | 为什么 |
|---|---|---|---|
| 1 | §4「别名目标…不能是另一个别名」 | 硬规则只有「必须是合并后 models 的自有键」；「目标同时是别名键」只提示不拒绝 | 实测运行时表 27 条别名里 23 条的目标同时是别名键；按字面实现会让 `deepseek-flash` 这类最常用目标全部不可写。一跳解析的正确性由自有键判据完整覆盖（见 D6） |
| 2 | §2 的 URL 没有查询参数 | 接受与主接口相同的 `range`/`from`/`to`，缺省 `all` | 区块必须与当前标签页的数字自洽；口径直接复用 `resolveRange`，零新增语义 |
| 3 | §5「30 秒内生效」 | 写后强制重读，**立即生效**（文案已裁决，见第 10 节第 2 条） | 不强制重读的话，用户刚认领完就会看到同一行**仍然未定价**——本仓库最忌讳的静默失败 |
| 4 | §1 的 overrides 示例没有 `rates` | 明确「overrides 没有 rates 段」，出现即忽略 + warn | 币种可用性改由主表的 `rates` 决定（V13），避免两处汇率来源打架 |
| 5 | §2 响应示例只有 `id/provider/model/tokens/requests/suggestions/candidates` | 增补 `cause`、`candidates[].source`、`candidates[].cacheRead/cacheWrite/context` 的可空性、`overrides{path,exists,version,enabled}`、`range`、`generatedAt`、`currency` | `costOf` 有两条 `undefined` 路径，面板必须说清是哪一条（`cause`）；写入范围必须可见（`overrides.path`）；可空性必须写死，否则前端会在「字段缺失」与「值为 0」之间出错 |
| 6 | 未提 `officialIdOf` 的 `in` | 要求改成 `Object.hasOwn` | 实测 `model = "constructor"` 会被算成 ¥0（与 ADR-0001「不拿 0 冒充免费」直接冲突） |

## 12. 规格自定的常量（非推导，允许实现者按需调整但必须同步断言）

| 常量 | 值 | 说明 |
|---|---|---|
| `OVERRIDES_VERSION` | `1` | 文件格式版本 |
| `MAX_BODY_BYTES` | `65536` | POST body 上限 |
| `MAX_ID_LENGTH` | `200` | 模型 id / 别名长度上限 |
| `MAX_TEXT_LENGTH` | `200` | `note` / `reason` 长度上限 |
| `MAX_SUGGESTIONS` | `3` | 每个 item 的建议条数上限 |
| `MAX_SEARCH_ROWS` | `50` | 搜索下拉渲染上限 |
| R1 / R2 / R3 `score` | `0.9` / `1` / `0.8` | 只表达规则确定性，**不是**相似度 |
| `PROTOTYPE_KEYS` | `["__proto__","constructor","prototype"]` | 拒绝写入的保留键（F18 的实测依据） |

## 13. 约束自查

- 本文件只新增 `docs/specs/0008-unpriced-claiming-spec.md`，**未改动 `src/` 下任何文件**，未改动既有测试与 `package.json`。
- 文中所有「现状」都先在代码/数据里核实过（第 1 节 F1–F18），引用行号取自规格定稿时的版本（`main`，`d09201d`）。
- 每条决策都有编号断言（第 9 节）。原先 5 条无法唯一确定的设计点已在第 10 节**全部裁决完毕**（用户授权「按推荐执行」），本节不再有「待用户裁决」项。
- 第 10 节的裁决记录是在实现完成之后补写的，只改该节；规格其余小节与实现依据保持一致，未再变动。
