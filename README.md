# dsh-usage-ledger

DSH 插件的本地用量面板：把会话日志里的 token 消耗按**渠道 / 模型 / 时间**聚合出来。

**零网络、零凭据、零外部依赖**——不访问任何 API，不读取任何密钥，全部数字都从本机已有的会话日志算出。

## 它做什么

- 一个 Web 面板（挂在侧边栏页脚），支持按 今日 / 近 7 天 / 本月 / 累计 / 自定义 切换
- 外观**跟随宿主主题**（浅色 / 深色 / 跟随系统）：面板用宿主设计 token 上色，
  不自己判断当前主题（热力图色阶是插件自带常量，因为宿主没有强度色阶 token）
- 分渠道、分模型两张可排序明细表；分模型表里同一模型的多条渠道分行渲染成
  `provider/model`，跨渠道模型额外给一行非交互小计（口径与取舍见
  `docs/adr/0007-model-table-partitioned-by-channel.md`）
- 近一年的活跃度热力图（371 天，整周对齐）
- 消耗总量、请求数、输入/输出/缓存读/缓存写、推理 token、缓存命中率
- 一个 `/usage [today|week|month|all]` 文本命令，不开浏览器也能看一眼

## 数据源

DSH 自己的持久化会话日志：

```
$DSH_HOME/sessions/<cwd 编码>/session-<uuid>/session.v4.jsonl.zstd
```

每条 `assistant/message` 事件同时携带**计费用量**与**实际服务该请求的路由**：

```json
{"type":"assistant/message","time":1790516405452,
 "data":{"message":{"source":{"provider":"example-relay","model":"deepseek-v4.1-flash"}},
         "usage":{"inputTokens":1896,"outputTokens":321,"cacheReadTokens":8960}}}
```

所以「分渠道、分模型、按时间」可以完全从本地记录直接算出，不需要网络请求，也不需要推断请求走了哪条渠道。

两个实测结论影响了扫描策略（细节见 `src/scan.js` 头注释）：

- 日志容器是**多帧拼接**的 Zstandard，Node 的 `zstdDecompressSync` 只解第一帧，必须先扫帧边界再逐帧解压
- `assistant/attempt` 从不携带 usage，失败尝试不计费；只统计带 usage 的 `assistant/message`，每个会话内 `(turn, step)` 唯一，不会重复计费

## 安装

装进某个 DSH profile：加依赖，并把包名加进该 profile 的 `dsh.profile.bundles`。

```jsonc
{
  "dependencies": {
    "dsh-usage-ledger": "github:lzpgood123/dsh-usage-ledger"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...其它 bundle
        "dsh-usage-ledger"
      ]
    }
  }
}
```

本地开发可以直接 `link:`：

```jsonc
{ "dependencies": { "dsh-usage-ledger": "link:/path/to/dsh-usage-ledger" } }
```

`@deepseek-ai/cordis` 是 peerDependency，由宿主提供，不需要自行安装。

## 配置

在 profile 的 `cordis.patch.yml` 里按插件 id 覆盖：

```yaml
- id: usage-ledger
  name: dsh-usage-ledger
  config:
    sessionsRoot: /custom/path/to/sessions   # 默认 $DSH_HOME/sessions
    pricingFile: /custom/pricing.json        # 默认 $DSH_HOME/usage-ledger-pricing.json；设 false 关闭
    overridesFile: /custom/overrides.json    # 默认 $DSH_HOME/usage-ledger-overrides.json；设 false 关闭写入
    currency: CNY                            # 计价币种，默认 CNY
```

`overridesFile: false` 只关闭**写入**（`POST /overrides` 一律 403 `write-disabled`），面板上的未定价区块会变成只读清单，主表与合并逻辑不受影响。

## HTTP 接口

```
GET /api/usage-ledger?range=today|week|month|all|custom&from=YYYY-MM-DD&to=YYYY-MM-DD
GET /api/usage-ledger/unpriced?range=…&from=…&to=…     # 只读：未定价清单 + 候选模型 + 带理由的推荐
POST /api/usage-ledger/overrides                       # 写入：setModel / setAlias / remove
```

