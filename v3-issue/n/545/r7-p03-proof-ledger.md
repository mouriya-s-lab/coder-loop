# RFC #545 R7 P-03 — 既有/未来路径验证账

固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本账只复核 S13 与 R7 Detail 的证据强度，不形成工程分叉，不实现 read/group/evaluator，不改产品、测试、配置、生产 DB 或 `WORKFLOW.md`，不创建 worktree。

## A. 摘要

1. **S13 在固定 SHA 成立。** 隔离真实 daemon `chain.create` 测试证明新 chain 创建 `shared.md`，内容为 `# Shared durable context\n\n`；真实 scheduler prompt capture 证明 runtime path 被渲染进 prompt。另以 bundled `gh-issue-pr-iteration` 的四个真实 phase prompt 做逐 phase 渲染，`shared.md` 绝对路径分别出现 `3/3/2/2` 次，均无残留 `{{SHARED_CONTEXT_FILE}}`。
2. **S13 证明的是既有自由文件面，不是 context 替代品。** daemon 只确保文件存在；engine 只绑定路径、授予该声明文件的读写 surface 并把路径渲染进 prompt。它不把文件内容解析成 context entry，不赋予 scope、author、credential、cursor、audit 或 outcome 语义。结构化 context 反向也不取代 shared handoff；当前只有 append socket/store 基座，尚无公开 read。
3. **D-01～D-07 均有与各自问题匹配的最小地面实验。** D-07 除相关真实 integration 回归外，以真实 daemon/socket/context 与 scheduler close handler，配合 preset resolver barrier / store Proxy 断点，执行 close→complete window、complete→clear crash/restart 与 clear→revoke 同步段实验，结果 `2 pass / 0 fail / 16 expect`。七份 Detail 的最小反例/故障实验账已闭合。
4. **transport 反例口径已固定。** D-02 实测的确定反例是 262,144 个 NUL 经 JSON escaping 后形成 1,573,027-byte request，越过 1,048,576-byte request cap；astral 字符不构成必然超限。D-04 的 response 实验按序列化后 UTF-8 bytes、最终 LF 和完整 parse 计量，未重新引入 code-unit/astral 错误口径。
5. **不存在的能力只登记为无可运行路径。** 当前没有公开 context read/request/result arktype/GUI consumer，没有真实 par scheduler producer、branch credential 或 membership resolver，没有 context requirement evaluator/verdict，也没有 validator runner。相关报告没有用 store fixture、普通 read 命令、空 tools compile 或静态类型冒充这些路径已经运行。

## B. S13 runtime proof

### B1. 冻结环境

复核记录：`/tmp/rfc545-p03/environment.txt`。

```text
sha=699842eba2eefc242d19f8fa9232bc1d9d5c3bdd
branch=main
bun=1.3.14
os=Darwin 24.6.0 ... arm64
sqlite=3.43.2
```

所有新增实验产物仅位于 `/tmp/rfc545-p03/`。本账没有依赖生产 daemon 或生产 DB。

### B2. 创建证明

可复现命令：

```bash
cd /Users/mouriya/Ext/code/coder-loop
bun test ./tests/integration/daemon/chain-crud.integration.ts \
  --test-name-pattern 'socket chain.create$'
```

原始输出：`/tmp/rfc545-p03/s13-create.log`。

```text
(pass) daemon > socket chain.create
1 pass
24 filtered out
0 fail
3 expect() calls
```

该测试走 scheduler-disabled 隔离真实 daemon/socket `chain.create`，随后断言解析出的 chain runtime path 下 `shared.md` 存在且内容逐字为 `# Shared durable context\n\n`（`tests/integration/daemon/chain-crud.integration.ts:8-33`）。生产创建点为 `src/daemon.ts:2232-2243`：`ensureChainRuntimeLayout` 以 `flag:"wx"` 写初始文件，`EEXIST` 时保留既有内容；startup 对未删除 chain 复用同一 layout 确保路径（`src/daemon.ts:2246-2250`）。

### B3. prompt 注入证明

最小真实 scheduler capture：

```bash
cd /Users/mouriya/Ext/code/coder-loop
bun test ./tests/integration/scheduler/daemon-restart.integration.ts \
  --test-name-pattern 'item without per-issue handoff binds shared handoff'
```

原始输出：`/tmp/rfc545-p03/s13-prompt.log`。

```text
(pass) item without per-issue handoff binds shared handoff and empty current issue file
1 pass
5 filtered out
0 fail
5 expect() calls
```

该测试让 scheduler 真实 spawn Bun capture runner，读取 `-p` prompt，并断言其中 `shared=<resolved chain shared path>`（`tests/integration/scheduler/daemon-restart.integration.ts:169-237`）。它不是只测纯 render helper。

为避免单一合成 prompt 掩盖 bundled phase 漏绑，另执行：

