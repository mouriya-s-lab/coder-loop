# #549 v3 编译管线：CompiledTaskModel 与 `preset compile --json` 稳定编译产物

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:11:53Z  | updated: 2026-07-15T14:00:01Z
- closed: 2026-07-15T13:59:37Z  | state_reason: `completed`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/549
- comments: 7  | timeline events: 52

---

## Body

## 必须先读的关联 issue

#547（RFC: v3 类型系统）。本 child 承接其裁决 A，逐字快照：

> "装载即编译：canonical `CompiledTaskModel`（内存 ADT）+ `coder-loop preset compile <name|path> --json` 版本化公共投影（带 `schemaVersion`），按需计算不落缓存" / 理由："单一事实源是定义文件本身；公共 DTO 与内存模型同源但不强求同 shape，必须由唯一投影函数与 boundary round-trip 守护" — #547 裁决记录 A

产物形态契约，逐字快照：

> "JSON 产物六块：`preset` 元信息（name/dir/源 hash）；`statuses` + `stateGraph`（节点=状态分类，边=「哪个 phase 的哪个 exit 写它」+ 引擎自有转移 entry/exhausted/unblock）；`phases`（exits/trigger/runner/model/typed variables/toolRequirements/rights）+ 任务树结构（#546 的 phase 层 seq/par 树）；`tools`；`fragments`；`findings`（warn 全列；失败进入 `rejected(non-empty diagnostics)`，不以 throw message 承载契约）" — #547 核心设计·编译管线

## 目标

把既有装载路径（parse → 局部校验 → 跨表校验 → typed `Preset` ADT）正名为编译管线，产出 canonical `CompiledTaskModel`，再经唯一 projection 函数由 `coder-loop preset compile <name|path> --json` 导出带 `schemaVersion` 的稳定公共 DTO。成功与失败均使用 typed `CompileResult`/diagnostic ADT，不靠 exception 文本传递契约。

## 使用场景

- #544 GUI 元信息预览、#543 hook 全量元数据投影、#548 外挂消费 daemon 的请求预校验，三方消费同一份 JSON 产物（#547 接口假设已钉，本 child 是这三条下游的唯一硬上游）。
- operator 在本地对任意 preset 跑 `preset compile --json`，不起 daemon 即可看到状态图、phase 声明、findings——preset 作者的定义期反馈回路。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main@a007fa4（2026-07-02 核实；下列行号实施前自行 grep 核对）。

- 装载路径现状：`parsePreset`（`src/loop.ts:4085`），arktype 边界 parse（`PresetTomlBoundary` 等，`src/loop.ts:460-488`）+ 约 15 条局部校验，跨表 DAG 校验 `checkPresetDag`（`src/preset-dag-check.ts:83`，#408：error verdict throw、warn verdict 经 observability callback 冒泡）。
- #454 后 daemon 校验、scheduler 调度、渲染、CLI 查询已唯一消费 typed `Preset` 产物（#453 T2）——「装载即编译」的内存半边已存在。
- 无任何 compile/preview CLI 面：`grep -rn "preset compile\|presetCompile" src/` 零命中（2026-07-02 核实）。
- stateGraph 所需数据全部已在 ADT 内可计算：phase exits（`[[phases.exits]]` discriminated union，`src/loop.ts:565-576`）、引擎自有转移——entry 恢复（`preset.statuses.entry` + `scheduler.recovery-entry-restore` / `scheduler.dependency-unblock-restore` 审计源，`src/scheduler.ts:1735`、`src/runtime-data.ts:38`）、exhausted 写入（`src/scheduler.ts:727-738`）。
- status 快照的先例形态：`buildCoderLoopStatusSnapshot` 经 `StatusSnapshotBoundary` arktype 校验后输出——编译产物照此模式（schema 即契约）。

## 问题

编译产物只存在于进程内存，外部消费者拿不到；findings 只在装载现场一次性冒泡，无可重查的稳定面。

> "缺口：产物不可导出（无任何 compile/preview CLI 面）" — #547 定位事实

#544 的元信息预览、#543 的元数据投影、#548 的请求预校验都以「存在稳定编译产物」为前提，当前全部无法启动。

## 预期结果

性质表述：

1. **单一计算路径**：daemon/scheduler/渲染消费 canonical `CompiledTaskModel`；`preset compile` 只调用该模型的唯一公共投影函数——不存在「导出用」与「运行用」两套解析/校验代码。
2. **schema 即契约、模型与 DTO 分层**：JSON shape 由导出的边界 schema 定义，TS 消费端类型从该 schema 派生；公共 DTO 与内存模型同源但不要求同 shape。产物携带 `schemaVersion`，shape 演进时 bump。
3. **六块齐全**：`preset` / `statuses`+`stateGraph` / `phases` / `tools` / `fragments` / `findings` 全部在场。本 child 落地时的基线内容：任务树为退化线性 seq（树声明面归后续 child）、variables 每项携带 `type` 字段（既有未类型化绑定 = `"string"` 基线）、`tools` 为空表、`toolRequirements` 缺位可为空——shape 位置齐、内容由后续 children additive 真实化，不 bump 出不兼容变更。
4. **失败语义**：编译返回封闭 ADT：`compiled(model, warnings)` 或 `rejected(non-empty diagnostics)`；CLI 对 rejected 非零退出并输出结构化 diagnostics，warn 全列；任何消费者不得解析 throw message。
5. **稳定 identity**：任务树每个可引用节点的 identity 进入 canonical model 与公共投影，供 SQLite/status/events 后续沿用；匿名结构路径不得成为 identity。

### 显式决策项（RFC 开放问题分配，落地时裁，裁决留本 thread）

- `preset compile` findings 与 doctor 的关系：doctor 是否吸收 compile findings 作为其 preset 健康节。

### 与 #605 的 scope 边界（操作员裁决 2026-07-11，权威记录 `v3/definition-pin-decision.md`）

裁决 A 的「单一事实源是定义文件本身；按需计算不落缓存」限定于**当前文件问题**——「该 preset 现在说什么」：`preset compile` CLI、新实例创建、ingress 预校验。**运行中实例的事实源是其创建时 pin 的定义**（源 bundle 内容寻址快照，#605 交付），本 child 不实现 pin 面。两问题答案不同、不冲突。对本 child 的具体义务：唯一投影函数产出的 canonical projection 必须确定性（同源同 schemaVersion → 字节稳定），因为它是 #605 闭集语义 hash 的输入。

## 不应残留

- 本 child 范围内：不留第二套 preset 解析/校验路径；不留「运行时发现式」校验的新增点。
- 范围之外不动：scheduler 调度语义、preset.toml schema（除产物导出所需的零星元数据）、daemon 准入门、#534 audit 树正在修的 v2 缺陷。

## 约束

- 代码红线（#547 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。"
- #453 契约 T1-T5 延续；引擎层禁止 `gh-issue-pr-iteration` 字面量（CLAUDE.md Conventions）。
- 编译产物是跨 RFC 消费契约：shape 变更必须走 `schemaVersion`，PR body 显式列 shape diff（#456 先例）。

## 本 issue 的验证边界

- **验证层级**：静态类型、单元/contract、boundary round-trip；涉及真实 daemon 边界时增加最小进程级 integration fixture。
- **本 issue 必须证明**：正文定义的输入能产生精确稳定输出，非法/缺失输入在指定边界被拒绝，下游可直接消费而不猜字段或增加私有 fallback。
- **不在本 issue 内执行**：不运行整个 v3 场景，不运行 `scripts/real-e2e.ts`。多个编译/边界产物合流后的真实消费由 #684 证明；现有 GitHub preset 兼容性由 #685 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 产物可导出且六块齐全（RFC 关闭验证行 1） | `coder-loop preset compile gh-issue-pr-iteration --json \| jq '.schemaVersion, (.stateGraph.edges \| length), (.phases[0].variables[0].type)'` | local | schemaVersion 输出；边数 > 0；变量带 type 字段 |
| function | 六块键全部在场 | `coder-loop preset compile gh-issue-pr-iteration --json \| jq 'keys'` | local | 含 preset/statuses/stateGraph/phases/tools/fragments/findings |
| function | invalid preset → 非零退出 + 结构化错误 | 对故意破坏的 fixture preset 跑 `preset compile --json`；`echo $?` | local | 退出码非 0，stderr/输出点名违规校验规则 |
| function | warn findings 全列 | 对含 dead-vocabulary（#408 R3 fixture 形态）的 fixture preset 跑 compile | local | `findings` 块含该 warn，进程退出码 0 |
| integration | 运行时与导出同源 | 单元测试断言 daemon/scheduler 消费的 Preset 与 compile 产物来自同一构造函数（无第二 parse 入口）；`grep` 证明 compile 命令实现调用既有 load 路径 | local | 测试绿；无平行解析函数 |
| integration | 公共投影可独立消费 | success/rejected 两分支 boundary round-trip；独立 fixture consumer 仅由导出 schema 读取 | local | 无 exception 文本解析、私有字段猜测或内存模型依赖 |
| integration | node identity 可承接 | 编译含嵌套树的 fixture，序列化再 parse | local | 每个可引用节点 identity 稳定且唯一，往返不变 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: 无（本树地基 child，先行）。
- Blocks: #582（#544 元信息预览）、#587（#543 全量元数据投影）、#570（#548 外挂请求预校验）、#605（运行实例绑定事前可计算的不可变执行定义）——前三条是总控简报已钉的跨 RFC 边，#605 消费本 child 的规范化编译产物与公共投影。
- Blocks（树内）: #552（变量绑定类型流）、#553（[[tools]] 编译）、#554（phase 任务树声明面）、#555（具名 gate 点声明位）、#556（dead-fragment 检查与 plan 面退役）——它们向本产物 shape 内填充真实内容。