**只允许回环地址读取**（`127.0.0.1` / `::1`），其余来源一律 403。接口暴露的是本机全部会话的用量画像（含模型与项目规模），不该被局域网里的其他机器读到；判据是不可伪造的 peer 地址，`Host` 只作补充。三条路由各自做方法闸门（前两条只认 `GET`/`HEAD`，第三条只认 `POST`，其余 405），回环闸门对三条**同样生效**——写接口放行局域网等于让别的机器改你的定价表。

`POST /overrides` 的请求体是**严格 schema**，出现任何未列出的键一律 400 `unknown-field`。这同时是防目录穿越的实现方式：请求体里根本没有路径字段可传，写入位置固定为 `$DSH_HOME/usage-ledger-overrides.json`。错误响应里的 `detail` 是稳定的英文码（`invalid-price` / `unknown-model` / `unknown-currency` / `unsupported-version` …），面板负责翻成中文。

写接口还要求 **`content-type: application/json`**（否则 400 `unsupported-media-type`）。这不是格式洁癖，是本接口唯一挡得住「本机浏览器里的任意网页」的判据：宿主 webserver 直接调用路由 handler，**没有鉴权层**；而回环闸门只查 peer 地址——来自本机网页的请求 peer 同样是 `127.0.0.1`，照常放行。`application/json` 属于 CORS 的**非简单** content-type，跨站请求会先发 `OPTIONS` 预检，而本插件不返回任何 CORS 头 → 预检必败 → 真正的 POST 发不出去。（`text/plain` 是简单类型、不会被预检拦住，所以必须明确拒绝。）

若 overrides 文件**已存在、但读不出内容**，写入会被拒绝（409 `overrides-unreadable`）而不是拿空表覆盖它——那个文件里是用户手写的修正，静默清空等于丢数据。两种情况都算：

- **内容不是合法 JSON**（例如手改时多留一个尾逗号）；
- **文件读不出来**（`EPERM` / `EACCES` 等，例如权限只给了写没给读）。

第二种容易被误判成「反正写会失败」，但它**不会**：原子写用的是 `rename`，而 `rename` 只替换目录项、**不需要读目标文件**（实测：`icacls <file> /deny <user>:(R)` 下 `readFile` 抛 `EPERM`，`rename` 照常成功）。所以「读不到」绝不能当成「没有内容」。唯一的例外是目标根本不是普通文件（目录等）——那时写入本身必然失败，走既有的 500 `internal`「写入失败，文件未改动」。

读取侧仍然按空表降级（价格读不到不该让面板挂掉），只有**写**会拒绝。

## 定价（可选）

价格表放在独立 JSON 文件里，改完下一次请求即生效，不用动 profile 配置、不用重启。

**仓库自带一份参考底表** `usage-ledger-pricing.json`（76 个模型 + 20 条别名 + 汇率表）。新机器上不必从零填表，拷过去即可：

```sh
cp usage-ledger-pricing.json "$DSH_HOME/usage-ledger-pricing.json"
```

⚠️ **运行时读的始终是 `$DSH_HOME` 那份，不是仓库里这份**。仓库里的是**分发用的底表**，`resolvePricingFile()` 的默认路径不受它影响；也**不会**在找不到 `$DSH_HOME` 那份时回退读包内——回退会让「用户以为自己改了价格、实际读的是包内底表」变成静默故障。同理它**不进 npm 包**（`files` 只发布 `src/` 与 `cordis.patch.yml`）：它是用户可编辑的数据，塞进 `node_modules` 会在每次 `pnpm add` 时被覆盖。

表本身携带溯源信息（`_generated`、`_sources`、逐条 `models[*].source` 与 `confidence`），是按各厂商官方定价页人工编译的，**没有生成脚本**——更新时整份替换。

文件格式：

```json
{
  "models": {
    "deepseek-v4.1-flash": { "input": 0.5, "output": 2, "cacheRead": 0.05, "cacheWrite": 0.5 }
  },
  "aliases": {
    "relay-flash-0731": "deepseek-v4.1-flash"
  },
  "rates": { "USD": 7.3 }
}
```

设计口径：**一律按官方模型定价计价，与实际走哪条渠道无关**。同一份 token 在不同渠道的成交价可能相差数倍（折扣、加价、积分、免费额度），按渠道计价会让跨渠道用量不可比。按官方挂牌价算出来的数字回答的是「这些 token 若按官方价买值多少」，也就是**消耗程度**。

