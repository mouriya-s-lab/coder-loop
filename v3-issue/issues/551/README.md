# #551 引擎 GitHub 记法与 repository 原语退役

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:12:03Z  | updated: 2026-07-26T16:15:19Z
- closed: 2026-07-26T16:15:19Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/551
- comments: 3  | timeline events: 20

---

## Body

## 必须先读的关联 issue

#547（RFC: v3 类型系统）。本 child 承接其裁决 H 在四处残留上的执行，零原语退役清单对应行逐字快照：

> "`REPOSITORY_REF_PATTERN` + `chains.repository NOT NULL`｜`src/daemon.ts:395`、`src/sqlite-state.ts`｜`repository` 降为 chain binding 业务字段，引擎不校验格式不设物理列；`baseBranch` 保留引擎一等（worktree 机制真实消费，`src/scheduler.ts` `chooseWorktreeStartRef`）" — #547 零原语退役清单

> "`--issue` CLI flag（六处）｜`src/loop.ts` 命令树 + epilogue 文本｜干净改名 `--item`，不留 alias" — #547 零原语退役清单

> "`normalizeQueueIssueId`（GitHub 记法解析）｜`src/loop.ts:4000`｜退役；引擎收 opaque string，记法便利归调用方工具" — #547 零原语退役清单

> "`inferRepositoryFromGit`｜`src/loop.ts:3977`｜随 repository 降级退役" — #547 零原语退役清单

裁决 H 总则："六残留全部退役（下节清单）；引擎不得以任何 preset 名兜底"（第 1 处 `DEFAULT_PRESET_NAME` 归 chain 级声明化 child，第 6 处 doctor 归 [[tools]] child——本 child 承接第 2–5 行即上引四处）。

## 目标

引擎的 CLI/解析/存储面退役全部 GitHub 记法与 repository 格式假设：opaque item id、repository 降为 chain binding 业务字段、`--issue` 干净改名 `--item`。

## 使用场景

- 非 GitHub target（GitLab、纯本地任务、任意字符串 id 的 preset）可以建 chain 跑 loop——现状 `chains.repository NOT NULL` + GitHub owner/repo 正则使之不可能。
- agent 与 operator 面对的 CLI 词表与引擎真实模型一致（item 而非 issue）——`item exits --item <ID>`，preset prompt 的 epilogue 文本同步。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main@a007fa4（行号实施前自行核对）。

- `REPOSITORY_REF_PATTERN`（`src/daemon.ts:395`，消费点 `src/daemon.ts:3925`）；`chains.repository` 物理列（`src/sqlite-state.ts`，schema v13）。
- `normalizeQueueIssueId`（`src/loop.ts:4000`，消费点 `src/loop.ts:3640`）解析 `owner/repo#123` / `#123` GitHub 记法；`inferRepositoryFromGit`（`src/loop.ts:3977`，消费点 `src/loop.ts:3819`）只认 `github.com` URL。
- `--issue` flag：命令树多处（`src/loop.ts:1474/1562/1594/1624/1658/3643`）+ usage/epilogue 文本（`src/loop.ts:2668/5330/5339`），注释自证 backward-compat 性质（`src/loop.ts:258`、`1754`、`3641`）。
- `baseBranch` 的引擎一等地位保留：worktree 机制真实消费（`chooseWorktreeStartRef`，`src/scheduler.ts:814/2432`）。
- chain bindings 既有通道：`ChainMetadata.bindings`（`src/runtime-data.ts:105-135`）——repository 的新家。
- real-e2e fixture（`mouriya-s-lab/coder-loop-e2e-fixture`）经 `--repository` 语义建 chain——迁移后全链路必须仍绿。

对抗审查第 6 轮（2026-07-02，调用面全集扫描）新发现三处同类残留——RFC 六处清单之外、与本 child 同一问题类（引擎解析/私运 GitHub 记法），并入本 child 范围：