---

## Comments (7)

### comment #4865081552 by `RiriAgent` — 2026-07-02T11:14:34Z

## 架构切片

1. **系统定位**：三层模型（CLAUDE.md L1/L2/target）中 L1 引擎的编译管线出口级——parse → 校验 → CompiledTaskModel 之后新增「产物导出」一级；不新增管线级，只给既有终点开稳定出口。
2. **全局坐标**：任务定义域（不可信 TOML，arktype 边界 parse 点在 `parsePreset`）→ 引擎 typed 域（CompiledTaskModel）→ 外部消费者域（JSON 产物，`schemaVersion` 契约边界）。信任级在第一个边界升格后不再回降——产物是 typed 域的投影，不是二次 parse。
3. **类型↔值不漂移**：防值漂移——「导出产物」与「运行时判定」若各自计算即出现同值双副本失同步；性质 1（单一计算路径）封死。同时防类型泄露——消费端（#544/#543/#548）从产物 schema 派生类型，不得手写第二份 shape。
4. **消除的错误类别**：「外部消费者逆向 preset 语义各自实现半个编译器」从可能变为不必要；「产物与运行时行为不一致」不可表达（同源）。

## log/观测义务

- compile 的 error/warn findings 沿既有 `checkPresetDag` observability callback 形态冒泡；CLI `preset compile` 本身是只读命令，结果经 stdout JSON + 退出码交付。
- 无新增运行期事件义务（daemon 路径不变）。



### comment #4953810448 by `RiriAgent` — 2026-07-13T02:11:12Z

<!-- coder-loop:executable-contract schema=1 source-issue=549 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/549
- Observed body update timestamp: `2026-07-11T10:10:25Z`
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/549#issuecomment-4865081552
- Investigated source revision: `mouriya-s-lab/coder-loop@f01560d5d0b324e791db7f599e502f09fc78a652`

## Deliverable

`implementation-pr`

Open one new PR closing only #549. The prior closing PR https://github.com/mouriya-s-lab/coder-loop/pull/658 is closed without merge and is evidence, not an open implementation route. Implement the canonical `CompiledTaskModel`, closed typed compile result/diagnostic channel, unique versioned public projection, and `coder-loop preset compile <name|path> --json` from the same compiler consumed by runtime. Keep #552–#556 additive content and #605 instance-definition pinning out of scope.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit / output |
|---|---|---|---|---|
| C549-01 | public valid projection | shell | `coder-loop preset compile gh-issue-pr-iteration --json | jq -e '.schemaVersion == 1 and (.preset | has("name") and has("dir") and has("sourceHash")) and (.statuses | type == "object") and (.stateGraph.edges | length > 0) and (.phases | length > 0) and (.phases[0].variables | all(.type == "string")) and (.tools | type == "array" or type == "object") and (.fragments | type == "array") and (.findings | type == "array")'`; cwd repo root; package bin on `PATH` | exit `0`; all versioned six-block projection assertions true |
| C549-02 | top-level contract shape | shell | `coder-loop preset compile gh-issue-pr-iteration --json | jq -e 'keys == ["findings","fragments","phases","preset","schemaVersion","stateGraph","statuses","tools"]'`; cwd repo root | exit `0`; exact schema-v1 top-level keys |
| C549-03 | rejected diagnostic channel | shell | `coder-loop preset compile test-fixtures/preset-compile/invalid --json > /tmp/coder-loop-549-invalid.stdout 2> /tmp/coder-loop-549-invalid.stderr; code=$?; test "$code" -ne 0 && test ! -s /tmp/coder-loop-549-invalid.stdout && jq -e '.kind == "rejected" and (.diagnostics | length > 0) and all(.[]; (.verdict == "error") and (.rule | type == "string") and (.message | type == "string"))' /tmp/coder-loop-549-invalid.stderr`; cwd repo root | exit `0`; compile itself exits nonzero and emits only structured non-empty rejection diagnostics, never a generic throw-message contract |
| C549-04 | warning completeness | shell | `coder-loop preset compile test-fixtures/preset-compile/warning --json | jq -e '.findings | any(.verdict == "warn" and .rule == "dead-vocabulary")'`; cwd repo root | exit `0`; warning preset compiles successfully and exposes the warning in `findings` |
| C549-05 | deterministic identity/projection | shell | `bun test src/preset-compile.test.ts`; cwd repo root | exit `0`; boundary round-trips both result variants; repeated direct/materialized compilation is byte-identical; source text containing its own absolute directory is preserved; task-node identities live in the canonical model, remain unique/stable through JSON round-trip and sibling insertion/reordering, and are projected unchanged rather than derived from position |
| C549-06 | single compiler path | shell | `rg -n 'parsePreset\(' src --glob '*.ts'`; cwd repo root | exit `0`; exactly one production invocation remains and it is owned by the canonical compiler; runtime load and CLI projection both enter through that compiler, with no export-only parser/validator |
| C549-07 | typed boundaries | shell | `bun run typecheck`; cwd repo root | exit `0`; compile CLI args, source resolution, compile result, diagnostics and DTO projection all retain precise boundary-derived types |
| C549-08 | full regression | shell | `bun test`; cwd repo root | exit `0`; full suite green; base/head inventory reports added/removed/renamed/skipped/weakened tests, with no weakened assertion used to obtain green |
| C549-09 | operator CLI runtime | shell | `coder-loop preset compile gh-issue-pr-iteration --json >/tmp/coder-loop-549-a.json && coder-loop preset compile gh-issue-pr-iteration --json >/tmp/coder-loop-549-b.json && cmp /tmp/coder-loop-549-a.json /tmp/coder-loop-549-b.json`; cwd repo root; package bin on `PATH` | exit `0`; two one-shot operator invocations produce byte-identical JSON |
| C549-10 | real engine loading path | shell | `bun scripts/real-e2e.ts`; cwd repo root; active `RiriAgent` gh auth and fixture access | exit `0`; isolated daemon tears down cleanly, fixture issue is `CLOSED`, closing PR is `MERGED`, proving runtime consumption of the compiled model did not regress |

## Pattern scope

| Type | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|
| changed | added `any`, broad `object`/`Object`/`{}`, unchecked map/JSON shapes, or anonymous DTO/result shapes in the #549 diff | none; external input must be parsed by named arktype boundaries and internal variants must be named ADTs | zero newly added loose/untyped shapes; exported TS DTO types derive from the public boundary schema |
| changed | added `unknown` | only `catch` bindings and the immediate untrusted boundary-parse input | every occurrence is narrowed/parsed at that boundary and does not flow into compiler internals |
| changed | true `as` assertions (excluding `as const`) | none | zero newly added true assertions or double-cast escapes |
| changed | compile-result control flow based on exception text, `.message` parsing, broad catch-and-continue, or silent fallback/default diagnostics | none | expected failures are exhaustively represented as `compiled(model, warnings)` or `rejected(non-empty diagnostics)`; impossible states fail at their boundary |
| whole-tree | production calls matching `parsePreset(` | the canonical compiler implementation only | exactly one production parse call; `loadPreset`, daemon/scheduler consumers, and compile CLI share that compiler rather than parallel load/export pipelines |
| changed | task identity derived from array index, anonymous structural path, or projection-only synthesis (for example `/task/0`) | none | each referable task node owns a stable semantic identity in `CompiledTaskModel`; projection copies it unchanged and tests cover reorder/insertion stability |
| changed | unconditional replacement of absolute preset-directory strings inside arbitrary prompt/fragment content | source-aware materialization of the reserved `{{PRESET_ROOT}}` token only | literal user content is preserved; direct and materialized compilation of the same source yield identical schema-v1 bytes/hash |
| changed | hard-coded `gh-issue-pr-iteration`, phase names, status literals, known binding keys, or GitHub fields in engine/compiler code | none outside preset fixtures/tests that intentionally assert their own declarations | compiler derives all business vocabulary and graph edges from the loaded preset plus explicitly modeled engine transitions |

## Canonical runtime