`aliases` 负责把渠道专有的模型 id 归一到官方模型 id；归一不了的就如实留空，不硬套一个价格。文件缺失或损坏时按空表处理——价格是锦上添花，不能因为它读不到就让整个面板挂掉。

金额仅供参考，与你实际的渠道结算无关。

### 面板内认领（overrides）

主表是仓库同步来的目录，**手改它下次同步就被覆盖**。所以面板里的「未定价」区块把手工修正写进**独立的** `$DSH_HOME/usage-ledger-overrides.json`，合并顺序是：

```
内联 config  <  usage-ledger-pricing.json  <  usage-ledger-overrides.json
```

overrides 是用户最新的意图，优先级最高；主表整份替换不丢手工修正。写入走**临时文件 + rename** 的原子替换（避免半截 JSON），成功后立刻生效（不是「30 秒内」——面板紧跟的那次请求会强制重读）。**绝不修改主定价表**。

```json
{
  "version": 1,
  "models": {
    "some-new-model-x": { "input": 1.5, "output": 6, "currency": "CNY", "note": "面板手工录入", "source": "manual" }
  },
  "aliases": {
    "workbuddy/deepseek-v4.2-sg": { "model": "deepseek-flash", "reason": "同型号新加坡区", "addedAt": "2026-10-02T21:40:00+08:00", "origin": "panel" }
  }
}
```

`aliases` 的值允许是**字符串**（旧格式，主表现有的 20 条都是）或**对象**（新格式）；解析时统一成对象，字符串视为 `{model: <str>}`，所以主表不用改。overrides **没有** `rates` 段（币种可用性由主表的 `rates` 决定），出现即忽略并记一条 warn。

**推荐规则只有三条**，每条都能用一句话解释，且都带 `reason`：去掉命名空间前缀后的尾部匹配（`0.9`）、大小写折叠（`1`）、已知别名的反向映射（`0.8`）。**明确不做**去日期后缀、去尾部数字、编辑距离——实测 `claude-opus-5-5`(4/20) 与 `claude-opus-5`(5/25) 输入输出**都贵 25%**，`qwen3.8-max-0902` 与 `qwen3.8-max` 在表里是**两行**；任何「按后缀合并」的实现都会静默用错价。推荐只是**待确认的建议**，确认框里必须展示实际价格，从不自动应用。

**别名解析是一跳**：写完 `A → T` 后插件只看 `T` 自己的价格行。所以服务端硬校验只有一条——`T` 必须是**合并后 models 的自有键**（否则就是「死别名」，永远算不出钱）。「`T` 同时是别名键」只提示不拒绝：实测运行时表 27 条别名里有 23 条的目标同时是别名键，按「不能是另一个别名」实现会让 `deepseek-flash` 这类最常用的目标全部不可写。见 `docs/adr/0008-in-panel-model-claiming.md`。

## 设计取舍

**不碰宿主 `settings`。** 数据源本身就是权威的：每条记录都带着实际服务该请求的 provider/model。早先的版本依赖宿主 `settings.get(ns)` 来判断路由，结果是中转站发现不了——这个依赖被整个去掉了。

**不依赖任何第三方前端组件。** 浏览器端是手写的 `__ModuleLoader__` bundle，用运行时 `createElement`，没有构建步骤、没有 JSX，也不 require 宿主的 UI primitives。此前有插件因为图标名在宿主版本间从 `IconCloseOutline16` 改成 `IconCloseOutlineRegular` 而拿到 `undefined`，React 抛错导致整个插槽静默崩溃。这里只用 React 原生元素 + 宿主 CSS 变量 + 文字符号。

**不读凭据、不发网络请求。** 面板里的通道数量就是这些——没有别的。

**写入只落在 `$DSH_HOME` 下的一份独立文件里。** 面板内认领（`POST /overrides`）是这个插件唯一的写路径：路径固定、不接受任意路径（请求体里根本没有路径字段），走临时文件 + rename 的原子替换，且**绝不修改主定价表**。主表是仓库同步来的目录，改它下次同步就被覆盖。`overridesFile: false` 可以整个关掉写入。

