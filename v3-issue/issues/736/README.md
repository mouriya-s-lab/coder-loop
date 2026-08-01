# #736 feat(engine): GitHub 记法与 repository 原语退役

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:14Z  | updated: 2026-07-27T01:00:45Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/736
- comments: 0  | timeline events: 6

---

## Body

## 必须先读的关联 issue

继承 [#547](https://github.com/mouriya-s-lab/coder-loop/issues/547) 的共享契约与关闭验证。

## 目标

清除引擎 GitHub 特化并迁到声明。

引擎的 CLI/解析/存储面退役全部 GitHub 记法与 repository 格式假设：opaque item id、repository 降为 chain binding 业务字段、`--issue` 干净改名 `--item`。

## 问题

> "引擎是通用解释器……唯一落点是定义装载期" 的前提下，引擎却在 CLI/解析/存储三面私运 GitHub 形状（#547 定位事实 + 零原语清单）；`REPOSITORY_REF_PATTERN` + NOT NULL 物理列使 "非 GitHub 场景无法建 chain"（`v3/survey-engine-daemon.md` §9 第 6 条）。

这是 #453 T1（引擎零 GitHub 原语）红线的存量违反面，v3 承诺清零（RFC 关闭验证行 2）。

## 预期结果

性质表述：

1. **opaque id**：引擎对 item id 只做「非空、无空白」等中性校验，不解析任何引用记法；`normalizeQueueIssueId`、`inferRepositoryFromGit`、batch JSON 的 `issue`/`issueNumber` legacy back-fill、`--umbrella`/`parseUmbrellaRef` 物理移除，记法便利归调用方工具（skill / 外挂）。`queue.unblock` socket wire 字段 `issue` 改名 `itemId`（与 batch 面既有 wire 字段一致）。
2. **repository 是业务字段**：引擎不校验其格式、不设物理列——迁入 `chain.metadata.bindings`（SQLite migration，schema 版本 bump，既有 DB 升级数据无损）；`REPOSITORY_REF_PATTERN` 物理移除；消费 `chain.repository` 的引擎路径改读 binding 或退役。`baseBranch` 保留引擎一等。
3. **CLI 词表与模型一致**：`--issue` → `--item` 干净改名，不留 alias；usage/epilogue 文本与**全部** bundled preset fragment 文本同步（2026-07-02 核实命中面：`gh-issue-pr-iteration` 的 `review/actions/*.md`、`plan/init-queue.md`（该文件随 #741 plan 面退役消失，两序皆可）、`real-e2e-minimal/review-entry.md`）；`grep -rn -- '--issue' src/ presets/` 零命中。
4. **可验证清零**：RFC 关闭验证行 2 的 grep 在本 child 份额（`REPOSITORY_REF_PATTERN|normalizeQueueIssueId|inferRepositoryFromGit`）无命中。

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

- Depends on: #549。
- Blocks: #744。


---

## Comments (0)

---

## Timeline (6)

- 2026-07-17T20:37:15Z `assigned` @RiriAgent
- 2026-07-17T20:39:11Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:40:11Z `parent_issue_added` @RiriAgent
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-26T16:15:19Z `cross-referenced` @RiriAgentsrc=551
- 2026-07-26T23:49:50Z `cross-referenced` @RiriAgentsrc=746