- Setup: from repo root at the implementation head, run `bun install --frozen-lockfile`; expose the package bin so `coder-loop` executes this checkout's `src/loop.ts`; verify `gh auth status` keeps `RiriAgent` active before the GitHub fixture run.
- Start: `preset compile` is a one-shot CLI and has no resident service. Invoke the literal valid, invalid, warning, and deterministic commands in C549-01 through C549-04 and C549-09. For the runtime loading path, C549-10 is the target-mandated real E2E driver and starts its own isolated daemon/chain.
- Readiness: a successful compile invocation exits `0`, writes one schema-v1 JSON document to stdout, and writes no error payload; rejected input exits nonzero with the structured rejection document on stderr.
- Behavior: inspect valid six-block projection, warning preservation, closed rejection diagnostics, deterministic bytes, stable canonical node identities, and the real daemon → agent → merged PR → closed issue path.
- Logs/evidence: retain command, cwd, source SHA, exit code, stdout/stderr and test inventory under `/Users/mouriya/.coder-loop/loop-data/chains/v3-549/evidence/549`; the real-E2E transcript must name fixture issue/PR terminal states.
- Stop ownership: direct compile processes own no persistent resources. `scripts/real-e2e.ts` owns and must complete daemon shutdown, fixture cleanup and mutex release; iteration must not leave a production `~/.coder-loop` daemon mutation as evidence.

## Test delta

`required`

Add focused compile-boundary/projection fixtures and tests for valid, rejected and warning results; exact public boundary round-trip; deterministic direct/materialized bytes; literal-path-content preservation; semantic identity uniqueness and reorder/insertion stability; malformed CLI shape; and non-`ENOENT` source-resolution rejection. Existing tests may change only where the canonical model type requires construction updates. Surviving integrity rule: do not delete, skip, rename away, loosen, or replace existing behavioral assertions merely to pass; report base/head inventory and keep the full suite plus real E2E green.

## Dependencies

- Authoritative design upstream: #547, especially decision A quoted in #549; it fixes load-as-compile, model/DTO separation, the six projection blocks, typed diagnostics, and on-demand/no-cache semantics.
- Definition-pin boundary: `v3/definition-pin-decision.md` and #605. #549 must produce deterministic current-definition projection bytes, but must not implement persisted running-instance pinning.
- Downstream blockers: #582, #587, #570 and tree children #552–#556 consume this contract additively; they do not block #549.
- Current source fact at `f01560d`: `src/loop.ts` exposes `PresetTomlBoundary`, `Preset`, `loadPreset`, `parsePreset`, and `StatusSnapshotBoundary`; `loadPreset` performs prompt/fragment readability plus DAG/placeholder validation, while root usage has no `preset` command. This existing path is the compiler input to consolidate, not a second implementation to preserve.
- Prior implementation evidence: PR #658 is closed unmerged at `6ce8a6663e3c6454d74f6c3b4e41f16dab34b098`. Its review comments identify concrete hazards this fresh implementation must cover: typed CLI arg boundary, canonical rather than projection-only task identity, literal-safe materialization normalization, and typed non-`ENOENT` source failures. No open linked PR or branch is available to continue.
- External runtime dependency for C549-10: network access, active `RiriAgent` GitHub CLI auth, and writable `mouriya-s-lab/coder-loop-e2e-fixture`; the harness itself provides serialized fixture access and isolated loop-data teardown.

## Supersedes

`none`



### comment #4954053225 by `RiriAgent` — 2026-07-13T03:04:50Z

<!-- coder-loop:executable-contract schema=1 source-issue=549 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/549
- Observed body update timestamp: `2026-07-11T10:10:25Z`
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/549#issuecomment-4865081552
- Investigated source revision: `mouriya-s-lab/coder-loop@f01560d5d0b324e791db7f599e502f09fc78a652`

## Deliverable

`implementation-pr`

Open one new PR closing only #549. The prior closing PR https://github.com/mouriya-s-lab/coder-loop/pull/658 is closed without merge and is evidence, not an open implementation route. Implement the canonical `CompiledTaskModel`, closed typed compile result/diagnostic channel, unique versioned public projection, and `coder-loop preset compile <name|path> --json` from the same compiler consumed by runtime. Keep #552–#556 additive content and #605 instance-definition pinning out of scope.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit / output |
|---|---|---|---|---|
| C549-01 | public valid projection | shell | `coder-loop preset compile gh-issue-pr-iteration --json | jq -e '.schemaVersion == 1 and (.preset | has("name") and has("dir") and has("sourceHash")) and (.statuses | type == "object") and (.stateGraph.edges | length > 0) and (.phases | length > 0) and (.phases[0].variables | all(.type == "string")) and (.tools | type == "array" or type == "object") and (.fragments | type == "array") and (.findings | type == "array")'`; cwd repo root; package bin on `PATH` | exit `0`; all versioned six-block projection assertions true |
| C549-02 | top-level contract shape | shell | `coder-loop preset compile gh-issue-pr-iteration --json | jq -e 'keys == ["findings","fragments","phases","preset","schemaVersion","stateGraph","statuses","tools"]'`; cwd repo root | exit `0`; exact schema-v1 top-level keys |
| C549-03 | rejected diagnostic channel | shell | `coder-loop preset compile test-fixtures/preset-compile/invalid --json > /tmp/coder-loop-549-invalid.stdout 2> /tmp/coder-loop-549-invalid.stderr; code=$?; test "$code" -ne 0 && test ! -s /tmp/coder-loop-549-invalid.stdout && jq -e '(.kind == "rejected") and (.diagnostics | length > 0) and (.diagnostics | all(.[]; (.verdict == "error") and (.rule | type == "string") and (.message | type == "string")))' /tmp/coder-loop-549-invalid.stderr`; cwd repo root | exit `0`; compile itself exits nonzero and emits only structured non-empty rejection diagnostics, never a generic throw-message contract |
| C549-04 | warning completeness | shell | `coder-loop preset compile test-fixtures/preset-compile/warning --json | jq -e '.findings | any(.verdict == "warn" and .rule == "dead-vocabulary")'`; cwd repo root | exit `0`; warning preset compiles successfully and exposes the warning in `findings` |
| C549-05 | deterministic identity/projection | shell | `bun test src/preset-compile.test.ts`; cwd repo root | exit `0`; boundary round-trips both result variants; repeated direct/materialized compilation is byte-identical; source text containing its own absolute directory is preserved; task-node identities live in the canonical model, remain unique/stable through JSON round-trip and sibling insertion/reordering, and are projected unchanged rather than derived from position |
| C549-06 | single compiler path | shell | `rg -n 'parsePreset\(' src --glob '*.ts'`; cwd repo root | exit `0`; exactly one production invocation remains and it is owned by the canonical compiler; runtime load and CLI projection both enter through that compiler, with no export-only parser/validator |
| C549-07 | typed boundaries | shell | `bun run typecheck`; cwd repo root | exit `0`; compile CLI args, source resolution, compile result, diagnostics and DTO projection all retain precise boundary-derived types |
| C549-08 | full regression | shell | `bun test`; cwd repo root | exit `0`; full suite green; base/head inventory reports added/removed/renamed/skipped/weakened tests, with no weakened assertion used to obtain green |
| C549-09 | operator CLI runtime | shell | `coder-loop preset compile gh-issue-pr-iteration --json >/tmp/coder-loop-549-a.json && coder-loop preset compile gh-issue-pr-iteration --json >/tmp/coder-loop-549-b.json && cmp /tmp/coder-loop-549-a.json /tmp/coder-loop-549-b.json`; cwd repo root; package bin on `PATH` | exit `0`; two one-shot operator invocations produce byte-identical JSON |
| C549-10 | real engine loading path | shell | `bun scripts/real-e2e.ts`; cwd repo root; active `RiriAgent` gh auth and fixture access | exit `0`; isolated daemon tears down cleanly, fixture issue is `CLOSED`, closing PR is `MERGED`, proving runtime consumption of the compiled model did not regress |

## Pattern scope

| Type | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|
| changed | added `any`, broad `object`/`Object`/`{}`, unchecked map/JSON shapes, or anonymous DTO/result shapes in the #549 diff | none; external input must be parsed by named arktype boundaries and internal variants must be named ADTs | zero newly added loose/untyped shapes; exported TS DTO types derive from the public boundary schema |
| changed | added `unknown` | only `catch` bindings and the immediate untrusted boundary-parse input | every occurrence is narrowed/parsed at that boundary and does not flow into compiler internals |
| changed | true `as` assertions (excluding `as const`) | none | zero newly added true assertions or double-cast escapes |
| changed | compile-result control flow based on exception text, `.message` parsing, broad catch-and-continue, or silent fallback/default diagnostics | none | expected failures are exhaustively represented as `compiled(model, warnings)` or `rejected(non-empty diagnostics)`; impossible states fail at their boundary |
| whole-tree | production calls matching `parsePreset(` | the canonical compiler implementation only | exactly one production parse call; `loadPreset`, daemon/scheduler consumers, and compile CLI share that compiler rather than parallel load/export pipelines |
| changed | task identity derived from array index, anonymous structural path, or projection-only synthesis (for example `/task/0`) | none | each referable task node owns a stable semantic identity in `CompiledTaskModel`; projection copies it unchanged and tests cover reorder/insertion stability |
| changed | unconditional replacement of absolute preset-directory strings inside arbitrary prompt/fragment content | source-aware materialization of the reserved `{{PRESET_ROOT}}` token only | literal user content is preserved; direct and materialized compilation of the same source yield identical schema-v1 bytes/hash |
| changed | hard-coded `gh-issue-pr-iteration`, phase names, status literals, known binding keys, or GitHub fields in engine/compiler code | none outside preset fixtures/tests that intentionally assert their own declarations | compiler derives all business vocabulary and graph edges from the loaded preset plus explicitly modeled engine transitions |

