# #594 feat(engine): context 共享存储与写入面——envelope ADT、SQLite append-only 表与凭证推导 author

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T14:03:54Z  | updated: 2026-07-13T11:04:11Z
- closed: 2026-07-13T11:03:53Z  | state_reason: `completed`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/594
- comments: 2  | timeline events: 20

---

## Body

## 必须先读的关联 issue

#545（RFC: v3 context 共享 CLI——无状态 agent 的受控上下文传递）。本 child 是该 RFC 的地基 child，继承条款逐字快照：

> "envelope 含 id、ts、scope、author（从凭证推导；operator 写入 subject=operator）、body。引擎对 body 逐字携带、永不提取语义——不做正则、不识别 marker、body 里出现状态字面量或控制记号没有任何效果。" — #545「entry 模型」

> "**append-only**：entry 不可更新、不可删除（chain 级联删除除外）。消掉并行分支覆写竞争，与「每个 agent 运行无状态、做完即丢」前提一致。" — #545「entry 模型」

> "**一律经 daemon socket**：写入获得 #406 主体判定与审计事件；文件系统上不存在可直写的对应物。" — #545「entry 模型」

> "**scope 集合**：`item`（同一 item 的跨 run/跨 phase 谱系——retry 轮次之间、phase 之间）+ `chain`（跨 item 的链级公告）+ `group`（并行分支组内通信；scope 键 = par 节点物化时的稳定容器 id，#546 已裁）。不设 `run` scope（run 内自说自话无传递价值）、不设跨 chain（chain 是隔离边界）。" — #545 设计裁决 2

> "**授权无粒度，chain 内随意读写**：不扩展 `[phases.rights]`。#406 凭证只做两件事——entry 的 author（chain/item/run/phase）从凭证推导、不可自报；可见范围天然限定在凭证所属 chain。operator 无凭证路径全量读写任意 chain。" — #545 设计裁决 3

> - "SQLite 新表，daemon 唯一写入方；查询过滤天然、GUI（RFC-5）直接消费、`chain delete` 级联清除。"
> - "body 不设引擎自造的任意字节上限，也不截断；真实外部协议边界必须点名来源并显式拒绝，证据类大内容走 evidence 引用。"
> - "entries 与 chain 同生共死，无独立 GC。"
>
> — #545「存储与生命周期」（三条列表项）

## 目标

落地 context entry 的持久化与写入命令面——envelope ADT、SQLite append-only 新表、经 daemon socket 的写入命令、author 凭证推导、admission 与审计。

## 使用场景

agent 在 run 内经 CLI 写入一条 context entry（scope = item / chain / group），供同 item 后续 run/phase 或链内其他 item 的 agent 经读取面（后续 child）取回；operator 无凭证直接向任意 chain 写公告 entry。基座 child：为读取面、group scope 真实化、「必须调用」执法三个后续 child 提供唯一的存储与写入事实源。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@a007fa4（行号实施前自行 grep 核对）。

