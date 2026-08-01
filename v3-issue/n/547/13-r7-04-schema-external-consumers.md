# R7-04 — 公共 schema 分发与外部 consumer/producer 实存链

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 锚点：P-D1-1、P-D2-4、S1/S2 公共供给；总账 `D-04,U-01,A-02,J-01,T-01`。本报告只建立跨仓实存链、失败与版本事实，不裁决载体、不设计、不估算。

## A. 决策摘要（≤1 页）

### A1. 观察、机制与结论

基线仓存在两个相邻但不同的产物：

1. `preset compile <name|path> --json` 产生带 `schemaVersion: 1` 的 **projection instance**；
2. 源码内 `PresetCompileProjectionBoundary` / `PresetCompilePublicResultBoundary` 是 ArkType runtime boundary。

它们都不是外部可取得并派生类型的 JSON Schema。仓库是 private Bun application，不发布 package；没有 schema 文件、schema CLI、生成脚本、release artifact 或导出 package entry。唯一安装命令又指向较旧的 `/Users/mouriya/Ext/app/coder-loop@423c021...`，该运行版本连 `preset` 命令都不存在，因此 code checkout 中的 projection producer 尚不是本机稳定外部连接面。

跨仓只读核验没有发现真实 projection/schema consumer 或 typed `bindings.json` producer：

- RFC-5 GUI 仍无已定 repo owner，文档明确“monorepo 或独立 repo”尚待定；现有 GUI 只有 `.pen` 原型和设计文档，不执行 schema。
- RFC-4 hook 机制在 coder-loop 中不存在，故没有 hook consumer。
- `mouriya-s-lab/github-hapi-agent-router` 是已存在的外部连接参考，但当前链是 GitHub webhook → 自有 Zod config → HAPI target；它没有 coder-loop、compile projection、schema 或 bindings 引用。
- `mouriya-s-lab/hapi` 只出现 coder-loop worktree 示例路径，没有该契约消费。
- `prompt.md + bindings.json` 只存在于设计/原型文字；生产源码没有 writer/reader。

因此 U-01 可被收窄为：**在本机可访问、由设计明确指向的 owner/repo/installed runtime 中，未发现已实现 producer/consumer；未访问或尚未确定 owner 的未来 GUI、hook、hapi-remote-session 仍是未知，不能推成全系统不存在。**

### A2. 置信度、根因集合与影响

- **高置信度**：本仓产物、package/CLI 分发、安装运行版本、已知本地 repos、router/hapi 代码链，均由源码、remote URL 和只读命令核验。
- **中置信度**：没有本地 checkout 的 `mouriya-s-lab/hapi-remote-session` 及未知未来 GUI repo；无访问材料，保持未知。
- **根因集合而非单点缺文件**：
  1. instance 与 schema artifact 被混为相邻概念；
  2. runtime boundary 只在 private source 内，未形成发布面；
  3. code/app 双仓版本漂移使开发入口不等于 installed producer；
  4. GUI/hook/外挂 owner 尚未形成消费实现；
  5. typed bindings producer 仍只在跨 RFC 依赖文字中。
- **确定影响**：现阶段无法证明“独立 consumer 零 source import、仅靠 schema 派生”；也无法测版本兼容、缓存升级或旧 consumer 失败策略。projection 的 `schemaVersion=1` 只版本化实例 shape，不版本化一份不存在的 schema artifact。

### A3. 可保留资产、未知与后续 readiness

可保留资产：唯一 projection 函数、ArkType boundary round-trip、CLI 结构化 success/rejected、`schemaVersion` 字段、source hash、router 的独立持久队列/重试样板。

未知：未来 GUI repo/部署 owner；hapi-remote-session 真实 checkout 与接口；外部 consumer 要求的语言/生成器；schema artifact 更新/缓存/兼容策略；typed `bindings.json` 首个真实 writer/readers。

**R7-05/R7-14 可读取本报告作为存在性底图，但不能把“已知 owner 未实现”升级为 artifact 载体决定。**

---

## B. 事实链与证据

### B1. 本仓 producer 与 artifact 边界

`PresetCompileProjectionBoundary` 是源码内 ArkType object：顶层 projection 包含 `schemaVersion/preset/statuses/stateGraph/phases/tools/fragments/findings`；variables 的 type 固定 `"string"`（`src/loop.ts:531-592`）。CLI 编译后：