```bash
cd /Users/mouriya/Ext/code/coder-loop
bun /tmp/rfc545-p03/render-all-shared.ts
```

脚本与输出：`/tmp/rfc545-p03/render-all-shared.ts`、`render-all-shared.json`。脚本加载固定 SHA 的真实 `gh-issue-pr-iteration` preset、建立隔离 chain/item，并对每个 phase 的真实 prompt 执行 `renderSchedulerSpawnPrompt`。结果：

| phase | shared path 命中数 | 残留 placeholder |
|---|---:|---|
| iteration | 3 | false |
| review | 3 | false |
| blocked-responder | 2 | false |
| umbrella-finalizer | 2 | false |

路径来源链为 `buildSchedulerResolveContext → runtime.sharedContextPath`（`src/scheduler.ts:3155-3171`）、preset phase variable `SHARED_CONTEXT_FILE = runtime.sharedContextPath`（`presets/gh-issue-pr-iteration/preset.toml:87-95,188-196,239-247,288-296`）和 prompt renderer。runner filesystem authorization 仅在 phase 声明该 binding 时增加 `shared-context` writable-file surface（`src/loop.ts:6768-6785`）。

### B4. shared 与 context 的零替代边界

| 面 | 本次证明到的实然 | 本次明确未证明、也不存在的替代关系 |
|---|---|---|
| `shared.md` | chain 级 daemon-owned 文件；daemon 创建/恢复；runtime 绑定的是绝对路径；preset 自由读写其文本 | engine 不解析其内容，不生成 context envelope，不赋予 scope/author/credential/audit/cursor/outcome，不因 S13 获得结构化 read |
| context entry | SQLite 中有 typed persisted entry 与 append begin/chunk/commit 的 socket/admission 基座 | 不读取或迁移 `shared.md` 内容；当前没有公开 context read；不能替代 preset 的 shared handoff 纪律 |

因此 D1 的并存定位在固定 SHA 上有运行证据：shared 是自由 prompt/file 注入面，context 是另一个结构化受控通道。S13 零回归不代表 context S16/S18/S20 已实现，也不代表 shared 内容获得 context 权限语义。

## C. Detail 实验覆盖矩阵

| Detail | 最小地面实验与原始证据 | 对问题的证明强度 | 未闭合处 / 测试同错限制 | P-03 判定 |
|---|---|---|---|---|
| D-01 lifecycle | `/tmp/rfc545-d01/experiment.ts`、`experiment-output.json`：只提交 soft-delete T1，重启真实 scheduler-disabled daemon，复核 deleted chain + 三类 residue；另验物理 FK cascade | 直接复现两事务间 durable 终态、restart 不收敛、orphan/cross-key list 与物理 delete 对照 | 未做指令级 SIGKILL；现有 daemon test只证明再次 delete 可清理，不能证明自动恢复 | **充分**；最小等价故障实验与主张匹配 |
| D-02 append/transport | `/tmp/rfc545-d02/experiment.ts`、`output.jsonl`、`stderr.log`：断连、restart、NUL oversize、并发 commit、commit 后断响应、audit EISDIR、特殊 argv | 同时观察 entry/audit/session/credential/caller，直接证明四介质分离与 transport cap | 现有绿色多 MB UTF-8/partial fake peer 不覆盖 JSON escaping、mutation 终态或 audit failure；报告的隔离实验补上这些反例 | **充分**；且 transport 口径正确 |
| D-03 historical rows | `/tmp/rfc545-d03/experiment.ts`、`experiment.log`，另有 parser/storage-class matrix 与只读审计脚本：合法前 + malformed + 合法后、跨 chain、v15→v16、startup、runtime store bypass | 直接证明 DB/parser 接受集差、整 chain fail-fast、跨 chain 隔离、migration/startup 保留 | 生产存量未读，故只记未知；现有 malformed unit 关闭 constraint 且不覆盖合法邻行/启动/迁移 | **充分**；生产存量没有被 fixture 冒充 |
| D-04 pagination/response | `/tmp/rfc545-d04/keyset-experiment.ts`、`keyset-output.json`：同秒 `E0`、cursor 前后 UUID、回填时间、页间 writer、held snapshot；`transport-experiment.ts`、`transport-output.json`：真实 daemon/raw/official client 1 KiB→64 MiB | 对当前可生产 key/SQLite snapshot 做最小 keyset 等价实验；对现有单行 response 完整性/LF/parse 做真实 transport 实验 | 产品没有分页/context read，故不是 S18 产品 E2E；未安全触及资源极限，不能给固定 response 上限/错误码；64 MiB 只为已测安全点 | **充分（事实层）**；不存在的 read/path 保持未运行 |
| D-05 read auth | `/tmp/rfc545-d05/`：真实 CLI fabricated env 暴露 tuple omission；raw socket对 read-no-auth/credential-gated 对照；真实 context credential lifecycle integration `5 pass/0 fail/54 assertions` | 直接证明当前 CLI credential composition、auth class差异、operator omission边界和现有 resolver 被调用时的行为 | 公开 context read不存在，故 future operator/own/cross/unknown/inactive read矩阵只能列实验合同，不能运行；普通 `chain.status/item.list` 不冒充 context read | **充分（当前身份链）/未来 read pending** |
| D-06 group lineage | `/tmp/rfc545-d06/experiment.ts`、`output.json`：nested/terminal par tree、run→leaf、direct/all ancestor候选、真实/不存在/跨chain group key direct-store roundtrip | 直接证明 durable schema表达力与 store 旁路；同时由 wire hard reject 对照确定当前两端断点 | 真实 scheduler不产生 par，故无真实 branch credential、membership resolver、join/terminal producer或并发 materialize实验；现有 group reject绿测试与缺 producer同错，不能证明 S23/S45 | **充分（可运行层）/真实 group 路径不可运行** |
| D-07 finalize/outcome | `/tmp/rfc545-d07/targeted-tests.log`：admission/startup/backoff 三个真实 integration 文件，`41 pass/0 fail/473 expect`；`finalize-window.test.ts`、`finalize-window.log`、`finalize-window-results.json`：真实 close handler + daemon/socket/context，`2 pass/0 fail/16 expect` | barrier冻结 complete前窗口时真实 credential append成功并绑定 agent author/run；释放后完成、清current并拒绝旧credential。complete已提交、clear前故障留下 completed run + stale current，restart只清current且保持run/attempt/item/context。clear hook microtask观察registry已撤销，验证clear→slot null→revoke同步段无event-loop插入点 | context requirement evaluator、validator runner不存在，故相关 outcome/tool requirement正反路径不可运行；该缺失能力不由 finalize lifecycle 实验冒充 | **充分**；现有可运行 finalize/credential/restart 故障边界均有最小地面实验 |