- 唯一现存传递通道 shared.md：`ensureChainRuntimeLayout` 创建（`src/daemon.ts:1629`，`wx` flag、EEXIST 静默）；之后 agent 按 prompt 纪律文件系统直写 append——不经 daemon、无鉴权、无审计、无结构。
- #406 run-scoped 凭证：spawn 时 mint + env 注入（`src/scheduler.ts:1043-1048`，`LOOP_RUN_CREDENTIAL_ENV`）；CLI 自动附带 `withInjectedRunCredential`（`src/loop.ts:2162`，allow-list `AGENT_ATTRIBUTED_COMMANDS` `src/loop.ts:2193`）；daemon 侧 `resolveItemMutationCaller`（`src/daemon.ts:3182-3223`）解析为 `ItemMutationCaller = { kind:"operator" } | { kind:"agent", runId, phase }`（`src/daemon.ts:505-507`）——author 推导的现成来源。
- #409 命令鉴权分类：`DaemonCommandAuthClass` 四类（`src/daemon.ts:127-131`）、`DaemonCommandName` union（`133-173`）、`buildDaemonCommandSpecs` 的 `Record<DaemonCommandName, DaemonCommandSpec>` 穷尽映射（`1275-1307`）、`runAuthorizationGate` 穷尽 switch（`1332`，`assertNeverDaemonCommandAuthClass` `4934`）。新命令必须进这套编译期穷尽面。
- 审计事件先例（#411）：每条 mutation 1-3 条事件；`item.status.write_admission` emit 于 `src/daemon.ts:3150`；validation kind 样例 `daemon.preset_load_failed`（`src/observability.ts:352-375`）；事件 union `ObservabilityEventBoundary`（`src/observability.ts:243` 起）。
- SQLite 加表流程：`STATE_SCHEMA_VERSION = 13`（`src/sqlite-state.ts:488`）→ bump + `STATE_SCHEMA_SQL`（`436`）加 CREATE TABLE → `stateSchemaExists`（`536-544`）→ `migrateStateSchema`（`591-716`）事务内迁移。现有表仅 chains/items/runs/current_runs。
- **`chain delete` 是软删（GC 实现陷阱）**：`handleChainDelete` 只写 `status: "deleted"`（`src/daemon.ts:1879-1896`，写入 `1886`），chains 行从不物理 DELETE；schema 里 items/runs/current_runs 的 `ON DELETE CASCADE`（`src/sqlite-state.ts:448-461` 一带）在现行命令下**从不触发**。RFC 行 8 钉的是结果（delete 后 entries 全清）——实现不能靠 FK 级联，须在 `chain delete` 路径对 entries 显式清除（或等价机制）。
- 命名冲突已核：`src/` 内无任何 `context` 子命令、命令名或表名；现有 `context` 命中均为 `SchedulerRunCredentialContext`/`ResolveContext` 等无关结构，`sharedContextPath` 是 chain 级 shared.md 的 binding key（`src/loop.ts:1013`，消费 `src/scheduler.ts:2214`）。

## 问题

> "**唯一现存传递通道是 `shared.md`**……不经 daemon、无鉴权、无审计、无结构、整链单文件全量读；并行分支同时 append 是竞争源。" — #545「现状事实」

#545 核心设计的结构化受控通道没有任何存储与写入载体：无 entry 表、无写命令、无 author 推导、无 admission。读取面、group scope、执法三个后续 child 全部以本 child 为地基被阻塞。

## 预期结果

性质表述：

1. **envelope 全链路 ADT**：scope 是封闭 union（`item | chain | group` 三 variant，穷尽 switch——新增 scope 不过编译）；author 是封闭 union（operator variant | agent variant 含 chain/item/run/phase），**仅由凭证解析路径构造**（构造器收紧，#406 `ItemMutationCaller` 同款）——不存在客户端自报 author 的可达路径，请求里的自报字段无效或被拒。
2. **一切写入经 daemon socket**：文件系统上不存在 entry 的可直写对应物；写命令在 `DaemonCommandName` / `buildDaemonCommandSpecs` 穷尽分类中有归属且 agent 可用（凭证限定所属 chain）；operator 无凭证写任意 chain。每次写入判定（接受与拒绝）emit 审计事件。
3. **append-only 性质**：不存在 agent 或 operator 可达的 entry 更新/删除命令路径；唯一删除通道是 `chain delete` 级联清除（entries 与 chain 同生共死，无独立 GC）。
4. **body 不透明**：写入→存储全程 body 逐字携带，无解析、无正则、无 marker 识别；body 内容（含状态字面量、`FINALIZER SUMMARY` 等控制记号）不影响任何调度或状态决策。
5. **无任意 hard cap、无截断**：context body 不设置引擎自造字节上限。若实现触及经文档和实测确认的 socket/SQLite/CLI 外部限制，admission 只可点名该真实限制并显式拒绝；不得截断或静默丢内容。证据类大内容走 evidence 引用。
6. **scope 键解析有效**（拆解期裁决，理由见 #545 树登记 comment）：落库 entry 的 scope 键解析到本 chain 内真实存在的寻址对象——item scope 键指向存在的 item，group scope 键指向树运行态中存在的 par 容器，chain scope 键即 chain 自身；不存在指向虚空的 entry（typo 不静默丢失，与 admission default-deny 哲学一致）。
7. **group scope 的 v2 语义**：v2 无树运行态 ⇒ 不存在任何可寻址的 par 容器 ⇒ group scope 写入在 admission 一律拒绝、错误信息点名原因。这是性质 6 在 v2 的自然推论（非 stub、非兜底）；正路径（真 par 容器下的键解析）归 group 真实化 child（Depends on #558）。