## Canonical runtime

- Setup: from repo root at the implementation head, run `bun install --frozen-lockfile`; expose the package bin so `coder-loop` executes this checkout's `src/loop.ts`; verify `gh auth status` keeps `RiriAgent` active before the GitHub fixture run.
- Start: `preset compile` is a one-shot CLI and has no resident service. Invoke the literal valid, invalid, warning, and deterministic commands in C549-01 through C549-04 and C549-09. For the runtime loading path, C549-10 is the target-mandated real E2E driver and starts its own isolated daemon/chain.
- Readiness: a successful compile invocation exits `0`, writes one schema-v1 JSON document to stdout, and writes no error payload; rejected input exits nonzero with the structured rejection document on stderr.
- Behavior: inspect valid six-block projection, warning preservation, closed rejection diagnostics, deterministic bytes, stable canonical node identities, and the real daemon → agent → merged PR → closed issue path.
- Logs/evidence: retain command, cwd, source SHA, exit code, stdout/stderr and test inventory under `/Users/mouriya/.coder-loop/loop-data/chains/v3-549/evidence/549`; the real-E2E transcript must name fixture issue/PR terminal states.
- Stop ownership: direct compile processes own no persistent resources. `scripts/real-e2e.ts` owns and must complete daemon shutdown, fixture cleanup and mutex release; iteration must not leave a production `~/.coder-loop` daemon mutation as evidence.

## Test delta

`required`

Add focused compile-boundary/projection fixtures and tests for valid, rejected and warning results; exact public boundary round-trip; deterministic direct/materialized bytes; literal-path-content preservation; semantic identity uniqueness and reorder/insertion stability; malformed CLI shape; and non-`ENOENT` source-resolution rejection. Existing tests may change only where the canonical model type requires construction updates. Surviving integrity rule: do not delete, skip, rename away, loosen, or replace existing behavioral assertions merely to pass; report base/head inventory and keep the full suite plus real E2E green.

## Dependencies

- Authoritative design upstream: #547, especially decision A quoted in #549; it fixes load-as-compile, model/DTO separation, the six projection blocks, typed diagnostics, and on-demand/no-cache semantics.
- Definition-pin boundary: `v3/definition-pin-decision.md` and #605. #549 must produce deterministic current-definition projection bytes, but must not implement persisted running-instance pinning.
- Downstream blockers: #582, #587, #570 and tree children #552–#556 consume this contract additively; they do not block #549.
- Current source fact at `f01560d`: `src/loop.ts` exposes `PresetTomlBoundary`, `Preset`, `loadPreset`, `parsePreset`, and `StatusSnapshotBoundary`; `loadPreset` performs prompt/fragment readability plus DAG/placeholder validation, while root usage has no `preset` command. This existing path is the compiler input to consolidate, not a second implementation to preserve.
- Prior implementation evidence: PR #658 is closed unmerged at `6ce8a6663e3c6454d74f6c3b4e41f16dab34b098`. Its review comments identify concrete hazards this fresh implementation must cover: typed CLI arg boundary, canonical rather than projection-only task identity, literal-safe materialization normalization, and typed non-`ENOENT` source failures. No open linked PR or branch is available to continue.
- Re-enrichment fact: iteration run `run-1783908705935-11-iteration-item-1` left an uncommitted implementation in this issue worktree after focused tests, typecheck, the 511-test suite, direct CLI checks, and real E2E passed. It intentionally created no commit or PR because the superseded C549-03 jq predicate was malformed; the corrected predicate above was re-driven against that exact typed rejection and exits `0`. Resume this issue worktree rather than discarding or recreating those user-owned changes.
- External runtime dependency for C549-10: network access, active `RiriAgent` GitHub CLI auth, and writable `mouriya-s-lab/coder-loop-e2e-fixture`; the harness itself provides serialized fixture access and isolated loop-data teardown.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/549#issuecomment-4953810448



### comment #4954515148 by `RiriAgent` — 2026-07-13T04:44:23Z

<!-- coder-loop:executable-contract schema=1 source-issue=549 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/549
- Observed body update timestamp: `2026-07-11T10:10:25Z`
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/549#issuecomment-4865081552
- Investigated source revisions: base `mouriya-s-lab/coder-loop@f01560d5d0b324e791db7f599e502f09fc78a652`; current implementation/PR head `3f950cbded194a739f586799d172db61c7d715ea`

## Deliverable

`implementation-pr`

Continue the existing implementation PR https://github.com/mouriya-s-lab/coder-loop/pull/674, which closes only #549 and is OPEN/CLEAN at `3f950cbded194a739f586799d172db61c7d715ea`; do not open a replacement or second PR. The prior closing PR https://github.com/mouriya-s-lab/coder-loop/pull/658 is closed without merge and remains archaeology only. The deliverable is the canonical `CompiledTaskModel`, closed typed compile result/diagnostic channel, unique versioned public projection, and `coder-loop preset compile <name|path> --json` from the same compiler consumed by runtime. Keep #552–#556 additive content and #605 instance-definition pinning out of scope.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit / output |
|---|---|---|---|---|
| C549-01 | public valid projection | shell | `coder-loop preset compile gh-issue-pr-iteration --json | jq -e '.schemaVersion == 1 and (.preset | has("name") and has("dir") and has("sourceHash")) and (.statuses | type == "object") and (.stateGraph.edges | length > 0) and (.phases | length > 0) and (.phases[0].variables | all(.type == "string")) and (.tools | type == "array" or type == "object") and (.fragments | type == "array") and (.findings | type == "array")'`; cwd repo root; package bin on `PATH` | exit `0`; all versioned six-block projection assertions true |
| C549-02 | top-level contract shape | shell | `coder-loop preset compile gh-issue-pr-iteration --json | jq -e 'keys == ["findings","fragments","phases","preset","schemaVersion","stateGraph","statuses","tools"]'`; cwd repo root | exit `0`; exact schema-v1 top-level keys |
| C549-03 | rejected diagnostic channel | shell | `coder-loop preset compile test-fixtures/preset-compile/invalid --json > /tmp/coder-loop-549-invalid.stdout 2> /tmp/coder-loop-549-invalid.stderr; code=$?; test "$code" -ne 0 && test ! -s /tmp/coder-loop-549-invalid.stdout && jq -e '(.kind == "rejected") and (.diagnostics | length > 0) and (.diagnostics | all(.[]; (.verdict == "error") and (.rule | type == "string") and (.message | type == "string")))' /tmp/coder-loop-549-invalid.stderr`; cwd repo root | exit `0`; compile itself exits nonzero and emits only structured non-empty rejection diagnostics, never a generic throw-message contract |
| C549-04 | warning completeness | shell | `coder-loop preset compile test-fixtures/preset-compile/warning --json | jq -e '.findings | any(.verdict == "warn" and .rule == "dead-vocabulary")'`; cwd repo root | exit `0`; warning preset compiles successfully and exposes the warning in `findings` |
| C549-05 | deterministic identity/projection | shell | `bun test src/preset-compile.test.ts`; cwd repo root | exit `0`; boundary round-trips both result variants; repeated direct/materialized compilation is byte-identical; source text containing its own absolute directory is preserved; task-node identities live in the canonical model, remain unique/stable through JSON round-trip and sibling insertion/reordering, and are projected unchanged rather than derived from position |
| C549-06 | single compiler path | shell | `rg -n 'parsePreset\(' src --glob '*.ts'`; cwd repo root | exit `0`; exactly one production invocation remains and it is owned by the canonical compiler; runtime load and CLI projection both enter through that compiler, with no export-only parser/validator |
| C549-07 | typed boundaries | shell | `bun run typecheck`; cwd repo root | exit `0`; compile CLI args, source resolution, compile result, diagnostics and DTO projection all retain precise boundary-derived types |
| C549-08 | full regression | shell | `bun test`; cwd repo root | exit `0`; full suite green; base/head inventory reports added/removed/renamed/skipped/weakened tests, with no weakened assertion used to obtain green |
| C549-09 | operator CLI runtime | shell | `coder-loop preset compile gh-issue-pr-iteration --json >/tmp/coder-loop-549-a.json && coder-loop preset compile gh-issue-pr-iteration --json >/tmp/coder-loop-549-b.json && cmp /tmp/coder-loop-549-a.json /tmp/coder-loop-549-b.json`; cwd repo root; package bin on `PATH` | exit `0`; two one-shot operator invocations produce byte-identical JSON |
| C549-10 | real engine loading path | shell | `bun scripts/real-e2e.ts`; cwd repo root; active `RiriAgent` gh auth and fixture access | exit `0`; isolated daemon tears down cleanly, fixture issue is `CLOSED`, closing PR is `MERGED`, proving runtime consumption of the compiled model did not regress |