**外观只依赖宿主 token。** 面板的颜色取自宿主的 `--dsw-alias-*` 变量（唯一的例外
是热力图五档色阶——宿主没有强度色阶 token，它由插件自带常量、按
`body[data-ds-dark-theme]` 分主题给出），不自己判断当前主题、也不写深色专用的
兜底值：宿主默认是「跟随系统」，而 CSS 的 `var()` 在变量不存在时**不报错**，
会静默落到兜底值。此前面板引用了两个宿主并不存在的 token，于是浅色系统上正文
对比度只剩 1.25:1（WCAG AA 需 4.5:1）、卡片与分隔线整片消失——而错误 token 名
写在**不导出**的 CSS 字符串里，测试够不到。现在 token 名的存在性由
`test/appearance.test.js` 对照宿主主题包断言。理由与代价见
`docs/adr/0006-appearance-host-tokens-only.md`。

**两端共用口径，但不共享代码。** 接口前缀、范围词表、热力图天数是宿主端与浏览器端
各自写一遍的：浏览器端 bundle 是传统 `<script src>`（不是 ES module），它的 `require`
也不认相对路径，抽不出共享模块。所以靠 `test/contract.test.js` 钉住两端一致，
而不是靠抽模块。理由与代价见 `docs/adr/0005-cross-end-contract-by-test.md`。

## 结构

```
src/index.js                宿主端：挂 HTTP 路由与 /usage 命令，按范围聚合、计价、overrides 读写
src/scan.js                 会话日志扫描与聚合（多帧 zstd 解压、usage 提取）
src/client.js               浏览器端面板（手写 ModuleLoader bundle，无构建步骤）
scripts/mutation-check.mjs  变异检查：把源码改坏，验证测试真的会红（见下）
test/scan.test.js           扫描策略：缓存、淘汰、容错
test/list-sessions.test.js  会话文件枚举与跨代去重
test/payload.test.js        载荷组装：范围折算、371 天窗口、渠道计价
test/cost-of.test.js        计价口径：缺价格或缺汇率一律留空，不拿 0 冒充免费
test/pricing-file.test.js   价格表读取与路径解析：读不到价格表只降级，绝不拖垮面板
test/overrides-file.test.js overrides 读取、别名规范化与三层合并：旧格式别名继续可用
test/overrides-post.test.js 写入校验清单（V5–V17）与 applyOverride 的落盘语义
test/unpriced.test.js       未定价探测载荷：schema、cause 的两支、跨接口不变式
test/suggest.test.js        推荐规则：只有三条可解释的规则，含价差反例断言
test/routes.test.js         路由注册、方法/回环闸门、写入的原子性与串行化
test/screen-request.test.js 回环闸门：只放行精确回环地址，局域网一律 403
test/client.test.js         浏览器端导出的纯函数与组件
test/client-unpriced.test.js 未定价区块的状态机：搜索、确认、自定义价格、Esc
test/appearance.test.js     外观契约：宿主 token 存在性、色阶可辨、键盘可达
test/contract.test.js       跨端契约：两端字面量必须一致（见下）
test/viewport.test.js       视口几何：真实 Chrome 驱动，面板不得被切出视口
test/fixtures.js            事件构造器（运行时压缩，不入库二进制）
test/memory-source.js       内存版 Source adapter
test/client-harness.js      浏览器端 bundle 的 stub-loader 夹具
```

`src/scan.js` 里，扫描策略与文件 I/O 之间有一个内部 seam：`createScanner(source)`
只依赖 `source` 的 `list`/`stat`/`read`/`compressed` 四个成员。线上用
`diskSource(root)`，测试用 `test/memory-source.js` 里的内存 adapter。这不是对外
接口——它存在的唯一目的是让缓存失效、淘汰、失败计数这些策略可以在没有真实目录
的情况下被断言。

`test/` 不进 npm 包（`package.json` 的 `files` 只发布 `src/` 与
`cordis.patch.yml`）。

## 测试

零依赖，用 Node 内置运行器（`node >= 22`）：

```sh
npm test        # node --test "test/**/*.test.js"
```

**这里刻意不写用例数**：这类硬编码每次加测试都会过期，`scripts/` 与 workflow 里的
同类计数已经清过一轮。要数字就跑一次，TAP 的汇总行才是权威：