### C1. transport 反例口径审计

- D-02 固定 chunk 是 262,144 UTF-16 code units；wire boundary 作用于 `JSON.stringify(request) + LF` 的 UTF-8 bytes。
- 262,144 个 NUL 被 JSON 转义为 `\\u0000`，实测 request 为 **1,573,027 bytes**，daemon 在 buffer 达 1,056,768 bytes 时返回 `request_too_large`。这是确定反例。
- astral 字符虽改变 code-unit/UTF-8 比率，但不必然让该固定 chunk 超过 1 MiB；不得作为确定反例。
- D-04 response 实验以最终 wire bytes、data chunk 数、LF 位置和 official client parse 后字段长度核对；没有以 JS string length 冒充 wire size。

### C2. 测试同错总限制

现有绿色测试只在其已声明的当前行为范围内是资产：

- soft delete测试的“再次 delete 可清理”不能证明 restart 自动对账；
-普通 UTF-8 大 body 与 fake premature-close不能证明 JSON escaping cap或 commit终态；
- malformed row throw不能证明合法邻行、跨 chain、migration或未来分页错误粒度；
- group hard reject测试只能锁定当前拒绝，不能证明 group producer/resolver；
- credential测试手工传字段可绕过真实 CLI tuple composition；
- run结束后旧 credential拒绝若只在 active run已清空后执行，不能证明 child-close await window；D-07 以真实 close-handler barrier、socket append及释放后拒绝的组合实验提供该窗口证据；
- compile 空 tools、静态 ADT 或现有 event renderer都不能证明尚不存在的 requirement evaluator/verdict。

所以全套绿色测试不能替代矩阵中的最小反例；本账也没有把 `bun test` 总量作为任一未来能力的证明。

## D. 缺失能力不可运行清单