- `parseBatchItemsJson` 的 legacy back-fill（`src/loop.ts:2068-2084`）：batch JSON 的 `{"issue": …}` / `{"issueNumber": …}` → `itemId` 记法 alias——「干净改名不留 alias」同精神下退役。
- `--umbrella` flag + `parseUmbrellaRef`（`src/loop.ts:1879-1886`、`2094-2102`）：CLI 解析 `owner/repo#123` GitHub 记法，且硬编码 bundled preset 业务 binding 名 `umbrellaRepo` / `umbrellaIssue` 字面量——双重违反（记法解析 + L2 词表进 L1）。显式通路已存在且优先（`--config-json '{"umbrellaRepo":…}'` wins-on-conflict，`src/loop.ts:1883` 注释自证）；flag 退役，记法便利归调用方工具。`scripts/ templates/ docs/` 零使用（2026-07-02 核实），退役无外溢。
- `queue.unblock` 的 socket wire 字段 `issue`（`QUEUE_UNBLOCK_ARG_KEYS`，`src/daemon.ts:498`，消费 `src/daemon.ts:2072`）：#419 `itemId` 迁移漏网（batch 面已用 `itemId` wire 字段）；#548 将把 socket 正式化为第三方调用契约，GitHub-shaped wire 字段会泄进对外契约——一并改名 `itemId`。其余 socket 处理器内部的 TS 局部变量名（`args.issue` 等）是 b 类实现细节，不设验收。

## 问题

> "引擎是通用解释器……唯一落点是定义装载期" 的前提下，引擎却在 CLI/解析/存储三面私运 GitHub 形状（#547 定位事实 + 零原语清单）；`REPOSITORY_REF_PATTERN` + NOT NULL 物理列使 "非 GitHub 场景无法建 chain"（`v3/survey-engine-daemon.md` §9 第 6 条）。

这是 #453 T1（引擎零 GitHub 原语）红线的存量违反面，v3 承诺清零（RFC 关闭验证行 2）。

## 预期结果

性质表述：

1. **opaque id**：引擎对 item id 只做「非空、无空白」等中性校验，不解析任何引用记法；`normalizeQueueIssueId`、`inferRepositoryFromGit`、batch JSON 的 `issue`/`issueNumber` legacy back-fill、`--umbrella`/`parseUmbrellaRef` 物理移除，记法便利归调用方工具（skill / 外挂）。`queue.unblock` socket wire 字段 `issue` 改名 `itemId`（与 batch 面既有 wire 字段一致）。
2. **repository 是业务字段**：引擎不校验其格式、不设物理列——迁入 `chain.metadata.bindings`（SQLite migration，schema 版本 bump，既有 DB 升级数据无损）；`REPOSITORY_REF_PATTERN` 物理移除；消费 `chain.repository` 的引擎路径改读 binding 或退役。`baseBranch` 保留引擎一等。
3. **CLI 词表与模型一致**：`--issue` → `--item` 干净改名，不留 alias；usage/epilogue 文本与**全部** bundled preset fragment 文本同步（2026-07-02 核实命中面：`gh-issue-pr-iteration` 的 `review/actions/*.md`、`plan/init-queue.md`（该文件随 #556 plan 面退役消失，两序皆可）、`real-e2e-minimal/review-entry.md`）；`grep -rn -- '--issue' src/ presets/` 零命中。
4. **可验证清零**：RFC 关闭验证行 2 的 grep 在本 child 份额（`REPOSITORY_REF_PATTERN|normalizeQueueIssueId|inferRepositoryFromGit`）无命中。

## 不应残留

- 本 child 范围内：上述三符号及其消费路径；`--issue` 字面量（代码、usage、epilogue、bundled preset prompt）；`chains.repository` 物理列与 NOT NULL 约束；batch JSON 记法 alias、`--umbrella`/`parseUmbrellaRef`、`queue.unblock` wire 字段 `issue`（审查第 6 轮并入的三处，见上下文）。
- 范围之外不动：`DEFAULT_PRESET_NAME`（归 #557）、doctor `gh` 检查（归 #553）、#534 audit 树在修的 v2 缺陷。`chain create --repository` flag 保留为写 binding 的糖（已裁：物理列退役不连带破坏既有调用方 CLI 面；flag 变为可选）。

## 约束