```sh
node --test --test-reporter=tap "test/**/*.test.js" | grep -E '^# (tests|skipped)'
```

glob 不能省：裸 `node --test` 会退回**默认发现**，递归跑遍 `test/`，把 `fixtures.js`、
`memory-source.js`、`client-harness.js` 这些纯夹具也各当成一个测试文件跑一遍，
用例数因此虚高。`npm test` 只跑 `*.test.js`。

还要注意 **`npm test` 不是「全绿」的同义词**：它包含 `test/viewport.test.js`，
而没有 Chrome 的机器上那几条只能 `t.skip()`——skip **不会**让 `node --test` 以非 0
退出。也就是说无浏览器环境下 `npm test` 照样退出 0，只是少验证了几条几何断言。
CI 因此把浏览器用例拆进独立的 job（见下）。

### 覆盖

- **扫描策略**（`scan.test.js`）：缓存命中与失效、删除后的淘汰、损坏文件与断尾帧的
  容错、非空压缩文件零帧计入 failed，以及 `recordOf` 的用量口径。缓存那几条刻意
  构造「只变 size」与「消失后以相同 mtime+size 恢复」两种场景——否则缓存键与淘汰
  逻辑被改坏时测试仍会全绿。
- **会话文件枚举**（`list-sessions.test.js`）：跨代文件去重（`session.jsonl.zstd` 与
  `session.vN.jsonl.zstd` 只取最高版本）、非会话文件忽略、根目录缺失时返回空列表。
- **载荷组装**（`payload.test.js`）：范围折算（近 7 天含当天）、371 天热力图窗口的
  下界、渠道成本按未舍入值求和后只舍入一次、时钟注入。用合成记录与合成价格表，
  因为本机语料跨度远小于 371 天、且舍入漂移恰好不到翻转阈值——这两类缺陷在真实
  语料上不可见。
- **计价口径**（`cost-of.test.js`）：口径是「宁可显示 —，也不猜汇率」，落到 `costOf`
  的两处 `return undefined` 上——价格缺失返回 `undefined` 而**不是 0**；条目币种与
  目标币种不同、而 `rates` 里没有该币种的**有限数**汇率时同样返回 `undefined`
  （不拿 1、也不拿 0 顶上）。用例把「缺失」与「显式给出的 0」明确分开，并用带 get
  陷阱的汇率表证明币种相同时实现**根本不查 `rates`**。这两处一旦退化成 `?? 0`，
  未定价的渠道会被静默算成 ¥0，正是要避免的「0 冒充免费」。理由见
  `docs/adr/0001-official-list-price-accounting.md`。
- **价格表读取与路径解析**（`pricing-file.test.js`）：`loadPricingFile` 的每条分支
  都是**静默降级**——坏了不报错，只会悄悄少算钱。用例钉住方向相反的几条判据：拿不到
  路径（`undefined` / `""` / 非字符串）→ 空表且**不 warn**（非字符串真去读会抛错，
  而那个错会被同一个 catch 吞掉、转成一次 warn，所以「不该 warn」才是「没去读」的
  可观测形式）；文件不存在（ENOENT）→ 空表且**不 warn**（不存在是常态，warn 会变成
  每次启动刷日志）；损坏或结构不可用（非法 JSON、顶层是数组/数字、`models` 不是
  对象）→ 空表 + warn，**绝不抛错**（价格读不到不该让整条路由 500）。`aliases` /
  `rates` 各自独立降级为 `{}`，**不影响 `models`**——整表作废会让金额一栏全变「—」
  而没有任何报错。`resolveSessionsRoot` / `resolvePricingFile` 守的是 `$DSH_HOME`
  回退与「`false` = 显式不要价格表 ≠ 没配」的区别，环境变量改写一律 `withEnv` 包住
  并在 finally 里连「键是否存在」一起还原，不泄漏给同进程的其它用例。
  这些退化都固化在 `scripts/mutation-check.mjs` 里（`pricing-file-*` 三个变异体），
  手工自证因此变成常驻护栏。`file === ""` 那半句是**例外**：`readFile("")` 本身就是
  ENOENT，与正常吞掉 ENOENT 的结果完全一样，进程外无法区分，所以没有对应变异体。
