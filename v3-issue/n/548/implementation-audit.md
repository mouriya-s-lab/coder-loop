# implementation-audit — AGG-548 交付标准实现现状审计

- **审计对象**:`/Users/mouriya/Ext/code/coder-loop` main @ `699842e`
- **对照文档**:同目录 `AGG-548.md`(标准 ID 均指其中条目)
- **方法注记**:审计最初委托 codex(会话三次中断:模型容量 ×2、上下文窗口耗尽 ×1,未产出报告);本报告全部证据由主线程直接取证,codex 中断前口头结论均已独立重新验证。
- **关键 git 史实**:`8e9642c`(PR #676,外部终端缺席语义)曾合入 → `483466f`(PR #759)回退 → `699842e`(PR #749,任务闭包资源生命周期)合入,为当前 HEAD。

---

## 一、按终态的总判定

| 终态 | 判定 | 一句话结论 |
|---|---|---|
| T1 结构化调用两分支 | **引擎支撑面已在;外挂侧未实现** | chain.create / item.add 命令面、幂等、唯一约束全部在产(见 F3/F4);消费 daemon 是独立 repo,尚不存在 |
| T2 请求校验面 | **部分(仅基础设施起步)** | compile 输出已带 `schemaVersion: 1` 的 ADT envelope,但仍不 emit JSON Schema/可派生 artifact——STD-745 缺口缩小但仍在;预校验消费端未实现 |
| T3 幂等 | **引擎侧幂等键完备;消费端未实现** | 三层幂等中引擎两层在产(F4);delivery id 去重归 router,消费端重放收敛无载体 |
| T4 GitHub 端到端 | **未实现** | 依赖消费 daemon(不存在)与 router 演进(树外) |
| T5 重试闭环 | **未实现** | 同上;consumed/not-consumed verdict 无载体 |
| T6 外挂纯度 | **基线成立** | 引擎 `src/` 内 grep `webhook|hmac` 零命中;GitHub 外挂知识为零(现状即达标,约束是保持) |
| T7 hapi 通道 | **main 上未实现;完整实现存在于被回退的 8e9642c** | 回退树级干净、零残留;runner 词表仍严格三元;详见第二节 |

---

## 二、T7 / #676 详情

### 实现规模与触点(commit 8e9642c,40 文件,+3997/-273)

按 AGG 的 R1–R6 以文件粒度分组(commit 内行号级定位属恢复实现时的工作,本审计不展开):

| 语义组 | 主要触点(变更量) |
|---|---|
| R1 词表/execution-domain ADT | `src/runner-execution.ts`(+128)、`src/loop.ts`(+297)、`src/sqlite-state.ts`(+51,含 migration 测试 +116) |
| R2 probe 契约 | `src/runner-execution.ts`、`src/scheduler.ts`(部分) |
| R3 创建与调度(hold/gate) | `src/scheduler.ts`(+608) |
| R4 真实 invocation | `src/runners/session-id.ts`(+6)、`src/task-runtime.ts`(+4) |
| R5 运行中 loss | `src/runtime-data.ts`(+210)、`src/scheduler.ts` |
| R6 warning/读面 | `src/observability.ts`(+52)、`src/daemon.ts`(+178)、`src/install-commands.ts`(+15) |
| 验证载体 | `scripts/external-terminal-integration.ts`(+537)、`tests/integration/daemon/external-terminal.integration.ts`(+650)、`tests/integration/scheduler/external-terminal.integration.ts`(+816)、`tests/unit/loop/external-terminal.test.ts`(+54) |

### 回退干净度判定

- `git diff 8e9642c^ 483466f` 输出为空 → **树级完全干净回退**,回退后与 #676 合入前逐字节一致。
- 残留 grep:`git grep -nEi "hapi|external.?terminal|externalTerminal|probe" -- src/` 仅两处命中,均为无关注释(`src/daemon.ts:3574`、`src/loop.ts:3464`,内容是 items 表 de-GitHub-shaping 说明)。**main 无 #676 残留。**

### 现状词表证据(main)

- `src/loop.ts:885` `export type AgentRunnerKind = "claude" | "codex" | "opencode"`;边界 parse `src/loop.ts:402`。
- SQLite CHECK:`src/sqlite-state.ts:551`、`:579`、`:741`(runner/runner_kind 均限定三元)。
- 无 `hapi` kind、无 execution-domain ADT、无 probe/holds/externalTerminal 读面。

---

## 三、#749 与 C6 的关系

- `699842e` 的 commit body 全部 `Refs: mouriya-s-lab/coder-loop#560`——**#749 是 PR 号,实现的 issue 是 #560**(scheduler 树)。
- 交付内容:`src/closure-lifecycle.ts`(新,221 行)——闭包可达性模型(seeds:`active-run | resumable-attempt | decided-reopen | seq-suffix | open-par-epoch | open-append | next-epoch-candidate`;edges:`resume | scope-target`);`src/scheduler.ts` +946;`src/sqlite-state.ts` +325;`tests/integration/scheduler/worktree.integration.ts` +847。
- **与 C6 的关系判定**:AGG C6 所述能力(task-closure worktree 起点/挂起/重开/消费与启动状态对账)在 main 上已有实质实现载体。且 `src/sqlite-state.ts:459` 已有 per-closure session 行边界(`ClosureSessionRowBoundary`:`runner_kind` + `session_id`)——这同时是 T7 R4(远端 session identity 绑定闭包)所需的基础设施。
- **与「#699 replacement」的编号关系**:代码与提交史中无 issue #699 引用(`git log --grep=699` 命中均为哈希前缀巧合)。AGG 洞 H4 的「#699 对端待核」在代码层收敛为:**能力已由 #560/#749 交付;#699→#560 的编号替代链需 GitHub 侧核实,代码层无法判定**。

---

## 四、F1–F12 事实核对表

| F | 判定 | 当前证据(main) |
|---|---|---|
| F1 socket 面 | 语义成立,**行号漂移** | `createServer`:`src/daemon.ts:1248`(替换路径 `:1625`);`listen()`:`:6087-6099`。原 `3833-3864` 现为 item status admission 逻辑 |
| F2 信任模型 | 成立,补充新事实 | `chain.create` authClass `hard-deny-for-agent`(`src/daemon.ts:1734`)、`item.add` `mutation-credential-gated`(`:1741`)。⚠ 消费 daemon 经 CLI 调用 `item.add` 时的凭据面(operator 主体如何获得 mutation credential)需在重拆时确认 |
| F3 结构化调用面 | 成立,**行号漂移** | `chain.create` 处理 `src/daemon.ts:2167` 起;`item.add` `:2888-2904`(注:`branch`/`pr` 已从 item.add wire 退役,`:447`) |
| F4 幂等/唯一 | 成立,**行号漂移** | chain 同名同字段幂等 + 字段冲突拒绝:`src/daemon.ts:2210-2220`;`UNIQUE (chain_id, item_id)`:`src/sqlite-state.ts:559`、`:587` |
| F5 per-item preset | 成立 | `src/daemon.ts:2169` 注释「item.add now requires per-item preset」;`:2899` `requireItemPresetForRequest` |
| F6 router/iac-daemon 在产 | 本审计不核 | 树外 repo,超出「只看本 repo」边界 |
| F7 runner 三元 ADT | 成立 | `src/loop.ts:885`、SQLite CHECK ×3(见第二节);#481 migration 注释 `src/sqlite-state.ts:801-807` |
| F8 headless 完成契约 | 未单独复核 | 本轮未逐行取证 status.json 面;无反证 |
| F9 盲 backoff 现状缺陷 | 语义成立,**行号漂移** | `spawn_failed` 错误码 `src/scheduler.ts:1557`、`:1675`、`:1741`;preparation backoff `:1897-1899`;`item.backoff` 投影 `:253`、`:780-788`。原 `1259` 现为 git contract 逻辑 |
| F10 spike/设计书已完成 | 本审计不核 | GitHub 侧事实 |
| F11 compile 输出 | **实质漂移(AGG 需按本报告修正认知)** | 现为 ADT envelope:`{kind:"compiled", schemaVersion:1, projection} \| {kind:"rejected", schemaVersion:1, diagnostics}`(`src/loop.ts:589-590`、`:2964-2965`;projection 自身也带 `schemaVersion:1`,`:534`)。**仍不 emit JSON Schema**——STD-745 核心缺口(可派生类型的 schema artifact)仍在,但 `schemaVersion` 前提已具备(P-747-3 的失配检测有了锚点) |
| F12 private/无 artifact 出口 | 成立 | `package.json:1-7`(`"private": true`,仅 `bin`);arktype 边界仍为 `src/loop.ts` 内部导出(~`:520-598`) |

---

## 五、对重拆的直接影响

1. **T7 不必从零写**:完整实现(含 2000+ 行专用 integration 测试)在 `8e9642c` 里完好,回退干净意味着可作恢复起点;但 #749 之后 `scheduler.ts`/`sqlite-state.ts` 大改(+946/+325),恢复必须以 reconcile 而非 revert-the-revert 方式进行——AGG T7 中 Coordination 条款(后合者基于 current main reconcile 并重跑完整验收)正预言了当前局面。
2. **STD-745 范围缩小**:`schemaVersion` 机制已在产,缺口只剩 schema 本体的 emission/artifact 分发。
3. **C6 悬空在代码层收敛**:闭包生命周期能力已交付(#560/#749),T7 的 R4 还能直接复用 per-closure session 行。
4. **T1/T3 的引擎前提全部成立**,消费 daemon 可以立即按 CLI 契约开工;唯一新发现的待确认点是 F2 标注的 mutation credential 凭据面。
5. **AGG 中全部五处 `path:line` 事实引用已漂移**(F1/F3/F4/F9 及 F11 语义漂移),重拆写新 issue 时一律以本报告的当前行号为准,不要照抄 AGG/原 RFC 的行号。