- 代码红线（#547 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。"
- 干净改名是裁决（"不留 alias"）——不做兼容期、不做废弃告警期。
- SQLite migration 必须从 v13 单向升级、既有 chains 数据无损；migration 先例形态见 #419（`issue_number` → `item_id`）。
- 排序默认（总控简报）：#534 audit 树 children（#535/#536/#538 触 `src/daemon.ts`/`src/scheduler.ts` 同一批面）先合，本 child 在其后 rebase。

## 本 issue 的验证边界

- **验证层级**：preset compile/render contract、受影响 fragment/CLI 的目标测试，以及使用确定性 runner 的最小调度 integration。
- **本 issue 必须证明**：修改后的声明或 prompt 能被当前引擎装载并进入预期分支，旧制度性指示/旧词表按正文清单消失；不得只靠 grep，也不得要求真实 agent 替代确定性断言。
- **不在本 issue 内执行**：本 issue 不自行运行完整 GitHub issue→PR→merge→close。改动合流后的 `real-e2e-minimal`/`gh-issue-pr-iteration` compatibility 由 #685 在冻结发布候选 SHA 上统一证明；涉及 v3 新运行态的接缝由 #684 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 三符号清零（RFC 关闭验证行 2 本 child 份额） | `grep -rnE 'REPOSITORY_REF_PATTERN\|normalizeQueueIssueId\|inferRepositoryFromGit' src/` | local | 无输出 |
| function | `--issue` 字面量清零 | `grep -rn -- '--issue' src/ presets/` | local | 无输出 |
| function | 记法 alias 与 umbrella 便利面清零 | `grep -rnE 'parseUmbrellaRef\|umbrellaRepo\|umbrellaIssue\|issueNumber' src/` | local | 无输出（`umbrellaRepo`/`umbrellaIssue` 在 presets/ 内属 L2 业务命名空间，合法保留） |
| function | socket wire 字段迁移 | `grep -n '"issue"' src/daemon.ts` | local | 无 wire 字段命中（`idField = "issue"` 类 preset 业务值若命中，逐条在 PR evidence 说明其非 wire 性质） |
| function | 非 GitHub chain 可建 | fixture：不带 repository、item id 为任意字符串（如 `task-001`）建 chain + `item add` + `status --json` | local | 创建成功，`state.kind == "ok"`，queue 可见该 item |
| function | 记法不再被解析 | `item add` 传 `owner/repo#12` 形态 id → 存储与 status 输出 | local | 原样 opaque 存取，无 normalize |
| integration | migration 数据无损 | 用 v13 库（含既有 chain/repository 值）启动新 daemon → `coder-loop status <target> --json` | local | schema 升级成功，repository 值可从 bindings 读回，items/runs 完好 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: 无树内硬上游。
- 排序边: #534 audit 树（#535/#536/#538）先合。
- 与 #557（chain 级声明化 child）各自迁移 `chains` 表不同列（`repository` vs `preset` 语义），后合者 rebase migration 序号。


---

## Comments (3)

### comment #4865081875 by `RiriAgent` — 2026-07-02T11:14:36Z

## 架构切片

1. **系统定位**：L1 引擎的 CLI 命令树与 SQLite 存储边界级（loop.ts 命令解析 + sqlite-state schema）。
2. **全局坐标**：调用方记法域（`owner/repo#123` 等 GitHub 便利记法，归 skill/外挂）→ 引擎 opaque id 域（中性字符串，仅非空/无空白校验）。repository 从引擎物理域迁至 chain binding 业务域（`chain.metadata.bindings`）。
3. **类型↔值不漂移**：防类型泄露——GitHub 记法正则与 owner/repo 格式是 L2 业务词表编进 L1 编译期代码；退役后引擎类型不编码任何 forge 形状。
4. **消除的错误类别**：「非 GitHub target 无法建 chain」不可表达；「引擎静默改写调用方 id」（normalize）不可表达。

## log/观测义务

- 无新事件义务；既有 mutation 审计事件字段名随 `--item` 改名同步（PR body 列 shape diff）。
- migration（schema v13→v14）沿 #419 先例：升级路径在 daemon 启动日志可见。



### comment #4953810122 by `RiriAgent` — 2026-07-13T02:11:07Z