| 缺失路径 | 固定 SHA 实然断点 | 当前允许的证据表述 | 禁止冒充的替代实验 |
|---|---|---|---|
| public context read/query | daemon command table、CLI 与精确 request/result arktype均无该命令；store只有内部全 chain list | “future read最小主体/分页实验合同已定义，当前无可运行产品路径” | `chain.status`、`item.list`、direct store list、GUI shape猜测 |
| read consumer / GUI | 仓内无 context read GUI/hook consumer或已接线 boundary | “消费者不存在/仓外未知按 P-02 单独盘点” | 把 append CLI或 migration script称为用户 read consumer |
| real group scheduler | compiler/scheduler只生产当前 seq/leaf 路径；无 par materializer/updater、branch credential、membership resolver | “durable fixture可证明表达力；真实 group lifecycle 无可运行路径” | direct store构造 par、group-unavailable wire reject |
| group K4a口径 | 最近 par 与全部 par ancestors尚未裁定且无 consumer | “候选均可由 durable lineage机械恢复，产品可寻址集合未定义” | 选择一个 fixture投影后声称 membership已实现 |
| context requirement evaluator/tool verdict | 无 requirement声明、query/evaluator/verdict/event producer | “existence原料可查询但 requirement outcome 无可运行路径” | 空 tools compile、entry存在、typed event框架 |
| validator runner | validator无真实 runner/lifecycle | “validator正负 lifecycle不可运行” | 普通/item-trigger/chain-trigger runner测试 |
| chain-trigger credential/context outcome | chain-complete trigger不建立与普通 run相同的 credential/run row路径 | “当前路径差异已静态枚举；不存在同构的 context outcome运行面” | 普通 run credential测试 |
| response资源极限合同 | response无显式cap/timeout/typed oversize error；本轮安全止于64 MiB | “64 MiB范围完整；真实极限与症状未知” | 把64 MiB称为上限，或从源码猜固定错误码 |
| production malformed存量 | 未访问生产DB | “数量/variant/chain分布未知；已有只读审计脚本但未对目标路径运行” | 合法 fixture、隔离 poisoned DB |

以上缺失项仅是证据边界，不自动生成实现需求、机制或 issue。

## E. 证据索引

### E1. P-03 产物

| 证据 | 路径 |
|---|---|
| 冻结环境 | `/tmp/rfc545-p03/environment.txt` |
| S13 daemon create输出 | `/tmp/rfc545-p03/s13-create.log` |
| S13 scheduler prompt输出 | `/tmp/rfc545-p03/s13-prompt.log` |
| 四 phase render脚本/输出 | `/tmp/rfc545-p03/render-all-shared.ts`, `/tmp/rfc545-p03/render-all-shared.json` |
| Detail脚本/输出 SHA-256 | `/tmp/rfc545-p03/detail-evidence.sha256` |

### E2. Detail 原始实验

| Detail | 路径 |
|---|---|
| D-01 | `/tmp/rfc545-d01/experiment.ts`, `/tmp/rfc545-d01/experiment-output.json` |
| D-02 | `/tmp/rfc545-d02/experiment.ts`, `/tmp/rfc545-d02/output.jsonl`, `/tmp/rfc545-d02/stderr.log` |
| D-03 | `/tmp/rfc545-d03/experiment.ts`, `/tmp/rfc545-d03/experiment.log`, `parser-matrix.*`, `storage-class-matrix.*`, `read-only-audit.ts` |
| D-04 | `/tmp/rfc545-d04/keyset-experiment.ts`, `keyset-output.json`, `transport-experiment.ts`, `transport-output.json` |
| D-05 | `/tmp/rfc545-d05/probe.ts`, `probe.out`, `audit.json`, `context-test.out` |
| D-06 | `/tmp/rfc545-d06/experiment.ts`, `/tmp/rfc545-d06/output.json` |
| D-07 | `/tmp/rfc545-d07/targeted-tests.log`, `/tmp/rfc545-d07/source-evidence.txt`, `/tmp/rfc545-d07/finalize-window.test.ts`, `/tmp/rfc545-d07/finalize-window.log`, `/tmp/rfc545-d07/finalize-window-results.json` |

### E3. 正式报告与源码锚点

- 设计与证明义务：`aggregate.md:17,44,66,199-204`；`r6-detail-index.md:196-204,224-226,272-277`。
- Detail：`r7-d01-lifecycle.md` 至 `r7-d07-finalize-outcome.md`。
- shared创建：`src/daemon.ts:2232-2250`；path：`src/runtime-paths.ts:21,179`。
- runtime binding/render：`src/loop.ts:6103-6161,6768-6785`；`src/scheduler.ts:3128-3142,3155-3171`。
- bundled binding与prompt使用：`presets/gh-issue-pr-iteration/preset.toml:87-95,188-196,239-247,288-296`；`iter-entry.md:60,147`；`review-entry.md:41,155`；`blocked-responder-entry.md:42`；`umbrella-finalizer-entry.md:22`。
- S13测试：`tests/integration/daemon/chain-crud.integration.ts:8-33`；`tests/integration/scheduler/daemon-restart.integration.ts:169-237`。

---

**完整交付：** 已在冻结 SHA 复核 S13 创建、最小 scheduler prompt capture 与 bundled 四 phase 注入；钉住 shared/context 零替代边界；逐项审计 D-01～D-07 的最小地面实验、原始产物、证明强度、缺口与测试同错；确认 transport 确定反例为 JSON 控制字符转义膨胀；把 read/group/requirement evaluator/validator 等缺失能力严格记为无可运行路径。最终状态是：**S13 闭合，D-01～D-07 的可运行事实层均有匹配的最小地面实验并闭合；不存在的能力仍只记无可运行路径。**