- 成功：stdout 只写 `publicResult.projection`；
- rejected：stderr 写 `{kind:"rejected",schemaVersion:1,diagnostics}` 并 exit 1；
- 没有 `schema` 子命令或输出模式
  （`src/loop.ts:2990-3002,3004-3059`）。

生产投影是 instance：它列出某一 preset 的实际 phases/statuses/findings，不能表达数组 item 的完整 union、required/optional、额外字段策略等 schema 元信息。测试直接 import ArkType boundary（`tests/unit/preset/compile.test.ts:5-13`），是同仓源码 consumer，不满足零 source import。

分发面核验：

```sh
cat package.json
find . -iname '*schema*.json' -o -iname '*.schema.json' -o -iname '*.d.ts'
rg -n 'json-schema|typebox|zod-to-json|arktype' package.json bun.lock
```

结果：

- `package.json` 的 `"private": true`，bin 直接指向 `src/loop.ts`；无 exports/files/publish/schema script（`package.json:1-21`）。
- 唯一匹配的 `.d.ts` 是 test matcher；无 JSON Schema artifact。
- runtime schema 依赖只有 ArkType；没有 schema exporter/generator dependency。

### B2. 安装运行 producer：code ≠ app

真实命令连接：

```sh
command -v coder-loop
file ~/.local/bin/coder-loop
cat ~/.local/bin/coder-loop
git -C /Users/mouriya/Ext/code/coder-loop rev-parse HEAD
git -C /Users/mouriya/Ext/app/coder-loop rev-parse HEAD
coder-loop preset compile --help
```

观察：

| 面 | 实存值 |
|---|---|
| code baseline | `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd` |
| app runtime | `423c021bb25e3e3cee139eabbf63ee5f0e5d2e2c` |
| installed wrapper | `exec bun /Users/mouriya/Ext/app/coder-loop/src/loop.ts "$@"` |
| installed compile | `unknown command 'preset'` |

code 与 app 的 origin 均是 `https://github.com/mouriya-s-lab/coder-loop.git`，但 installed consumer只能看到 app 版本。当前没有 version negotiation、artifact discovery 或 fallback；命令缺失直接 usage + nonzero。由此不能把 code checkout 的 CLI 当作已分发给外部 owner 的 producer。

### B3. 已知外部 owner 与连接路径

| owner/repo 或面 | owner 证据 | 当前连接路径 | schema/projection/bindings 实存 |
|---|---|---|---|
| `mouriya-s-lab/coder-loop` code/app | git origin | code 开发仓；app wrapper 运行仓 | code 有 instance producer；app 安装版无该命令；都无 schema artifact |
| RFC-5 GUI | `v3/rfc-split.md:89-101` | 预期通过未来 HTTP/WS gateway；当前 daemon 只有 Unix socket | repo/技术栈未定；无 consumer |
| RFC-4 hook | `v3/survey-engine-daemon.md:131-137` | 当前无 hook 注册/执行点 | 无 consumer |
| `mouriya-s-lab/github-hapi-agent-router` | git origin | GitHub webhook → 持久队列 → configured HTTP HAPI target | 无 coder-loop/schema/projection/bindings 引用 |
| `mouriya-s-lab/hapi` | git origin | HAPI 自身；搜索仅命中测试里的 coder-loop path 示例 | 无 consumer |
| `mouriya-s-lab/hapi-remote-session` | `v3/rfc-split.md:107-113`; `v3/children-brief.md:24` | 文档登记为 #548 外部执行线 | 本机无 checkout，真实接口未知 |
| target fixture repos | 本机 git origins | 调用 coder-loop status/daemon 的目标仓 | 只消费 operator CLI，未消费 compile projection/schema |

GUI 所需连接尚不存在的机制证据：

- daemon socket 是 newline JSON、每请求新连接；无 HTTP/WS、无订阅（`v3/survey-engine-daemon.md:121-129`）。
- GUI repo 归属仍列为“monorepo 或独立 repo”议题（`v3/rfc-split.md:95-101`）。
- 元信息预览仅登记“消费 RFC-2 编译产物”，不是实现证据（`v3/rfc-split.md:99`）。