### 已裁决的 envelope 与寻址形态

- body 不设引擎任意字节上限且永不截断；真实外部协议限制若存在，必须以来源明确的 boundary error 暴露。
- v3 首版 envelope 不加入自由 `topic`/tag。`item | chain | group` scope 已是语义闭集；未来若出现不能由 scope + author + cursor 表达的真实查询场景，再按新增 ADT 字段流程立 issue，不预埋松散字符串。
- 写命令必须显式提交 scope variant；`item`/`group` 同时提交目标稳定 ID，`chain` 无额外 key。agent 可指定凭证所属 chain 内任一真实 item/group，符合“chain 内随意读写”；operator 可指定任一 chain 内真实对象。所有路径都做存在性校验，不做隐式“猜当前 group”或静默 fallback。

## 不应残留

- 本 child 范围内：任何绕过 socket 的 entry 写路径；envelope 以匿名形状或裸 JSON 透传（无 arktype 边界）；scope/author 的 stringly switch 无穷尽检查；agent 或 operator 可达的 entry 更新/删除路径；body 的任何解析、截断或语义提取代码；无真实外部依据的字节 hard cap；自由 topic/tag 字符串；scope key 隐式猜测或 fallback。
- 本 issue 范围之外不应改动：`shared.md` 机制零改动（#545 范围外首条——重定位是定位陈述，不是实施项）；读取命令面（归读取 child）；group 键推导（归 group 真实化 child）；`required | expected` 执法（归执法 child）；`[phases.rights]` 不扩展（裁决 3）。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。依据：#78 / #109、#453 契约 T3/T5。
- #396 边界（#545 约束节逐字）："引擎对 entry body 零解析、零语义提取；body 内容不得影响任何调度或状态决策（#396 内容通道 ≠ 流转信号）。"
- 不新增第三类主体：读写主体沿用 #406 的 `operator | agent(run)` 和类型（#545 约束节）。
- schema 迁移保既有数据：走 `migrateStateSchema` 既有事务模式，旧 chain 数据完好。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 触同一批 `src/daemon.ts`/`src/scheduler.ts` 面，默认它们先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 写入经 CLI 落库且 author 凭证推导（RFC 关闭验证行 1） | agent 凭证 env 下经写入命令写 entry，请求中夹带自报 author 字段 | local | entry 落库、author = 凭证所属 (chain,item,run,phase)；自报字段无效或被拒 |
| function | append-only（RFC 行 3） | 枚举 socket 命令面（`DaemonCommandName` union 审查）+ 对已有 entry 尝试更新/删除 | local | 不存在 agent 或 operator 可达的更新/删除命令；尝试报错 |
| function | chain 级联 GC（RFC 行 8） | 写入若干 entry 后 `coder-loop chain delete`，查 entries 表 | local | 该 chain entries 全部清除 |
| function | operator 无凭证写任意 chain（RFC 行 7 写半边） | 无凭证 env 经写入命令向任一 chain 写 entry | local | exit 0；entry author subject = operator |
| function | 大内容不截断 | 写入跨多个常规 CLI buffer 大小的 UTF-8 body 并读回；同时检查代码中 context 专属 hard cap | local | 逐字 round-trip；无截断、无 context 任意 hard cap；若命中有来源的外部协议限制则显式 boundary error 点名来源 |
| function | scope 键解析有效 | 经允许显式指定的路径（至少 operator）写入指向不存在 item 的 item-scope entry | local | admission 拒绝，错误点名寻址对象不存在 |
| function | group 无容器拒绝 | v2 形态 chain 下写 group scope entry | local | admission 拒绝，错误信息点名「不存在可寻址的 par 容器」类原因 |
| adversarial | body 不透明（RFC 行 4） | `bun test` 含用例：store 预置 body 为状态字面量与 `FINALIZER SUMMARY: decision=complete` 的 entries，跑 `schedulerTick`，断言调度决策、item status、trigger 判定与无 entries 基线完全一致 | local | 断言通过：调度、状态机、trigger 判定零受影响 |
| integration | shared.md 并存零回归（RFC 行 9） | `bun scripts/real-e2e.ts` | local | 绿（PR MERGED / issue CLOSED）；shared.md 创建与注入行为与现状一致 |
| environment | 审计可见 | 一次接受 + 一次拒绝写入后以 operator 查 events | local | 两次判定各有审计事件，含判定结果与原因 |
| type | ADT 完好 | `bun run typecheck && bun test`；审查 envelope/scope/author 类型定义 | local | 全绿；封闭 union + 穷尽检查，无匿名形状，author 无公开构造路径 |