## Pattern scope

| Type | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|
| changed | added `any`, broad `object`/`Object`/`{}`, unchecked map/JSON shapes, or anonymous DTO/result shapes in the #549 diff | none; external input must be parsed by named arktype boundaries and internal variants must be named ADTs | zero newly added loose/untyped shapes; exported TS DTO types derive from the public boundary schema |
| changed | added `unknown` | only `catch` bindings and the immediate untrusted boundary-parse input | every occurrence is narrowed/parsed at that boundary and does not flow into compiler internals |
| changed | true `as` assertions (excluding `as const`) | none | zero newly added true assertions or double-cast escapes |
| changed | compile-result control flow based on exception text, `.message` parsing, broad catch-and-continue, or silent fallback/default diagnostics | none | expected failures are exhaustively represented as `compiled(model, warnings)` or `rejected(non-empty diagnostics)`; impossible states fail at their boundary |
| whole-tree | production calls matching `parsePreset(` | the canonical compiler implementation only | exactly one production parse call; `loadPreset`, daemon/scheduler consumers, and compile CLI share that compiler rather than parallel load/export pipelines |
| changed | task identity derived from array index, anonymous structural path, or projection-only synthesis (for example `/task/0`) | none | each referable task node owns a stable semantic identity in `CompiledTaskModel`; projection copies it unchanged and tests cover reorder/insertion stability |
| changed | unconditional replacement of absolute preset-directory strings inside arbitrary prompt/fragment content | source-aware materialization of the reserved `{{PRESET_ROOT}}` token only | literal user content is preserved; direct and materialized compilation of the same source yield identical schema-v1 bytes/hash |
| changed | hard-coded `gh-issue-pr-iteration`, phase names, status literals, known binding keys, or GitHub fields in engine/compiler code | none outside preset fixtures/tests that intentionally assert their own declarations | compiler derives all business vocabulary and graph edges from the loaded preset plus explicitly modeled engine transitions |

## Canonical runtime

- Setup: from repo root at the implementation head, run `bun install --frozen-lockfile`; expose the package bin so `coder-loop` executes this checkout's `src/loop.ts`; verify `gh auth status` keeps `RiriAgent` active before the GitHub fixture run.
- Start: `preset compile` is a one-shot CLI and has no resident service. Invoke the literal valid, invalid, warning, and deterministic commands in C549-01 through C549-04 and C549-09. For the runtime loading path, C549-10 is the target-mandated real E2E driver and starts its own isolated daemon/chain.
- Readiness: a successful compile invocation exits `0`, writes one schema-v1 JSON document to stdout, and writes no error payload; rejected input exits nonzero with the structured rejection document on stderr.
- Behavior: inspect valid six-block projection, warning preservation, closed rejection diagnostics, deterministic bytes, stable canonical node identities, and the real daemon → agent → merged PR → closed issue path.
- Logs/evidence: retain command, cwd, source SHA, exit code, stdout/stderr and test inventory under `/Users/mouriya/.coder-loop/loop-data/chains/v3-549/evidence/549`; the real-E2E transcript must name fixture issue/PR terminal states.
- Stop ownership: direct compile processes own no persistent resources. `scripts/real-e2e.ts` owns and must complete daemon shutdown, fixture cleanup and mutex release; iteration must not leave a production `~/.coder-loop` daemon mutation as evidence.

## Test delta

`required`

Add focused compile-boundary/projection fixtures and tests for valid, rejected and warning results; exact public boundary round-trip; deterministic direct/materialized bytes; literal-path-content preservation; semantic identity uniqueness and reorder/insertion stability; malformed CLI shape; and non-`ENOENT` source-resolution rejection. Existing tests may change only where the canonical model type requires construction updates. Surviving integrity rule: do not delete, skip, rename away, loosen, or replace existing behavioral assertions merely to pass; report base/head inventory and keep the full suite plus real E2E green.

## Dependencies

- Authoritative design upstream: #547, especially decision A quoted in #549; it fixes load-as-compile, model/DTO separation, the six projection blocks, typed diagnostics, and on-demand/no-cache semantics.
- Definition-pin boundary: `v3/definition-pin-decision.md` and #605. #549 must produce deterministic current-definition projection bytes, but must not implement persisted running-instance pinning.
- Downstream blockers: #582, #587, #570 and tree children #552–#556 consume this contract additively; they do not block #549.
- Current source fact at `f01560d`: `src/loop.ts` exposes `PresetTomlBoundary`, `Preset`, `loadPreset`, `parsePreset`, and `StatusSnapshotBoundary`; `loadPreset` performs prompt/fragment readability plus DAG/placeholder validation, while root usage has no `preset` command. This existing path is the compiler input to consolidate, not a second implementation to preserve.
- Prior implementation evidence: PR #658 is closed unmerged at `6ce8a6663e3c6454d74f6c3b4e41f16dab34b098`. Its review comments identified concrete hazards covered by the current implementation: typed CLI arg boundary, canonical rather than projection-only task identity, literal-safe materialization normalization, and typed non-`ENOENT` source failures.
- Current delivery fact: iteration committed the accepted tree as `3f950cbded194a739f586799d172db61c7d715ea`, pushed branch `issue-549-run-1783908705935-11-iteration-item-1`, and opened https://github.com/mouriya-s-lab/coder-loop/pull/674. Live metadata shows exactly one closing reference (#549), `state=OPEN`, `mergeStateStatus=CLEAN`, no configured checks, reviews, review comments, or inline comments. Continue this PR under the GitHub routing contract.
- Re-enrichment cause: run `run-1783917337650-38-iteration-item-1` completed submission, then queried its declared exits and found only the exceptional `contract_invalid` item-status edge. Following the injected uniform completion protocol mechanically wrote that status. No GitHub source reports a new contract defect, and no acceptance check failed; this marker refresh records the now-existing PR/head facts rather than broadening or replacing the contract.
- External runtime dependency for C549-10: network access, active `RiriAgent` GitHub CLI auth, and writable `mouriya-s-lab/coder-loop-e2e-fixture`; the harness itself provides serialized fixture access and isolated loop-data teardown.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/549#issuecomment-4954053225



### comment #4954531930 by `RiriAgent` — 2026-07-13T04:47:56Z

<!-- coder-loop:executable-contract schema=1 source-issue=549 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/549
- Observed body update timestamp: `2026-07-11T10:10:25Z`
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/549#issuecomment-4865081552
- Investigated source revisions: base `mouriya-s-lab/coder-loop@f01560d5d0b324e791db7f599e502f09fc78a652`; current implementation/PR head `3f950cbded194a739f586799d172db61c7d715ea`

## Deliverable

`implementation-pr`