### B4. Router 不是潜在 consumer 的实现

对 `/Users/mouriya/Ext/code/github-hapi-agent-router` 做全源码搜索：

```sh
rg -n -i 'coder-loop|preset compile|CompiledTaskModel|PresetCompileProjection|bindings.json' \
  /Users/mouriya/Ext/code/github-hapi-agent-router
```

没有匹配。其实际 config parser 是本仓自有 Zod：

- target `{url, signingSecret?, timeoutMs}`；
- route metadata 仅 `generic | iac-repo-work`；
- routing config 从 env JSON/file 读取，Zod parse 后启动
  （`github-hapi-agent-router/src/config.ts:1-80`）。

其 runtime 路径是 webhook 入队和单 consumer push loop；transport/not-consumed 会 defer，unknown target 会 drop（`src/push-loop.ts:29-83`）。这些是外部 ingress 的现存失败/重试样板，但没有读取 coder-loop projection 或从 schema 派生类型，不能算 P-D1-1 consumer。

### B5. typed bindings producer/consumer 实存

生产源码与已知外仓搜索：

```sh
rg -n --hidden \
  --glob '!**/.git/**' --glob '!**/node_modules/**' \
  --glob '!**/screenshots/**' --glob '!**/v3-issue/**' \
  'bindings\\.json|prompt\\.md' \
  /Users/mouriya/Ext/code/coder-loop \
  /Users/mouriya/Ext/app/coder-loop \
  /Users/mouriya/Ext/code/github-hapi-agent-router \
  /Users/mouriya/Ext/code/hapi
```

匹配仅为：

- `.pen` 原型文字；
- `v3/children-brief.md:23` 的 #544/#547 依赖登记；
- survey/decision 文档对未来 `prompt.md + bindings.json` 的描述。

没有 production writer、reader、schema、fixture 或运行 artifact。因此 typed bindings 的 actual producer 当前未建立；S2 的 source type flow也不能借此声称已有外部落盘 consumer。

### B6. 版本、缓存与失败策略

| 路径 | 版本标记 | 缓存/更新 | 失败策略 |
|---|---|---|---|
| compile instance | JSON field `schemaVersion:1` + `preset.sourceHash` | 每次 code CLI 现算 | success stdout；rejected stderr + exit 1 |
| ArkType boundary | 随 source commit | module load；无独立 artifact cache | assert/throw |
| installed app CLI | app git snapshot，无公开 CLI version handshake | 进程/磁盘由 app 更新控制 | 未知命令立即 nonzero；不会回退 code |
| JSON Schema artifact | 不存在 | 不存在 | 不可观察 |
| GUI/hook consumer | 不存在 | 不存在 | 不可观察 |
| router | 自有 Zod source + persisted queue | config startup parse；queue file持久化 | invalid config throw；transport defer；unknown target drop |
| bindings artifact | 不存在 | 不存在 | 不可观察 |

因此“schemaVersion=1”目前不能回答：

- consumer 如何发现/固定 schema；
- schema 与 producer binary 是否同版本；
- additive/不兼容变化如何处理；
- cached schema 何时失效；
- consumer 遇到未知 variant/字段的行为。

这些不是已证明缺陷的实现要求，而是不存在 consumer 链导致无法观测的事实空位。

### B7. 上游/历史与触发关系

现有历史材料只建立依赖，不建立代码：

1. #547 compile projection blocks #544 元信息预览、#548 外挂预校验、#543 全量元数据投影（`v3/children-brief.md:18-21`）。
2. typed `bindings.json` 形态引用 #547 typed bindings（`v3/children-brief.md:23`）。
3. router evolution 指向 `github-hapi-agent-router#12`，#548 只保留 gate 指针（`v3/children-brief.md:24`）。
4. RFC-5/6 文档把 GUI/外挂写成未来消费方，同时明确 API/repo owner仍待定（`v3/rfc-split.md:89-113`）。

因此触发顺序在事实层是：未来 consumer 需要公共 projection/schema → 当前只存在 code-side instance/boundary → 没有可运行 consumer 可验证版本/失败。不能用 issue/设计引用替代 producer/consumer path。

### B8. 根因集合与修补边界（不提出方案）