## 依赖关系

- Depends on: 无（本树地基）。
- Blocks: #595（读取命令面）、#596（group scope 真实化）、#597（「必须调用」执法）、#598（收尾对齐）。




---

## Comments (2)

### comment #4953820892 by `RiriAgent` — 2026-07-13T02:13:30Z

<!-- coder-loop:executable-contract schema=1 source-issue=594 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/594
- Observed issue-body edit timestamp: `2026-07-11T01:08:42Z` (`lastEditedAt`; editor `RiriAgent`). The complete issue timeline and all comments were re-read on 2026-07-13; the issue had zero comments before this marker.
- Operator-comment URLs used: none. The live issue body is the intent authority; the parent decomposition record is https://github.com/mouriya-s-lab/coder-loop/issues/545#issuecomment-4866615198.
- Historical implementation evidence only: closed/unmerged PR https://github.com/mouriya-s-lab/coder-loop/pull/655 and its review comments https://github.com/mouriya-s-lab/coder-loop/pull/655#issuecomment-4949383353, https://github.com/mouriya-s-lab/coder-loop/pull/655#issuecomment-4949466125, and closure decision https://github.com/mouriya-s-lab/coder-loop/pull/655#issuecomment-4953444053. Per that closure decision, PR #655 is not a code-migration or cherry-pick source; implementation restarts from current `main`.

## Deliverable

`implementation-pr`

One new PR from current `main` must close exactly #594. It implements only the context-entry storage/write foundation: closed envelope ADTs, append-only SQLite persistence, daemon-socket write command, credential-derived author, admission/audit, scope-key validation, and explicit soft-delete GC. Reading, real group-container support, `required | expected` enforcement, `shared.md` changes, and GUI work remain outside this issue.

## Checks

