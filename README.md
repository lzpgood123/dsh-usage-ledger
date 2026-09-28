# dsh-usage-ledger

DSH 插件的本地用量面板：把会话日志里的 token 消耗按**渠道 / 模型 / 时间**聚合出来。

**零网络、零凭据、零外部依赖**——不访问任何 API，不读取任何密钥，全部数字都从本机已有的会话日志算出。

## 它做什么

- 一个 Web 面板（挂在侧边栏页脚），支持按 今日 / 近 7 天 / 本月 / 累计 / 自定义 切换
- 分渠道、分模型两张可排序明细表
- 近一年的活跃度热力图（371 天，整周对齐）
- 缓存命中率、请求数、平均每请求 token
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

价格表放在独立 JSON 文件里，改完下一次请求即生效，不用动 profile 配置、不用重启：

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

**两端共用口径，但不共享代码。** 接口前缀、范围词表、热力图天数是宿主端与浏览器端
各自写一遍的：浏览器端 bundle 是传统 `<script src>`（不是 ES module），它的 `require`
也不认相对路径，抽不出共享模块。所以靠 `test/contract.test.js` 钉住两端一致，
而不是靠抽模块。理由与代价见 `docs/adr/0005-cross-end-contract-by-test.md`。

## 结构

```
src/index.js               宿主端：挂 HTTP 路由与 /usage 命令，按范围聚合、计价
src/scan.js                会话日志扫描与聚合（多帧 zstd 解压、usage 提取）
src/client.js              浏览器端面板（手写 ModuleLoader bundle，无构建步骤）
test/scan.test.js          扫描策略：缓存、淘汰、容错
test/list-sessions.test.js 会话文件枚举与跨代去重
test/payload.test.js       载荷组装：范围折算、371 天窗口、渠道计价
test/client.test.js        浏览器端导出的纯函数与组件
test/contract.test.js      跨端契约：两端字面量必须一致（见下）
test/fixtures.js           事件构造器（运行时压缩，不入库二进制）
test/memory-source.js      内存版 Source adapter
test/client-harness.js     浏览器端 bundle 的 stub-loader 夹具
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
npm test        # node --test "test/**/*.test.js"，55 个用例
```

注意 glob 不能省：裸 `node --test` 会把 `test/` 下的**所有** `.js` 都当测试文件
跑（含 `fixtures.js`、`client-harness.js` 这两个纯夹具），用例数因此虚高。`npm test`
只跑 `*.test.js`。

覆盖：

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
- **浏览器端**（`client.test.js`）：`fmtTokens`、`Heatmap` 的分档与整周对齐、
  `Badge` / `Panel` 的加载态与缺失金额显示。`src/client.js` 不能 `import`，所以由
  `client-harness.js` 用 stub loader 执行源码后取出导出。
- **跨端契约**（`contract.test.js`）：把 `src/client.js` 当文本读出字面量，与宿主端
  导出的 `BASE_PATH` / `ACTIVITY_DAYS` / `RANGE_KINDS` 比较，并断言 `API` 常量确实
  被 `fetch` 使用（存在不等于被使用）。理由见
  `docs/adr/0005-cross-end-contract-by-test.md`——浏览器端 bundle 不是 ES module，
  它的 `require` 也不认相对路径，两端无法共享代码，只能靠断言钉住一致。

fixture 全部在测试运行时用 `zstdCompressSync` 构造，仓库里不存二进制。

## License

MIT