<!-- coder-loop:executable-contract schema=1 source-issue=551 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/551
- Observed body revision: `2026-07-11T00:50:18Z` (`lastEditedAt`; editor `RiriAgent`).
- Operator comment used: https://github.com/mouriya-s-lab/coder-loop/issues/551#issuecomment-4865081875 (L1 boundary, opaque-id direction, migration/log obligations).
- Parent/RFC clarifications used: https://github.com/mouriya-s-lab/coder-loop/issues/547#issuecomment-4865089013 and https://github.com/mouriya-s-lab/coder-loop/issues/547#issuecomment-4865384529.
- Historical implementation evidence only: https://github.com/mouriya-s-lab/coder-loop/pull/659. This draft PR is closed and unmerged; its closing comment requires a fresh implementation from current `main`. Do not cherry-pick or transport its tree.

## Deliverable

`implementation-pr`

One fresh PR from current `main` closes only #551. It retires GitHub-shaped item/reference parsing and storage assumptions while preserving `baseBranch` as an engine mechanism and retaining `chain create --repository` solely as optional sugar that writes `metadata.bindings.repository`.

## Checks

| ID | Dimension | Kind | Executable contract |
|---|---|---|---|
| C01 | retired symbols | shell | Cwd: repository root. Run `grep -rnE 'REPOSITORY_REF_PATTERN\|normalizeQueueIssueId\|inferRepositoryFromGit' src/`. Expect exit `1` and no output. |
| C02 | CLI vocabulary | shell | Cwd: repository root. Run `grep -rn -- '--issue' src/ presets/`. Expect exit `1` and no output; operator and agent commands, usage, epilogue, scripts, tests, and bundled preset fragments use `--item`. No alias remains. |
| C03 | notation aliases and L2 leakage | shell | Cwd: repository root. Run `grep -rnE 'parseUmbrellaRef\|umbrellaRepo\|umbrellaIssue\|issueNumber' src/`. Expect exit `1` and no output. The same business binding names remain legal under `presets/`, not under `src/`. |
| C04 | queue.unblock wire | shell | Cwd: repository root. Run `grep -n '"issue"' src/daemon.ts`. Expect exit `1` and no output, except that any surviving preset-business value must be enumerated in PR evidence and shown not to be a socket field. `queue.unblock` accepts required `itemId`, and malformed/missing response `mutation.itemId` fails at the boundary rather than falling back. |
| C05 | non-GitHub chain | shell | Cwd: repository root; use a fresh local `/tmp/coder-loop-551-nongh-*` loop-data root and a minimal absolute preset path. Through the real CLI and daemon, run `daemon up`, `chain create` without `repository`, `item add --item task-001`, then `status --json`. Expect command exits `0`, `.state.kind == "ok"`, and the queue contains literal `task-001`. Do not substitute direct SQLite writes for this row. |
| C06 | opaque notation | shell | In the same isolated real CLI/daemon path, add or run item id `owner/repo#12` with `--item`. Read `item list` and `status --json`. Expect the literal value to round-trip unchanged; no stripping of `#`, repository inference, or normalization. |
| C07 | repository binding and optional sugar | shell | In an isolated root, create one chain without `--repository` and one with `chain create --repository local/target`; read `chain status`/`status --json`. Expect both creations to succeed, the first to have no repository binding, and the second to expose `metadata.bindings.repository == "local/target"`; arbitrary non-`owner/repo` binding strings accepted through the generic config/binding path are not forge-validated. `baseBranch` remains a first-class chain field. |
| C08 | v13 migration | shell | Build a v13 SQLite fixture containing a chain repository value plus at least one item and run, start the new daemon on it, then inspect `PRAGMA user_version`, `PRAGMA table_info(chains)`, status/chain output, items, and runs. Expect v13→v14, no physical `chains.repository` column, the exact legacy value at `metadata.bindings.repository`, and unchanged item/run data. A fixture where an existing binding conflicts with the physical value must fail loudly without choosing either value. |
| C09 | focused integration | shell | Cwd: repository root. Run `bun test src/sqlite-state.test.ts src/daemon.test.ts src/central-cli.test.ts src/loop.test.ts src/runtime-paths.test.ts src/scheduler.integration.test.ts`. Expect exit `0`; named coverage must exercise C05–C08, clean `--item` parsing, removed batch aliases/umbrella flag, and `queue.unblock.itemId` positive and malformed-boundary cases. |
| C10 | type and full suite | shell | Cwd: repository root. Run `bun run typecheck && bun test`. Expect exit `0`, zero failures/errors/timeouts, and no skipped/only/todo tests introduced for this work. Record base/head test inventory and explain every removed, renamed, or added test. |
| C11 | real GitHub loop | shell | Cwd: repository root; `RiriAgent` active in `gh`; fixture checkout/repo as documented in `docs/real-e2e-fixture.md`; serialized isolated daemon/root owned by the script. Run `bun scripts/real-e2e.ts`. Expect exit `0`, a real fixture PR `MERGED`, its issue `CLOSED`, repository binding still reaching the GitHub preset, and teardown removing this run's daemon/socket/fixture resources. This is the repository-mandated canonical E2E driver and the Layer 4 evidence for this non-UI change. |