All rows are `shell` because coder-loop is a CLI/daemon/backend project and this issue has no browser behavior. Commands run from the issue checkout unless a row says otherwise.

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C01 | type | shell | `bun run typecheck`; cwd = repo root; normal local env | Exit 0. Context scope, author, request, stored entry, response, error/reason and audit payload flow through precise types; no forbidden type degradation. |
| C02 | focused | shell | `bun test src/context-entry.test.ts src/sqlite-state.test.ts src/daemon.test.ts src/central-cli.test.ts src/scheduler.test.ts`; cwd = repo root | Exit 0. All new context, migration, daemon/CLI, credential, scheduling-opacity and premature-socket-close regressions pass. |
| C03 | suite | shell | `bun test`; cwd = repo root | Exit 0 with zero failures. Existing tests are not removed, renamed, skipped or weakened to obtain green. |
| C04 | author/admission | shell | `bun test src/daemon.test.ts -t "context append derives author from credential"`; cwd = repo root | Exit 0. A live agent credential produces author `(chain,item,run,phase)` derived by the daemon; a client-supplied author key is boundary-rejected and cross-chain/unknown/inactive credentials are denied. |
| C05 | operator/audit | shell | `bun test src/daemon.test.ts -t "context write admission audit"`; cwd = repo root | Exit 0. Credential-free operator append succeeds with `author.kind=operator`; at least one allow and one deny each emit a context-write admission audit event with outcome and reason. |
| C06 | scope | shell | `bun test src/daemon.test.ts -t "context scope admission"`; cwd = repo root | Exit 0. Existing item scope is admitted; missing item is denied with `item-not-found` or an equally typed reason; v2 group scope is denied with `group-unavailable-v2` or an equally typed reason naming absence of an addressable par container; chain scope targets the selected chain. |
| C07 | append-only/GC | shell | `bun test src/sqlite-state.test.ts -t "context entries are append-only and removed by chain delete"`; cwd = repo root | Exit 0. No update/delete store or daemon command is reachable; append persists; the existing soft-delete `chain delete` path explicitly removes all entries for that chain while other chains survive. |
| C08 | migration | shell | `bun test src/sqlite-state.test.ts -t "context schema migration preserves existing data"`; cwd = repo root | Exit 0. A real pre-current schema fixture migrates transactionally, preserves existing chains/items/runs/current-runs, creates the new table/indexes, and re-open is idempotent. |
| C09 | opaque body | shell | `bun test src/scheduler.test.ts -t "context body is opaque to scheduling"`; cwd = repo root | Exit 0. Bodies containing status literals and `FINALIZER SUMMARY: decision=complete` leave item status, selected phase, trigger decisions and scheduler result identical to a no-entry baseline. |
| C10 | direct CLI runtime | shell | `bun test src/central-cli.test.ts -t "context append real daemon runtime"`; cwd = repo root | Exit 0. The test must spawn `bun src/loop.ts daemon up` on an isolated local loop-data root, wait for its Unix socket, invoke the real `bun src/loop.ts context append` operator and live-agent paths, round-trip a multi-megabyte UTF-8 body byte-for-byte through SQLite, observe typed negative paths, prove an orderly peer `end`/`close` after a response prefix rejects instead of hanging, then run daemon down and prove shutdown. No mock daemon or direct store substitution counts. |
| C11 | command surface | shell | `bun src/loop.ts context update`; cwd = repo root; no run credential | Non-zero exit with an invalid/unknown context subcommand error. Repeat with `delete`; neither command may exist in `DaemonCommandName`, CLI routing, daemon specs or store API. |
| C12 | repository E2E | shell | `bun scripts/real-e2e.ts --fixture-cwd /Users/mouriya/Ext/code/coder-loop-e2e-fixture`; cwd = repo root; configured `gh`/runner auth, isolated harness root | Exit 0; harness reports its seed PR `MERGED`, seed issue `CLOSED`, fixture check passed, daemon stopped, fixture removed and mutex released. This is the repository-mandated engine/daemon integration gate and supporting acceptance evidence; C10 is the direct context-write Layer-4 behavior proof. |

## Pattern scope

