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
    currency: CNY                            # 计价币种，默认 CNY
```

## HTTP 接口

```
GET /api/usage-ledger?range=today|week|month|all|custom&from=YYYY-MM-DD&to=YYYY-MM-DD
```

**只允许回环地址读取**（`127.0.0.1` / `::1`），其余来源一律 403。接口暴露的是本机全部会话的用量画像（含模型与项目规模），不该被局域网里的其他机器读到；判据是不可伪造的 peer 地址，`Host` 只作补充。

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

## 设计取舍

**不碰宿主 `settings`。** 数据源本身就是权威的：每条记录都带着实际服务该请求的 provider/model。早先的版本依赖宿主 `settings.get(ns)` 来判断路由，结果是中转站发现不了——这个依赖被整个去掉了。

**不依赖任何第三方前端组件。** 浏览器端是手写的 `__ModuleLoader__` bundle，用运行时 `createElement`，没有构建步骤、没有 JSX，也不 require 宿主的 UI primitives。此前有插件因为图标名在宿主版本间从 `IconCloseOutline16` 改成 `IconCloseOutlineRegular` 而拿到 `undefined`，React 抛错导致整个插槽静默崩溃。这里只用 React 原生元素 + 宿主 CSS 变量 + 文字符号。

**不读凭据、不发网络请求。** 面板里的通道数量就是这些——没有别的。

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
src/index.js                宿主端：挂 HTTP 路由与 /usage 命令，按范围聚合、计价
src/scan.js                 会话日志扫描与聚合（多帧 zstd 解压、usage 提取）
src/client.js               浏览器端面板（手写 ModuleLoader bundle，无构建步骤）
scripts/mutation-check.mjs  变异检查：把源码改坏，验证测试真的会红（见下）
test/scan.test.js           扫描策略：缓存、淘汰、容错
test/list-sessions.test.js  会话文件枚举与跨代去重
test/payload.test.js        载荷组装：范围折算、371 天窗口、渠道计价
test/cost-of.test.js        计价口径：缺价格或缺汇率一律留空，不拿 0 冒充免费
test/pricing-file.test.js   价格表读取与路径解析：读不到价格表只降级，绝不拖垮面板
test/screen-request.test.js 回环闸门：只放行精确回环地址，局域网一律 403
test/client.test.js         浏览器端导出的纯函数与组件
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
  被 `fetch` 使用（存在不等于被使用）。理由见
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