## Pattern scope

| Type | Pattern/query | Allowed sites | Expected convergence |
|---|---|---|---|
| whole-tree | `REPOSITORY_REF_PATTERN|normalizeQueueIssueId|inferRepositoryFromGit` under `src/` | none | zero matches |
| whole-tree | literal `--issue` under `src/` and `presets/` | none | zero matches; clean rename to `--item` |
| whole-tree | `parseUmbrellaRef|umbrellaRepo|umbrellaIssue|issueNumber` under `src/` | none | zero matches; preset-owned umbrella names may remain only under `presets/` |
| whole-tree | socket/request key literal `"issue"` under `src/daemon.ts` | only a demonstrably preset-owned data value, individually listed in evidence | no queue/item wire selector named `issue`; queue unblock uses `itemId` |
| whole-tree | `chains` schema/row model/query projections for repository in `src/sqlite-state.ts` | v13 migration input reads only | no current physical column or `ChainRecord.repository`; migration reads the legacy column only while rebuilding v14 |
| changed | chain-create repository handling and scheduler/prompt binding construction | CLI sugar boundary and `metadata.bindings.repository` consumer only | repository is optional business data; no format validator; no git-origin inference; `baseBranch` remains engine-owned |
| changed | batch item parser and umbrella CLI parsing | typed `itemId` batch field and explicit generic `--config-json` bindings only | legacy `issue`/`issueNumber` back-fill and `--umbrella` shorthand are physically removed without aliases |

## Canonical runtime

- Setup: use current `main` (`f01560d5d0b324e791db7f599e502f09fc78a652` at enrichment time), verify `RiriAgent` is the active GitHub account, and install with `bun install --frozen-lockfile` when dependencies are absent.
- Start: for direct smoke/migration rows run `bun src/loop.ts daemon up --loop-data-root "$ROOT" --json` against a newly created local `/tmp/coder-loop-551-*` root; for the GitHub path use `bun scripts/real-e2e.ts`, which owns its isolated daemon and fixture lifecycle.
- Readiness: direct daemon JSON reports success and `test -S "$ROOT/daemon.sock"` succeeds before chain/item calls.
- Behavior: exercise real `chain create`, `item add --item`, `item list`, `status --json`, and `queue unblock --item` paths; verify non-GitHub creation, literal opaque-id round trip, repository binding projection, and v13 migration preservation/conflict rejection.
- Logs: retain command/stdout/stderr/exit status, structured status snapshots, daemon events, migration `PRAGMA` reads, and the real-E2E fixture issue/PR URLs in the issue evidence directory. No browser screenshots are required because this is CLI/daemon/storage work.
- Stop ownership: the direct test driver must run `bun src/loop.ts daemon down --loop-data-root "$ROOT" --json` and verify socket/PID removal; `scripts/real-e2e.ts` owns fixture rollback and isolated teardown. Never touch the production `~/.coder-loop` root.
- Canonical E2E: `bun scripts/real-e2e.ts` per `CLAUDE.md` and `docs/real-e2e-fixture.md`; unit/typecheck evidence cannot replace it for daemon/storage/CLI semantics.