- **overrides 与三层合并**（`overrides-file.test.js`）：`resolveOverridesFile` 的
  `$DSH_HOME` 口径与 `false` = 关闭写入；`loadOverridesFile` 的容错逐条对齐
  `loadPricingFile`（拿不到路径/ENOENT → 空形状且**不 warn**，损坏 → 一次 warn），
  `models`/`aliases` 各自独立降级；版本策略（缺失当 1 不 warn、`>1` 尽力合并但 warn、
  非整数当 1 并 warn）；`normalizeAliasMap` 把**字符串**（旧格式）与**对象**（新格式）
  统一成对象并丢弃坏项与原型保留名。`mergePricing` 守「内联 < 主表 < overrides」，
  `sources` 记最终赢的那一层，冲突日志**只记 overrides 覆盖别人**（内联被主表覆盖是
  既有行为，为它刷日志会淹没真正的冲突）。向后兼容的判据落在**仓库底表的 20 条字符串
  别名**上：规范化后一条都不能少、值都变成对象、`model` 一字不改。
- **写入校验与落盘**（`overrides-post.test.js`）：`validateOverride` 是纯函数，V5–V17
  每条各一个用例（合法通过 + 恰好一个非法字段 → 对应的稳定错误码）。三条容易写错且错了
  不报错的规则被单独钉住：价格**不做字符串强转**（`"1.5"` 拒）、别名目标必须是合并后
  models 的**自有键**但**可以**同时是别名键、缺省的 `cacheRead`/`cacheWrite`/`currency`
  **不写这个键**（写 0 是伪造免费）。`applyOverride` 三个 op 的落盘语义与幂等另有用例。
- **未定价探测载荷**（`unpriced.test.js`）：七个顶层键、`cause` 的两支（`no-price` /
  `no-rate`）必须穷尽 `costOf` 的两条 `undefined` 路径、候选的可空性写死为 `null`
  而不是 0。**最重要的一条是跨接口不变式**：同一批记录下，`/unpriced` 的 `items` 与
  主载荷的 `cost.unpriced` 必须逐字相同——两处分叉时面板会同时显示「未定价：N 个模型」
  与一份对不上的清单，而没有任何报错。`model = "constructor"` 的用例守的是原型链陷阱
  （`in` 会拿到 Object 构造函数，把整行静默算成 ¥0）。
- **推荐规则**（`suggest.test.js`）：只有三条规则，每条都带非空 `reason`，且返回值
  必须是合并后 models 的自有键。**禁止清单配实测反例**：`claude-opus-5-5` 绝不推荐给
  `claude-opus-5`（输入输出都贵 25%）、`qwen3.8-max` 家族三行互不推荐（日期后缀）。
  运行时表才有的行（`qwen3.8-max-*`、`Doubao-Seed-2.1-Pro`）用**内联 fixture** 写死，
  不读 `$DSH_HOME`——那是本机数据，CI 上没有，读它等于让断言静默变成跳过。另覆盖折叠
  撞键的确定性消歧、自指建议过滤、纯函数性。
- **路由与写入**（`routes.test.js`）：用假 ctx + 假 server 把 `apply()` 真跑起来，
  断言三条 exact 路由的注册形状、方法闸门（新路由必须有自己的 405）、回环闸门覆盖
  写接口，以及 `{pricingFile:false, overridesFile}` 下 overrides **仍然被读**（早退
  条件只看 `pricingFile` 会让手工修正静默失效）。写入侧守路径固定（未知键一律
  `unknown-field`）、原子替换（判据是目标文件 **inode 变了**——「目录里没留 .tmp」
  杀不掉就地写）、并发 8 个 op 全部落盘（promise 链串行化）、落盘失败 500 且原文件
  不变、`version > 1` 拒绝且文件一字不动。
- **未定价区块的状态机**（`client-unpriced.test.js`）：`UnpricedSection` 从
  `src/client.js` 导出，用可重放的状态桩驱动四态（list / claim / confirm / custom）。
  搜索的四级顺序用一份四级全命中的 fixture 断言；确认框必须展示价格、写入路径与
  「只做一跳」提示；POST 的 URL / 方法 / body 逐字段断言（每次点击都像「已经写好了」，
  真正落盘的只有这一个请求）；失败留在确认态且不调 `onDone`；Escape 必须
  `stopPropagation`（否则一次 Esc 同时关掉区块与面板）。