Continue the existing implementation PR https://github.com/mouriya-s-lab/coder-loop/pull/674, which closes only #549 and is OPEN/CLEAN at `3f950cbded194a739f586799d172db61c7d715ea`; do not open a replacement or second PR. The prior closing PR https://github.com/mouriya-s-lab/coder-loop/pull/658 is closed without merge and remains archaeology only. The deliverable is the canonical `CompiledTaskModel`, closed typed compile result/diagnostic channel, unique versioned public projection, and `coder-loop preset compile <name|path> --json` from the same compiler consumed by runtime. Keep #552–#556 additive content and #605 instance-definition pinning out of scope.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit / output |
|---|---|---|---|---|
| C549-01 | public valid projection | shell | `coder-loop preset compile gh-issue-pr-iteration --json | jq -e '.schemaVersion == 1 and (.preset | has("name") and has("dir") and has("sourceHash")) and (.statuses | type == "object") and (.stateGraph.edges | length > 0) and (.phases | length > 0) and (.phases[0].variables | all(.type == "string")) and (.tools | type == "array" or type == "object") and (.fragments | type == "array") and (.findings | type == "array")'`; cwd repo root; package bin on `PATH` | exit `0`; all versioned six-block projection assertions true |
| C549-02 | top-level contract shape | shell | `coder-loop preset compile gh-issue-pr-iteration --json | jq -e 'keys == ["findings","fragments","phases","preset","schemaVersion","stateGraph","statuses","tools"]'`; cwd repo root | exit `0`; exact schema-v1 top-level keys |
| C549-03 | rejected diagnostic channel | shell | `coder-loop preset compile test-fixtures/preset-compile/invalid --json > /tmp/coder-loop-549-invalid.stdout 2> /tmp/coder-loop-549-invalid.stderr; code=$?; test "$code" -ne 0 && test ! -s /tmp/coder-loop-549-invalid.stdout && jq -e '(.kind == "rejected") and (.diagnostics | length > 0) and (.diagnostics | all(.[]; (.verdict == "error") and (.rule | type == "string") and (.message | type == "string")))' /tmp/coder-loop-549-invalid.stderr`; cwd repo root | exit `0`; compile itself exits nonzero and emits only structured non-empty rejection diagnostics, never a generic throw-message contract |
| C549-04 | warning completeness | shell | `coder-loop preset compile test-fixtures/preset-compile/warning --json | jq -e '.findings | any(.verdict == "warn" and .rule == "dead-vocabulary")'`; cwd repo root | exit `0`; warning preset compiles successfully and exposes the warning in `findings` |
| C549-05 | deterministic identity/projection | shell | `bun test src/preset-compile.test.ts`; cwd repo root | exit `0`; boundary round-trips both result variants; repeated direct/materialized compilation is byte-identical; source text containing its own absolute directory is preserved; task-node identities live in the canonical model, remain unique/stable through JSON round-trip and sibling insertion/reordering, and are projected unchanged rather than derived from position |
| C549-06 | single compiler path | shell | `rg -n 'parsePreset\(' src --glob '*.ts'`; cwd repo root | exit `0`; exactly one production invocation remains and it is owned by the canonical compiler; runtime load and CLI projection both enter through that compiler, with no export-only parser/validator |
| C549-07 | typed boundaries | shell | `bun run typecheck`; cwd repo root | exit `0`; compile CLI args, source resolution, compile result, diagnostics and DTO projection all retain precise boundary-derived types |
| C549-08 | full regression | shell | `bun test`; cwd repo root | exit `0`; full suite green; base/head inventory reports added/removed/renamed/skipped/weakened tests, with no weakened assertion used to obtain green |
| C549-09 | operator CLI runtime | shell | `coder-loop preset compile gh-issue-pr-iteration --json >/tmp/coder-loop-549-a.json && coder-loop preset compile gh-issue-pr-iteration --json >/tmp/coder-loop-549-b.json && cmp /tmp/coder-loop-549-a.json /tmp/coder-loop-549-b.json`; cwd repo root; package bin on `PATH` | exit `0`; two one-shot operator invocations produce byte-identical JSON |
| C549-10 | real engine loading path | shell | `bun scripts/real-e2e.ts`; cwd repo root; active `RiriAgent` gh auth and fixture access | exit `0`; isolated daemon tears down cleanly, fixture issue is `CLOSED`, closing PR is `MERGED`, proving runtime consumption of the compiled model did not regress |

## Pattern scope

| Type | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|
| changed | added `any`, broad `object`/`Object`/`{}`, unchecked map/JSON shapes, or anonymous DTO/result shapes in the #549 diff | none; external input must be parsed by named arktype boundaries and internal variants must be named ADTs | zero newly added loose/untyped shapes; exported TS DTO types derive from the public boundary schema |
| changed | added `unknown` | only `catch` bindings and the immediate untrusted boundary-parse input | every occurrence is narrowed/parsed at that boundary and does not flow into compiler internals |
| changed | true `as` assertions (excluding `as const`) | none | zero newly added true assertions or double-cast escapes |
| changed | compile-result control flow based on exception text, `.message` parsing, broad catch-and-continue, or silent fallback/default diagnostics | none | expected failures are exhaustively represented as `compiled(model, warnings)` or `rejected(non-empty diagnostics)`; impossible states fail at their boundary |
| whole-tree | production calls matching `parsePreset(` | the canonical compiler implementation only | exactly one production parse call; `loadPreset`, daemon/scheduler consumers, and compile CLI share that compiler rather than parallel load/export pipelines |
| changed | task identity derived from array index, anonymous structural path, or projection-only synthesis (for example `/task/0`) | none | each referable task node owns a stable semantic identity in `CompiledTaskModel`; projection copies it unchanged and tests cover reorder/insertion stability |
| changed | unconditional replacement of absolute preset-directory strings inside arbitrary prompt/fragment content | source-aware materialization of the reserved `{{PRESET_ROOT}}` token only | literal user content is preserved; direct and materialized compilation of the same source yield identical schema-v1 bytes/hash |
| changed | hard-coded `gh-issue-pr-iteration`, phase names, status literals, known binding keys, or GitHub fields in engine/compiler code | none outside preset fixtures/tests that intentionally assert their own declarations | compiler derives all business vocabulary and graph edges from the loaded preset plus explicitly modeled engine transitions |

## Canonical runtime

- Setup: from repo root at the implementation head, run `bun install --frozen-lockfile`; expose the package bin so `coder-loop` executes this checkout's `src/loop.ts`; verify `gh auth status` keeps `RiriAgent` active before the GitHub fixture run.
- Start: `preset compile` is a one-shot CLI and has no resident service. Invoke the literal valid, invalid, warning, and deterministic commands in C549-01 through C549-04 and C549-09. For the runtime loading path, C549-10 is the target-mandated real E2E driver and starts its own isolated daemon/chain.
- Readiness: a successful compile invocation exits `0`, writes one schema-v1 JSON document to stdout, and writes no error payload; rejected input exits nonzero with the structured rejection document on stderr.
- Behavior: inspect valid six-block projection, warning preservation, closed rejection diagnostics, deterministic bytes, stable canonical node identities, and the real daemon → agent → merged PR → closed issue path.
- Logs/evidence: retain command, cwd, source SHA, exit code, stdout/stderr and test inventory under `/Users/mouriya/.coder-loop/loop-data/chains/v3-549/evidence/549`; the real-E2E transcript must name fixture issue/PR terminal states.
- Stop ownership: direct compile processes own no persistent resources. `scripts/real-e2e.ts` owns and must complete daemon shutdown, fixture cleanup and mutex release; iteration must not leave a production `~/.coder-loop` daemon mutation as evidence.

## Test delta

`required`

Add focused compile-boundary/projection fixtures and tests for valid, rejected and warning results; exact public boundary round-trip; deterministic direct/materialized bytes; literal-path-content preservation; semantic identity uniqueness and reorder/insertion stability; malformed CLI shape; and non-`ENOENT` source-resolution rejection. Existing tests may change only where the canonical model type requires construction updates. Surviving integrity rule: do not delete, skip, rename away, loosen, or replace existing behavioral assertions merely to pass; report base/head inventory and keep the full suite plus real E2E green.

## Dependencies

- Authoritative design upstream: #547, especially decision A quoted in #549; it fixes load-as-compile, model/DTO separation, the six projection blocks, typed diagnostics, and on-demand/no-cache semantics.
- Definition-pin boundary: `v3/definition-pin-decision.md` and #605. #549 must produce deterministic current-definition projection bytes, but must not implement persisted running-instance pinning.
- Downstream blockers: #582, #587, #570 and tree children #552–#556 consume this contract additively; they do not block #549.
- Current source fact at `f01560d`: `src/loop.ts` exposes `PresetTomlBoundary`, `Preset`, `loadPreset`, `parsePreset`, and `StatusSnapshotBoundary`; `loadPreset` performs prompt/fragment readability plus DAG/placeholder validation, while root usage has no `preset` command. This existing path is the compiler input to consolidate, not a second implementation to preserve.
- Prior implementation evidence: PR #658 is closed unmerged at `6ce8a6663e3c6454d74f6c3b4e41f16dab34b098`. Its review comments identified concrete hazards covered by the current implementation: typed CLI arg boundary, canonical rather than projection-only task identity, literal-safe materialization normalization, and typed non-`ENOENT` source failures.
- Current delivery fact: iteration committed the accepted tree as `3f950cbded194a739f586799d172db61c7d715ea`, pushed branch `issue-549-run-1783908705935-11-iteration-item-1`, and opened https://github.com/mouriya-s-lab/coder-loop/pull/674. Live metadata shows exactly one closing reference (#549), `state=OPEN`, `mergeStateStatus=CLEAN`, no configured checks, reviews, review comments, or inline comments. Continue this PR under the GitHub routing contract.
- Re-enrichment cause: runs `run-1783917337650-38-iteration-item-1` and `run-1783917894507-41-iteration-item-1` both verified the contract and PR were current with no failed check or remaining iteration work, then queried iteration exits and found only the exceptional `contract_invalid` item-status edge. Both mechanically wrote that exceptional status, causing the observed loop; no GitHub source reports a contract defect.
- Normal phase handoff fact: the materialized preset at `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/preset.toml:134` declares iteration's normal `on = "completed"` next edge to `review`, while `preset.toml:145-151` separately declares the exceptional `status = "contract_invalid"` edge back to enrichment. Therefore an iteration that finds this marker valid and PR #674 already submitted must finish successfully without `item update --status contract_invalid`; that status is selected only when the marker is actually missing, malformed, stale, or contradictory. This distinction is required to reach review and does not change #549's implementation scope.
- External runtime dependency for C549-10: network access, active `RiriAgent` GitHub CLI auth, and writable `mouriya-s-lab/coder-loop-e2e-fixture`; the harness itself provides serialized fixture access and isolated loop-data teardown.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/549#issuecomment-4954515148