| ID | Scope | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|---|
| P01 | `changed` | Review added/modified TypeScript for explicit `any`, non-`const` `as` assertions, anonymous/unparsed boundary objects, unchecked maps, or `unknown` propagated past parsing/catch boundaries. Query the complete `origin/main...HEAD` diff and inspect every hit in context-related code. | `unknown` only at an external parse or catch boundary; `as const` only. No other exception. | Zero violating changed sites; boundary inputs are parsed with arktype into named precise types before internal flow. |
| P02 | `changed` | `ContextScope`, `ContextAuthor`, request protocol, persisted envelope and expected failures must be discriminated unions/products with exhaustive handling. Query their definitions and every `kind` switch/branch in the complete diff. | One canonical context-owned type module plus typed import consumers; no duplicate anonymous envelope shapes. | Exactly three scope variants (`chain`, `item`, `group`) and two author variants (`operator`, `agent`); adding a variant makes exhaustive handling fail typecheck. Client requests have no author construction path. |
| P03 | `whole-tree` | `rg -n '"context\.(update|delete)"|updateContextEntry|deleteContextEntry' src -g '!*.test.ts'` | None. Chain deletion may call a narrowly named chain-GC primitive that deletes all entries as lifecycle cleanup, not an entry mutation API. | No agent/operator context-entry update/delete command, handler or store method exists. The only deletion behavior is explicit chain lifecycle GC. |
| P04 | `changed` | Inspect every read of context `body` added by the diff and query changed non-test code for status/marker/summary parsing adjacent to context code. | Transport chunk assembly, exact persistence, serialization, and test-only equality/assertion reads. | Zero semantic parsing, regex/marker recognition, scheduling/status/trigger branching, truncation, arbitrary byte cap, topic/tag field, implicit scope-key guess or fallback. |
| P05 | `changed` | Inspect new daemon commands against `DaemonCommandName`, `buildDaemonCommandSpecs`, `runAuthorizationGate`, credential injection allow-list and observability boundary unions. | The context append protocol may use multiple typed begin/chunk/commit socket commands to preserve complete large-body transport. | Every new command is exhaustively classified, agent-attributed where required, audited on accept/reject, and unreachable by filesystem direct write. No dead caller field such as PR #655's unread `rowId` remains. |

## Canonical runtime

- Setup: `bun install --frozen-lockfile`; verify Bun, `gh`, configured runner CLI, and `/Users/mouriya/Ext/code/coder-loop-e2e-fixture` origin. Use a local isolated loop-data directory; do not touch production `~/.coder-loop`.
- Start: `bun src/loop.ts daemon up --loop-data-root <isolated-local-root> --json`.
- Readiness: wait until `<isolated-local-root>/daemon.sock` accepts `bun src/loop.ts daemon status --loop-data-root <isolated-local-root> --json`; file existence alone is not readiness.
- Behavior: drive the real `bun src/loop.ts context append <chain> --scope <typed variant> ...` CLI through the daemon socket for operator, live-agent credential, missing-item, v2-group, forged/inactive credential, large UTF-8 body, audit, append-only and chain-delete GC paths. The exact final flag spelling must come from the implemented typed CLI help; no direct SQLite write may substitute for append behavior.
- Canonical repository E2E driver: `bun scripts/real-e2e.ts --fixture-cwd /Users/mouriya/Ext/code/coder-loop-e2e-fixture` as mandated by `CLAUDE.md` and `docs/real-e2e-fixture.md` for daemon/engine changes. It must observe a real fixture PR merge and issue closure.
- Logs: capture direct CLI stdout/stderr, daemon status, relevant audit events, exact byte comparison and GC counts under the issue evidence directory; the PR packet must cite the current tested SHA and commands.
- Stop ownership: the test/driver that starts each isolated daemon owns `bun src/loop.ts daemon down --loop-data-root <isolated-local-root> --json`, child-process settlement, isolated-root cleanup and E2E mutex release. No phase-owned process may remain.

## Test delta

`required`

New tests must cover the context ADTs/boundaries, schema migration and preservation, append-only/soft-delete GC, operator and credential-derived author, agent chain confinement, missing-item and v2-group rejection, accept/deny audits, exact multi-chunk UTF-8 transport, body opacity against `schedulerTick`, and the PR #655 review regression where an orderly socket `end`/`close` before all sequence responses must reject rather than leave the CLI pending. Existing assertions survive unchanged: no removal, rename, skip, timeout inflation, narrowing, mock substitution, or weakening merely to pass. The PR must report base/head test inventory from the same `bun test` command and explain every delta.

## Dependencies