- **回环闸门**（`screen-request.test.js`）：就是「HTTP 接口」那节的回环闸门——
  `screenRequest` 是面板唯一的安全边界。判据是三个字面量的**精确匹配**
  （`127.0.0.1` / `::1` / `::ffff:127.0.0.1`），不是网段匹配也不是前缀匹配，所以
  `127.0.0.2` 被拒是**有意为之**。最危险的边界是 IPv4-mapped 地址：
  `::ffff:127.0.0.1` 放行，而 `::ffff:192.168.1.9` 必须 403——两者只差中间几段，
  任何「前缀匹配 `::ffff:127.`」或「包含 `127.0.0.1`」的写法都会把局域网地址误判成
  本机。全部用例都是纯函数调用（注入 `{socket:{remoteAddress}}`），零网络、不起
  HTTP server。这个文件出现之前，`grep -rn screenRequest test/` 是零命中：把判据
  改成无条件放行（`const ok = true`）不会有任何测试变红。
- **浏览器端**（`client.test.js`）：`fmtTokens`、`Heatmap` 的分档与整周对齐、
  `Badge` / `Panel` 的加载态与缺失金额显示。`src/client.js` 不能 `import`，所以由
  `client-harness.js` 用 stub loader 执行源码后取出导出。
- **分模型表的分组**（`client.test.js` 的 `#9` 一组）：跨渠道明细行渲染成
  `provider/model`（否则同名重复行无从区分），跨渠道模型恰好一行非交互小计、单渠道
  一行都不多给；小计的缓存命中率是**合计缓存读 ÷ 合计提示词**而不是各行缓存命中率的平均
  （载荷刻意让两者分得很开，且避开「加权值被舍成 0% 后与平均不可区分」的量级），
  其余数值列是组内求和、cost 用已舍入值直接相加（口径与代价见
  `docs/adr/0007-model-table-partitioned-by-channel.md`）；排序作用于分组，两个方向
  下都断言渲染顺序，而不是只看 `aria-sort`；小计行不可聚焦、不带按钮。小计行也**不得**
  混进未定价提示的 token 占比——期望值从载荷现算，改 fixture 时断言跟着对。
- **跨端契约**（`contract.test.js`）：把 `src/client.js` 当文本读出字面量，与宿主端
  导出的 `BASE_PATH` / `ACTIVITY_DAYS` / `RANGE_KINDS` 比较，并断言 `API` 常量确实
  被 `fetch` 使用（存在不等于被使用），以及两条新接口路径仍是 `` `${API}…` `` 的模板串
  形态、两端的 `MAX_TEXT_LENGTH` 同值。理由见
  `docs/adr/0005-cross-end-contract-by-test.md`——浏览器端 bundle 不是 ES module，
  它的 `require` 也不认相对路径，两端无法共享代码，只能靠断言钉住一致。
- **外观**（`appearance.test.js`）：把宿主主题包当权威来源读进来，断言
  `src/client.js` 引用的每个 `--dsw-alias-*` token 都真实存在（错误 token 名此前
  写在**不导出**的 CSS 字符串里，测试够不到，见
  `docs/adr/0006-appearance-host-tokens-only.md`）；断言不存在深色专用的 `var()`
  兜底值、完全不使用 `color-mix()`；按 WCAG 相对亮度验证热力图 L1–L4 在浅色与
  深色下都相对面板底色可见、相邻档位两两可辨，且正文/次要文字都达到 4.5:1；
  以及键盘契约——`aria-sort` 真的接到排序状态、可排序表头是真实 `<button>`、
  面板是 `role="dialog"`、Esc 真的关闭、焦点进得来也回得去、`:focus-visible` 可见。
  宿主主题包不存在时，依赖它的用例会显式 `t.skip()` 并说明原因，而不是假装通过。