| 根因事实 | 最小修补边界必须覆盖的合同 | 明确不由本报告裁决 |
|---|---|---|
| instance 不是 schema | producer 与独立 consumer 之间存在可取得、可验证的公共合同 | CLI 还是文件/package |
| private source boundary | consumer 不 import coder-loop 私有 source/执行 ArkType | schema 技术/生成器 |
| code/app 漂移 | 对外 producer 的真实运行版本与 artifact identity 可关联 | 发布流程实现 |
| consumer owner未落地 | 至少一个真实独立 owner 走完整读取/失败路径 | GUI 仓库归属 |
| bindings 仅设计文字 | 真实 writer/reader 与 value shape 有证据 | ValueType variant 集 |
| 无兼容运行证据 | 版本变化、cache、unknown shape 的 consumer行为可观察 | 兼容政策选择 |

“修补边界”只描述当前证明断点；不等于要求所有机制由 #547 实现。跨 RFC owner 冲突仍按 AGGREGATE §6 保持待裁决。

### B9. 事实支持的形态及确定后果（不推荐）

| 形态 | 现有事实可支持程度 | 确定后果 |
|---|---|---|
| 仅 projection instance 作为外部输入 | code CLI 已有 | consumer只能自行猜/手写 shape；不能从 instance 派生完整类型 |
| 外部 consumer import ArkType source boundary | 同仓 tests 已这样做 | 与 private repo/source commit耦合；不是零 source import |
| 独立版本化 schema artifact | 当前无 producer | 能否工作、版本/cache/失败均尚无运行事实 |
| consumer 通过未来 API 获 projection/schema | GUI/ingress 文档仅登记 | 当前无网络面/owner，不能验证 |
| typed bindings 文件作为第二公共面 | 原型/文档有名称 | 当前无 writer/reader，形状与兼容性未知 |

### B10. 未知、盲区与证据索引

#### 未知/盲区

- 本机没有 `hapi-remote-session` checkout，不能核验其 source 或 package；保持未知。
- 未确定 GUI repo意味着无法给出真实 package manager、缓存层或失败 UI。
- 本次不把 Codex session/memory、`.pen` 文本或 issue body当生产 consumer。
- projection boundary 绿测只能守当前 shape round-trip，不能证明独立语言派生、artifact discoverability或版本升级。
- 全盘字符串搜索可能发现历史副本/截图；报告只把 git origin明确、production source可追踪的路径列为实存链。

#### 证据索引

| 事实 | 证据 |
|---|---|
| projection ArkType shape | `src/loop.ts:531-592` |
| CLI instance输出/命令面 | `src/loop.ts:2990-3002,3004-3059` |
| private package | `package.json:1-21` |
| tests import source boundary | `tests/unit/preset/compile.test.ts:5-13` |
| GUI/API/owner未定 | `v3/rfc-split.md:89-101` |
| 外挂参考与未来议题 | `v3/rfc-split.md:103-113` |
| hook/外部入口不存在 | `v3/survey-engine-daemon.md:121-137` |
| 跨 RFC 依赖与 bindings登记 | `v3/children-brief.md:18-24` |
| router自有 schema | `/Users/mouriya/Ext/code/github-hapi-agent-router/src/config.ts:1-80` |
| router retry/drop | `/Users/mouriya/Ext/code/github-hapi-agent-router/src/push-loop.ts:29-83` |
| installed command/version原始输出 | `/tmp/rfc547-r7-04-installed.txt` |
| 本机 repo inventory | `/tmp/rfc547-r7-04-repos.txt` |
| 精确/候选搜索记录 | `/tmp/rfc547-r7-04-likely.txt`, `/tmp/rfc547-r7-04-hits.txt` |

## 尾结论

基线只提供 private source 内的 ArkType boundary 与 code-checkout 的 projection instance；它没有可分发 schema、稳定 installed producer、真实外部 projection consumer或 typed bindings producer。已知 GUI/hook 尚未实现，现存 GitHub-HAPI router走自己的 Zod/HAPI协议而非 coder-loop schema。U-01 因而收敛为“已核验 owner中无实存链，未 checkout/未定 owner继续未知”；不能把仓内无 artifact 推成全系统不存在，也不能把 `schemaVersion:1`、绿测或设计依赖冒充跨 consumer 契约。