## Test delta

`required`

Tests must change because the public CLI/wire vocabulary, chain-create admission, SQLite schema/migration, status projection, and opaque-id runtime behavior change. Integrity rule: preserve all unrelated assertions; delete only tests whose asserted compatibility behavior is explicitly retired (`--issue`, `issue`/`issueNumber` batch aliases, `--umbrella`, normalization, repository-format rejection), replace them with exact clean-break and boundary-failure assertions, and add v13→v14 preservation/conflict plus real CLI/daemon opaque-id coverage. Do not add skips/todos/only markers, loosen surviving assertions, broaden catches, or hide malformed fields with fallbacks. PR evidence must reconcile base and head test counts by named test additions/removals/renames.

## Dependencies

- Source baseline: local `origin/main` is `f01560d5d0b324e791db7f599e502f09fc78a652`; current source still has schema v13, `chains.repository TEXT NOT NULL`, `REPOSITORY_REF_PATTERN`, Git-origin inference/normalization, `--issue`, `--umbrella`, batch aliases, and `queue.unblock` wire key `issue`.
- Ordering prerequisite satisfied: #535, #536, and #538 are closed. Parent #534 remains open but its issue-body ordering requirement named those children, not parent closure, as the pre-merge prerequisite.
- Migration coordination: #557 is still open/unimplemented and also changes `chains`; #551 owns the next v13→v14 migration on this baseline. If #557 lands first, rebase and renumber this migration; otherwise #557 must rebase after #551.
- Downstream consumers: #569 is blocked by #551's stable CLI surface; #548 is related socket-contract work. Neither is an implementation blocker for #551.
- Prior PR: #659 is closed, draft, and unmerged at head `2823e4e33df982ca268416aada823a652145d3cf`; use its review discussion only as historical risk evidence. Fresh implementation must start from current main and independently satisfy this contract.
- External runtime dependency: C11 requires configured `gh` auth as `RiriAgent`, runner CLI availability, network access, and the fixture repo `mouriya-s-lab/coder-loop-e2e-fixture`. These are currently documented project runtime requirements, not user-supplied secrets.

## Supersedes

none



### comment #5084308898 by `RiriAgent` — 2026-07-26T16:15:18Z

重新拆分后由 #736 承接引擎 GitHub 记法与 repository 原语退役。关联 PR #659 / #673 均已 closed unmerged，本 issue 无 open PR，按 #547 重拆结果关闭。


---

## Timeline (20)

- 2026-07-02T11:12:04Z `assigned` @RiriAgent
- 2026-07-02T11:12:47Z `cross-referenced` @RiriAgentsrc=557
- 2026-07-02T11:13:06Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:14:36Z `commented` @RiriAgent
- 2026-07-02T11:15:25Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-02T11:58:01Z `cross-referenced` @RiriAgentsrc=569
- 2026-07-02T11:58:39Z `cross-referenced` @RiriAgentsrc=548
- 2026-07-12T00:58:25Z `cross-referenced` @RiriAgentsrc=659
- 2026-07-12T14:00:42Z `cross-referenced` @RiriAgentsrc=666
- 2026-07-12T14:34:45Z `cross-referenced` @RiriAgentsrc=667
- 2026-07-13T00:03:34Z `cross-referenced` @RiriAgentsrc=661
- 2026-07-13T02:11:07Z `commented` @RiriAgent
- 2026-07-13T03:51:03Z `cross-referenced` @RiriAgentsrc=673
- 2026-07-13T05:31:56Z `referenced` @RiriAgentcommit=0095a6485eeceb32506d660f052723f16d47c0bc
- 2026-07-17T20:37:15Z `cross-referenced` @RiriAgentsrc=736
- 2026-07-17T20:37:30Z `cross-referenced` @RiriAgentsrc=742
- 2026-07-17T20:37:34Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:37:39Z `cross-referenced` @RiriAgentsrc=746
- 2026-07-26T16:15:18Z `commented` @RiriAgent
- 2026-07-26T16:15:20Z `closed` @RiriAgentcommit=None