### comment #4980746771 by `RiriAgent` — 2026-07-15T12:49:08Z

<!-- coder-loop:executable-contract schema=1 source-issue=549 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/549
- Observed body update timestamp: `2026-07-15T10:56:56Z`
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/549#issuecomment-4865081552
  - https://github.com/mouriya-s-lab/coder-loop/pull/674#issuecomment-4980677441
- Investigated source revisions: base `mouriya-s-lab/coder-loop@07dad882ded934766f51e53a5e0a04605a18c697`; current implementation/PR head `07fd687b9d5279f658f70af65ffe579002b332f3`

## Deliverable

`implementation-pr`

Continue the existing implementation PR https://github.com/mouriya-s-lab/coder-loop/pull/674, which closes only #549 and is `OPEN`, ready, and `CLEAN` at `07fd687b9d5279f658f70af65ffe579002b332f3`; do not open a replacement or second PR. The prior closing PR https://github.com/mouriya-s-lab/coder-loop/pull/658 is closed without merge and remains archaeology only. Deliver the canonical `CompiledTaskModel`, closed typed compile result/diagnostic channel, unique versioned public projection, and `coder-loop preset compile <name|path> --json` from the same compiler consumed by runtime. Keep #552-#556 additive content, #605 instance-definition pinning, and #684/#685 combined-scenario compatibility E2E out of scope.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit / output |
|---|---|---|---|---|
| C549-01 | public valid projection | shell | `coder-loop preset compile gh-issue-pr-iteration --json | jq -e '.schemaVersion == 1 and (.preset | has("name") and has("dir") and has("sourceHash")) and (.statuses | type == "object") and (.stateGraph.edges | length > 0) and (.phases | length > 0) and (.phases[0].variables | all(.type == "string")) and (.tools | type == "array" or type == "object") and (.fragments | type == "array") and (.findings | type == "array")'`; cwd repo root; this checkout's package bin first on `PATH` | exit `0`; all versioned six-block projection assertions true |
| C549-02 | top-level contract shape | shell | `coder-loop preset compile gh-issue-pr-iteration --json | jq -e 'keys == ["findings","fragments","phases","preset","schemaVersion","stateGraph","statuses","tools"]'`; cwd repo root; this checkout's package bin first on `PATH` | exit `0`; exact schema-v1 top-level keys; root task identity is represented inside an existing contract block rather than creating an unversioned extra top-level block |
| C549-03 | rejected diagnostic channel | shell | `coder-loop preset compile test-fixtures/preset-compile/invalid --json > /tmp/coder-loop-549-invalid.stdout 2> /tmp/coder-loop-549-invalid.stderr; code=$?; test "$code" -ne 0 && test ! -s /tmp/coder-loop-549-invalid.stdout && jq -e '(.kind == "rejected") and (.diagnostics | length > 0) and (.diagnostics | all(.[]; (.verdict == "error") and (.rule | type == "string") and (.message | type == "string")))' /tmp/coder-loop-549-invalid.stderr`; cwd repo root | exit `0`; compile itself exits nonzero and emits only structured non-empty rejection diagnostics, never a generic throw-message contract |
| C549-04 | warning completeness | shell | `coder-loop preset compile test-fixtures/preset-compile/warning --json | jq -e '.findings | any(.verdict == "warn" and .rule == "dead-vocabulary")'`; cwd repo root | exit `0`; warning preset compiles successfully and exposes the warning in `findings` |
| C549-05 | deterministic identity/projection | shell | `bun test src/preset-compile.test.ts`; cwd repo root | exit `0`; boundary round-trips both result variants; repeated direct/materialized compilation is byte-identical; source text containing its own absolute directory is preserved; every canonical task-tree identity, including `tasks:root`, is present unchanged in the public projection; the full canonical/projected identity sets compare equal without `slice(1)` or another omission; identities remain unique/stable through JSON round-trip and sibling insertion/reordering |
| C549-06 | single compiler path | shell | `rg -n 'parsePreset\(' src --glob '*.ts'`; cwd repo root | exit `0`; exactly one production invocation remains and it is owned by the canonical compiler; runtime load and CLI projection both enter through that compiler, with no export-only parser/validator |
| C549-07 | typed boundaries | shell | `bun run typecheck`; cwd repo root | exit `0`; compile CLI args, source resolution, compile result, warning/error diagnostics, task-tree projection, and DTO projection all retain precise boundary-derived types |
| C549-08 | full regression | shell | `bun test`; cwd repo root | exit `0`; full suite green; base/head inventory reports added/removed/renamed/skipped/weakened tests, with no weakened assertion used to obtain green |
| C549-09 | operator CLI runtime | shell | `coder-loop preset compile gh-issue-pr-iteration --json >/tmp/coder-loop-549-a.json && coder-loop preset compile gh-issue-pr-iteration --json >/tmp/coder-loop-549-b.json && cmp /tmp/coder-loop-549-a.json /tmp/coder-loop-549-b.json`; cwd repo root; this checkout's package bin first on `PATH` | exit `0`; two one-shot operator invocations produce byte-identical JSON containing the full canonical task identity set |
| C549-11 | minimum process integration | shell | `bun scripts/engine-integration.ts`; cwd repo root; isolated loop-data and deterministic stub runner supplied by the repository harness | exit `0`; iteration then review reaches terminal `done`, daemon-socket admission succeeds, marker commit and slot-worktree reclamation are observed, daemon stops, and no orphan process remains |

`C549-10` from the superseded marker is intentionally removed: issue #549 explicitly says not to run `scripts/real-e2e.ts`; #684 owns combined v3 consumption and #685 owns existing GitHub-preset compatibility. Historical evidence that an earlier agent ran it does not make it a current acceptance requirement and it must not be rerun for this issue.

## Pattern scope

| Type | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|
| changed | added `any`, broad `object`/`Object`/`{}`, unchecked map/JSON shapes, or anonymous DTO/result shapes in the #549 diff | none; external input must be parsed by named arktype boundaries and internal variants must be named ADTs | zero newly added loose/untyped shapes; exported TS DTO types derive from the public boundary schema |
| changed | added `unknown` | only `catch` bindings and the immediate untrusted boundary-parse input | every occurrence is narrowed/parsed at that boundary and does not flow into compiler internals |
| changed | true `as` assertions, excluding `as const` | none | zero newly added true assertions or double-cast escapes |
| changed | compile-result control flow based on exception text, `.message` parsing, broad catch-and-continue, or silent fallback/default diagnostics | none | expected failures are exhaustively represented as `compiled(model, warnings)` or `rejected(non-empty diagnostics)`; impossible/infrastructure failures escape at their boundary |
| whole-tree | production calls matching `parsePreset(` | the canonical compiler implementation only | exactly one production parse invocation; `loadPreset`, daemon/scheduler consumers, and compile CLI share that compiler rather than parallel load/export pipelines |
| changed | canonical/public task identity mismatch, identity derived from array index or anonymous structural path, projection-only synthesis, root omission, or a test that discards an identity with `slice(1)` | none | every canonical referable task node, including the current canonical root `tasks:root`, is projected unchanged exactly as modeled; focused tests compare the full identity set and cover round-trip plus reorder/insertion stability |
| changed | unconditional replacement of absolute preset-directory strings inside arbitrary prompt/fragment content | source-aware materialization of the reserved `{{PRESET_ROOT}}` token only | literal user content is preserved; direct and materialized compilation of the same source yield identical schema-v1 bytes/hash |
| changed | hard-coded `gh-issue-pr-iteration`, phase names, status literals, known binding keys, or GitHub fields in engine/compiler code | none outside preset fixtures/tests that intentionally assert their own declarations | compiler derives all business vocabulary and graph edges from the loaded preset plus explicitly modeled engine transitions |

## Canonical runtime