- **视口几何**（`viewport.test.js`）：真实 Chrome 驱动，在 480 / 768 / 900 / 1400
  四档视口下断言面板**不越出视口边界**——判据是 `getBoundingClientRect()` 的右边缘，
  刻意不用 `body.scrollWidth`：修复前的基线里面板越界 22px 与「滚动宽度比视口还窄」
  **同时成立**，基于滚动宽度的断言会放行这个 bug。另有一组用例单独守
  `@media (max-width:760px)`：只加 `box-sizing:border-box` 就已经让四档全部落在
  视口内，所以主断言区分不出 `@media` 在不在，窄视口的几何差异需要自己的断言。
  载荷里有**一个跨渠道模型**，于是分组小计与最长的 `provider/model` 名称一起进了
  这四档测量；用例同时断言这两者确实渲染出来了——否则量到的是旧布局，「不越界」就
  成了对旧代码的背书。Chrome 缺失时显式 `t.skip()` 并说明原因。

fixture 全部在测试运行时用 `zstdCompressSync` 构造，仓库里不存二进制。

### CI 与变异检查

`.github/workflows/test.yml` 有三个 job，职责不同，闸门方向也不同：

- **`test`**（主 job，Node 22 与 24 各跑一遍）：用 shell 算出的**显式文件列表**，
  把 `test/viewport.test.js` 排除在外。它**故意不用 `npm test`**：浏览器用例在拿不到
  Chrome 的环境里只能 skip，而这个 job 有一道「`skipped` 必须为 0」的硬闸门——用
  「环境缺 Chrome」去否决一批本来能跑的用例是错的。列表算空时会**显式失败**：
  `node --test` 拿不到文件参数就会退回默认发现、把 viewport 连同 `test/` 下的纯夹具
  一并偷偷跑一遍，等于绕开这套设计，而闸门看不出来。
- **`viewport`**：只跑 `test/viewport.test.js`，方向正好相反——**skip 就是失败**。
  这个 job 存在的唯一意义是量真实几何（面板有没有被切出视口），量不到就等于没验证，
  所以它先确认 Chrome 起得来，再断言 `skipped === 0`。
- **`mutation`**：跑 `npm run mutate`，验证的是**测试的质量**，不是代码的功能。

主 job 那道闸门为什么不是可选项：`node --test` 在用例被 skip 时**仍然退出 0**，
`# skipped` 与 `# fail 0` 并列。宿主的主题包读不到时，外观断言会集体 skip、CI 一片
绿，而那批断言**什么都没验证**。所以闸门不只看 `skipped`，还要求 TAP 报告存在、
汇总行齐备、且用例数不为 0——否则「报告压根没生成」也会被当成 `skipped == 0` 而假绿。

`npm run mutate` 是同一个问题的另一半答案：`npm test` 说「代码现在是对的」，变异
检查说「测试真的抓得住错」。它把源码故意改坏——缓存键、回环闸门、分档切点、排序的
null 分支、外观 token、焦点陷阱、汇率口径……——再跑一遍测试，按结果分类：

- **`KILLED`**：测试变红，说明这条行为真的有测试在守；
- **`SURVIVED`**：测试依然全绿，说明这条行为无人看守，脚本以非 0 退出，由人决定
  是补测试还是记为已知缺口；
- **`INVALID`**：变异体本身语法就错。**绝不能**当成 KILLED——那会把「整批文件
  `SyntaxError`」误读成「断言生效」，制造虚假安全感；
- **`ERROR`**：环境导致无法判定（TAP 汇总行缺失、基线里有用例被跳过等），与
  `INVALID` 一样**绝不算 KILLED**。

变异发生在 `mkdtemp` 出来的临时副本里（复制时排除 `.git`），工作区始终只读，也不需要
stryker 之类的框架。

跑它需要宿主主题包：本机装了 DSH 就有；CI 里单独全局装
`@deepseek-ai/dsh-client-ui-theme`（钉死版本）并用 `UL_THEME_PATH` 显式指路。缺了它，
外观断言只会 skip，而 skip 不会让测试失败——变异体本该变红却全绿，于是被误判成
SURVIVED（假警报）。脚本因此在基线阶段就硬断言「没有静默跳过」并拒绝继续，判据不只看
`skipped === 0`，还包括用例数不为 0、以及 TAP 里没有 `# SKIP` 痕迹：套件级
`describe.skip` 跳过的用例不计入 `# skipped` 汇总，用例数也未必为 0，得数 `# SKIP`
才看得见。

## License

MIT