- Current implementation base is `main@f01560d5d0b324e791db7f599e502f09fc78a652`; local source inspection confirms schema v13 and no context command/table/module on main (`src/sqlite-state.ts`, `src/daemon.ts`, `src/loop.ts`).
- #535, #536 and #538 are closed by merged PRs #616, #619 and #610, so the issue's audit-tree ordering prerequisite is satisfied on current main.
- #558 remains open, but it is not a blocker for #594: v2 has no addressable par container, so group writes must be explicitly denied. Positive group scope belongs to #596 after #558.
- #594 blocks open children #595, #596, #597 and #598. Do not absorb their read API, real group resolution, enforcement, docs or GUI scope.
- PR #655 is closed and unmerged at `df1850a60287fc265e8766fe957384c9e464adba`. Its diff and review are historical investigation only; its closure comment explicitly forbids treating it as a migration/cherry-pick source. A fresh implementation must independently avoid its premature-socket-close hang and dead `ItemMutationCaller.agent.rowId`.
- The repository has no `.github/workflows`; local typecheck, full suite, direct runtime and canonical real-E2E evidence are therefore the active gates. `mouriya-s-lab/coder-loop-e2e-fixture` is currently reachable as a private repo, its default branch is `main`, and the local fixture checkout origin matches.
- No external blocker is currently verified. If configured GitHub/runner auth or fixture reachability fails during C12, report that concrete infrastructure failure rather than weakening or omitting the gate.

## Supersedes

none



### comment #4957262111 by `RiriAgent` — 2026-07-13T11:04:11Z

## Coder-loop closure review (run-1783937728307-85-review-item-7)

Review verified this issue is fully handled.

- Acceptance criteria: independently replayed, all rows matched.
- Child/subtask issues: this atomic issue has no own subissues.
- Final transition made by coder-loop review.

Reason:
PR #677 at head `22b68aae1ffcadfe3910fbf6b7c2221f2ed1c327` passed independent diff-audit and replay: all ten changed files mapped, P01–P05 converged with zero sites, C01–C12 all matched, the canonical suite passed 520/520, direct CLI/daemon/operator/live-agent claims matched, and C12 observed fixture issue #512 CLOSED / PR #513 MERGED. PR #677 was squash-merged as `d381d06c0a55385fb211283adcfb05ffade94f88`.



---

## Timeline (20)

- 2026-07-02T14:03:55Z `assigned` @RiriAgent
- 2026-07-02T14:04:08Z `cross-referenced` @RiriAgentsrc=595
- 2026-07-02T14:04:23Z `cross-referenced` @RiriAgentsrc=596
- 2026-07-02T14:04:29Z `cross-referenced` @RiriAgentsrc=597
- 2026-07-02T14:04:40Z `cross-referenced` @RiriAgentsrc=598
- 2026-07-02T14:05:19Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:05:39Z `cross-referenced` @RiriAgentsrc=545
- 2026-07-12T00:04:05Z `cross-referenced` @RiriAgentsrc=655
- 2026-07-13T02:13:30Z `commented` @RiriAgent
- 2026-07-13T06:08:51Z `cross-referenced` @RiriAgentsrc=677
- 2026-07-13T10:10:20Z `referenced` @RiriAgentcommit=22b68aae1ffcadfe3910fbf6b7c2221f2ed1c327
- 2026-07-13T11:03:53Z `closed` @RiriAgentcommit=None
- 2026-07-13T11:03:53Z `referenced` @RiriAgentcommit=d381d06c0a55385fb211283adcfb05ffade94f88
- 2026-07-13T11:04:11Z `commented` @RiriAgent
- 2026-07-16T23:38:35Z `referenced` @RiriAgentcommit=05ee53cc42027da2343ce5f24c5a0103e919fdb8
- 2026-07-17T20:37:02Z `cross-referenced` @RiriAgentsrc=730
- 2026-07-17T20:37:04Z `cross-referenced` @RiriAgentsrc=731
- 2026-07-17T20:37:06Z `cross-referenced` @RiriAgentsrc=732
- 2026-07-17T20:37:08Z `cross-referenced` @RiriAgentsrc=733
- 2026-07-17T20:37:11Z `cross-referenced` @RiriAgentsrc=734