- Setup: from repo root at the implementation head, run `bun install --frozen-lockfile`; put this checkout's package bin first on `PATH` so `coder-loop` executes this checkout's `src/loop.ts`. No GitHub credential or external fixture is required by the acceptance runtime.
- Start: `preset compile` is a one-shot CLI and owns no resident service. Invoke the valid, invalid, warning, and deterministic commands in C549-01 through C549-04 and C549-09. C549-11 is the target-mandated minimum process integration driver and starts an isolated daemon with the repository's deterministic stub runner.
- Readiness: a successful compile exits `0`, writes one schema-v1 JSON document to stdout, and writes no error payload; rejected input exits nonzero with the structured rejection document on stderr. Engine integration reports its isolated daemon socket ready before adding work.
- Behavior: observe the valid six-block projection, full canonical task identity projection, warning preservation, closed rejection diagnostics, deterministic bytes, and isolated daemon loading/scheduling of the same compiled model.
- Logs/evidence: retain command, cwd, source SHA, exit code, stdout/stderr, test inventory, and engine-integration teardown output under `/Users/mouriya/.coder-loop/loop-data/chains/v3-549/evidence/549`.
- Stop ownership: direct compile processes exit after output. `scripts/engine-integration.ts` owns and must complete isolated daemon shutdown, loop-data cleanup, slot-worktree reclamation, and orphan-process checks. Do not start or mutate the production `~/.coder-loop` daemon. Do not run `scripts/real-e2e.ts` for #549.

## Test delta

`required`

Add or update focused compile-boundary/projection fixtures and tests for valid, rejected, and warning results; exact public boundary round-trip; deterministic direct/materialized bytes; literal-path-content preservation; malformed CLI shape; non-`ENOENT` source-resolution rejection; and full canonical task identity projection including `tasks:root` without slicing it away. Existing tests may change only where the canonical model/public schema requires construction updates. Surviving integrity rule: do not delete, skip, rename away, loosen, or replace existing behavioral assertions merely to pass; report base/head inventory and keep focused tests, `bun run typecheck`, the full suite, and the minimum process integration green. `scripts/real-e2e.ts` is forbidden by the issue's verification boundary, not an integrity requirement.

## Dependencies

- Authoritative design upstream: https://github.com/mouriya-s-lab/coder-loop/issues/547, especially decision A quoted in #549; it fixes load-as-compile, model/DTO separation, the six projection blocks, typed diagnostics, and on-demand/no-cache semantics.
- Definition-pin boundary: `v3/definition-pin-decision.md` and https://github.com/mouriya-s-lab/coder-loop/issues/605. #549 must produce deterministic current-definition projection bytes, but must not implement persisted running-instance pinning.
- Verification ownership: issue #549's body at `2026-07-15T10:56:56Z` limits this child to static type, unit/contract, boundary round-trip, and minimum process integration where the real daemon boundary is involved. https://github.com/mouriya-s-lab/coder-loop/issues/684 owns combined v3 scenario consumption; https://github.com/mouriya-s-lab/coder-loop/issues/685 owns existing GitHub-preset compatibility. Neither blocks the local checks above.
- Downstream consumers: #582, #587, #570, #605, and tree children #552-#556 consume this contract additively; they do not authorize implementing their content in #549.
- Current delivery fact: https://github.com/mouriya-s-lab/coder-loop/pull/674 is the only live implementation route, closes exactly #549, and is `OPEN`, ready, `CLEAN`, and mergeable at `07fd687b9d5279f658f70af65ffe579002b332f3`. It has no configured check runs, commit statuses, submitted reviews, review threads, or inline review comments. Continue its existing branch.
- Current source fact at base `07dad882ded934766f51e53a5e0a04605a18c697` and head `07fd687b9d5279f658f70af65ffe579002b332f3`: `src/loop.ts` contains the named compile ADTs, `compilePreset`, `loadPreset`, one production `parsePreset` invocation, the public projection boundary, and the one-shot CLI; `src/preset-compile.test.ts` is the focused contract suite. The branch changes eight files and has no uncommitted work.
- Remaining implementation defect from https://github.com/mouriya-s-lab/coder-loop/pull/674#issuecomment-4980677441: `src/loop.ts` gives the canonical root identity `tasks:root`, while the public projection exposes only phase subtrees; `src/preset-compile.test.ts` currently hides the mismatch with `canonicalIdentities.slice(1)`. Iteration must project the root identity through the versioned boundary and compare the full identity set without omission; this is implementation work, not permission to weaken expected result 5.
- Re-enrichment cause: the superseded marker contradicted the issue by requiring `bun scripts/real-e2e.ts` and used the stale body timestamp `2026-07-11T10:10:25Z`. This marker removes that requirement, records the current body edit, and preserves the independent root-identity defect for iteration.
- External blockers: none verified. All current acceptance commands are local; C549-11 supplies isolated loop-data and a deterministic stub runner and uses no GitHub/LLM/network path.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/549#issuecomment-4954531930



### comment #4981435339 by `RiriAgent` — 2026-07-15T14:00:01Z

## Coder-loop closure (run-1784123834676-62-closure-item-1)

Accepted: merged PR https://github.com/mouriya-s-lab/coder-loop/pull/674 at merge commit `55ff3b2b7345a8e3d975934a53997d074aa02380`; consumed verdict https://github.com/mouriya-s-lab/coder-loop/pull/674#issuecomment-4981396239.


---

## Timeline (52)

- 2026-07-02T11:11:54Z `assigned` @RiriAgent
- 2026-07-02T11:12:27Z `cross-referenced` @RiriAgentsrc=552
- 2026-07-02T11:12:30Z `cross-referenced` @RiriAgentsrc=553
- 2026-07-02T11:12:32Z `cross-referenced` @RiriAgentsrc=554
- 2026-07-02T11:12:43Z `cross-referenced` @RiriAgentsrc=555
- 2026-07-02T11:12:45Z `cross-referenced` @RiriAgentsrc=556
- 2026-07-02T11:13:03Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:14:34Z `commented` @RiriAgent
- 2026-07-02T11:15:25Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-02T11:58:07Z `cross-referenced` @RiriAgentsrc=570
- 2026-07-02T11:58:39Z `cross-referenced` @RiriAgentsrc=548
- 2026-07-02T12:02:24Z `cross-referenced` @RiriAgentsrc=582
- 2026-07-02T12:02:43Z `cross-referenced` @RiriAgentsrc=587
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-05T07:47:49Z `cross-referenced` @RiriAgentsrc=565
- 2026-07-05T07:48:16Z `cross-referenced` @RiriAgentsrc=567
- 2026-07-10T11:50:22Z `cross-referenced` @RiriAgentsrc=605
- 2026-07-10T17:03:18Z `referenced` @RiriAgentcommit=c1de2d3499056cca610d20d8e08121f562c51945
- 2026-07-12T00:31:28Z `cross-referenced` @RiriAgentsrc=658
- 2026-07-12T14:00:42Z `cross-referenced` @RiriAgentsrc=666
- 2026-07-12T14:34:45Z `cross-referenced` @RiriAgentsrc=667
- 2026-07-13T00:03:34Z `cross-referenced` @RiriAgentsrc=661
- 2026-07-13T02:11:12Z `commented` @RiriAgent
- 2026-07-13T03:04:50Z `commented` @RiriAgent
- 2026-07-13T04:39:54Z `cross-referenced` @RiriAgentsrc=674
- 2026-07-13T04:44:23Z `commented` @RiriAgent
- 2026-07-13T04:47:56Z `commented` @RiriAgent
- 2026-07-13T06:02:56Z `referenced` @RiriAgentcommit=77ea7328df55deb3930407ccb75193c0b51707ca
- 2026-07-13T10:21:38Z `referenced` @RiriAgentcommit=8380cae9dd0b83716d6638048cd4d88ea9429dab
- 2026-07-13T11:38:30Z `referenced` @RiriAgentcommit=307a7ec787d2ce854dd1a7d565c27b768f0ada4b
- 2026-07-15T12:49:08Z `commented` @RiriAgent
- 2026-07-15T13:59:37Z `referenced` @RiriAgentcommit=55ff3b2b7345a8e3d975934a53997d074aa02380
- 2026-07-15T13:59:38Z `closed` @RiriAgentcommit=None
- 2026-07-15T14:00:01Z `commented` @RiriAgent
- 2026-07-16T23:38:34Z `referenced` @RiriAgentcommit=05ee53cc42027da2343ce5f24c5a0103e919fdb8
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:51Z `cross-referenced` @RiriAgentsrc=725
- 2026-07-17T20:36:53Z `cross-referenced` @RiriAgentsrc=726
- 2026-07-17T20:37:18Z `cross-referenced` @RiriAgentsrc=737
- 2026-07-17T20:37:20Z `cross-referenced` @RiriAgentsrc=738
- 2026-07-17T20:37:23Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-17T20:37:25Z `cross-referenced` @RiriAgentsrc=740
- 2026-07-17T20:37:28Z `cross-referenced` @RiriAgentsrc=741
- 2026-07-17T20:37:32Z `cross-referenced` @RiriAgentsrc=743
- 2026-07-17T20:37:34Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:37:36Z `cross-referenced` @RiriAgentsrc=745
- 2026-07-17T20:37:41Z `cross-referenced` @RiriAgentsrc=747
- 2026-07-17T20:38:31Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-17T20:38:59Z `cross-referenced` @RiriAgentsrc=735
- 2026-07-17T20:39:01Z `cross-referenced` @RiriAgentsrc=736
- 2026-07-17T20:39:09Z `cross-referenced` @RiriAgentsrc=742