# coder-loop

N-phase 字符串调度引擎。给定一个 preset（phase 列表、状态词表、prompt 与变量绑定），中央 daemon 按 preset 描述的顺序在 chain × item 上 spawn agent，捕获 trace，按 agent 写回的 `item.status` 推进队列，直到所有 item 落 terminal 状态。

**这不是一个 GitHub PR loop。** GitHub issue/PR 迭代是它内置的一个 preset（`gh-issue-pr-iteration`）。引擎本身不知道 GitHub 的存在、不知道 phase 数量、不知道 phase 名字、不知道 status 字面量。

---

## 按身份找文档

| 你是 | 看哪 | 你要做什么 |
|---|---|---|
| **Operator**（想在一个 repo 上把 coder-loop 跑起来） | [docs/operator-quickstart.md](./docs/operator-quickstart.md) | 中央 daemon 起 chain、灌队列、起循环、看 trace |
| **Preset 作者**（写新 preset 或改 bundled preset） | [docs/preset-authoring.md](./docs/preset-authoring.md) | `preset.toml` 字段、变量 DSL、engine-owned `runtime.*` fact 与 preset business key 分层、minimal template |
| **`gh-issue-pr-iteration` 维护者**（动 bundled preset 的 fragment） | [docs/gh-issue-pr-iteration-fragments.md](./docs/gh-issue-pr-iteration-fragments.md) | fragment 全集 + iter/review 调度者 workflow + plan 链跳转图 |
| **运维 / supervisor**（循环挂了、想 reset 状态、想看上一轮跑哪儿了） | [docs/operations.md](./docs/operations.md) | 稳定 API：`coder-loop doctor` / `status` / `daemon`；runtime 文件只是 fallback reference |
| **维护者**（想证明重构没停在单测） | [docs/real-e2e-fixture.md](./docs/real-e2e-fixture.md) | 私有 fixture repo、真实 issue→PR→review→merge→closure 路径 |
| **引擎 archaeology** | [docs/architecture-v1.md](./docs/architecture-v1.md)、[docs/architecture-v2.md](./docs/architecture-v2.md) | v1 单进程 → v2 daemon 化的演变主线，以及"机制归引擎、参数归 preset"这条并行线 |

不在以上六类的人——看完下面这一页（设计思想 + 安装 + References）就够。

---

## 设计思想

### 核心模型：信号生成 → 信号产生 → 信号消费

迭代收敛系统能否走到正确结果，取决于每次迭代是否产生足够的**信号**驱动下一次迭代。

这个认识来自 2024-2025 年四组研究：

| 问题 | 研究 | 发现 |
|---|---|---|
| 迭代系统为什么不收敛？ | ReVeal (2025), VeRPO (2025), DynaFix (2025) | binary pass/fail 是 sparse reward，无法指导迭代方向；dense per-step signal 使收敛效率提升 10%-37% |
| 评估为什么漏判？ | EDDOps (2024), Beyond Task Completion (2024) | 单维度评估掩盖其他维度的缺陷；agent 可在功能维度 100% 通过但策略维度仅 33% |
| 任务分解为什么导致失败？ | Agent Failure Taxonomy (2025) | planning phase defects 是 agent 任务失败的首要类别（约 50% 的失败源于此） |
| 怎么防止无限低质量推进？ | VMAO (2025) | completeness threshold + diminishing returns 检测 |

这些是**preset 设计原则**，不是引擎行为。引擎不知道"信号"是什么——它只调度 phase 顺序、传变量、捕获 trace。是 preset（默认 `gh-issue-pr-iteration`）按 iteration / review 两段调度者 workflow 把信号生成/产生/消费做成了 phase 流水线（issue 编写发生在 preset 之外——operator 或上游工具通过 `coder-loop item add` 把 GitHub issue 灌入 queue）。

不同 preset 可以选择不同的切分：1 phase（如 `single-phase-example`，仅 run）、2 phase（如 `real-e2e-minimal`，iteration+review）、N phase（如 `gh-issue-pr-iteration` 的 iteration+review+blocked-responder+umbrella-finalizer）都行。引擎对 N 没有上界。

### 四个设计决策（gh-issue-pr-iteration preset）

下面四条是 `gh-issue-pr-iteration` preset 的设计前提，不是引擎契约。换 preset 时这些可以改。issue body 契约（`presets/gh-issue-pr-iteration/contract.md`）由 iteration/review 调度者阅读并强制；issue 由 operator 或上游工具按契约写入。

**1. Checkpoint 取代 checkbox**

传统 issue 写 `- [ ] docker build 成功`。这是自然语言，不是可执行验证。iteration agent 可以跳过、重新解释、或声称完成。`gh-issue-pr-iteration` 的 contract 要求把每条验收标准编译为 `{dimension, command, env, expect}` 四元组，review 的 replay 步逐行真跑，agent 无法跳过。

**2. 维度覆盖强制**

`gh-issue-pr-iteration` 的 contract 要求每个 issue 的 checkpoint 覆盖 function / environment / integration / assumption；review 检查每个维度是否有至少一个 PASS。

**3. Spike 前置于实现**

如果 phase 的架构假设依赖第三方组件未文档化行为，假设必须在实现前被验证。`gh-issue-pr-iteration` 的 iteration 调度者按 issue body 分流出 spike 路径（comment-spike / source-writing-spike，见 contract §4）。spike 失败触发设计调整，而非在错误假设上堆叠代码。

**4. 推迟验证不可遗忘**

某 checkpoint 当前环境无法执行（如本机没 Docker daemon），issue writer 用 `## 继承验证义务` 段（contract §1.4）把它分配到下游 issue，不可二次推迟。

设计思路完整版见 [`presets/gh-issue-pr-iteration/DESIGN.md`](./presets/gh-issue-pr-iteration/DESIGN.md)。

---

## 安装

仓库本身用 bun + TypeScript，不发布到 npm：

```bash
bun install                                          # 安装 devDependencies
bun link                                             # 注册 coder-loop bin 到全局
```

之后 `coder-loop` 命令在任意目录可用。也可以不 `bun link`，调用改成 `bun /path/to/coder-loop/src/loop.ts`。

在目标 repo 上启动前，先起中央 daemon，再用一条命令注册 chain：

```bash
coder-loop daemon up
coder-loop chain create <name> --config-json '{"repository":"<owner>/<repo>","baseBranch":"main"}' --preset gh-issue-pr-iteration
coder-loop doctor /path/to/target --repo <owner>/<repo>
coder-loop status /path/to/target --json
```

`chain create` 只写一次 chain 元数据到中央 daemon socket；target 目录不需要任何 bootstrap 文件。`--preset` 可选：不写时 chain 会 seed 默认 `gh-issue-pr-iteration`（`item add` 仍需自带 `--preset` 或 `--preset-path`——preset 声明在 item 级）。preset 业务资产（如 GitHub labels）不由本 CLI 管理——由 issue writer / operator 自己按需创建。用自定义 `--loop-data-root` 时，`daemon up` 与后续所有命令要传同一个 root。

每个 phase 的默认 runner 由 `preset.toml` 的 `[[phases]].runner = "claude"|"codex"|"opencode"` 声明；未声明时走 engine-builtin fallback。phase 还可用 `[[phases]].model` 声明默认模型。Runner binary 就是 PATH 上的 `claude` / `codex` / `opencode`；没有 target 级 override 通道。单个 queue item 的 `runner` 字段只覆盖非 trigger phase。`doctor` / `status --json` 显示每个 phase 的 runner 与 source。

后台循环由 daemon API 管理：

```bash
coder-loop daemon start /path/to/target
coder-loop daemon status /path/to/target --json
coder-loop daemon stop /path/to/target
coder-loop queue unblock /path/to/source-target --item 123 --start-daemon
```

新 operator 完整 bootstrap 步骤见 [docs/operator-quickstart.md](./docs/operator-quickstart.md)。

---

## References

1. ReVeal: Self-Evolving Code Agents via Iterative Generation-Verification. arxiv 2506.11442, 2025.
2. VeRPO: Verifiable Dense Reward Policy Optimization for Code Generation. arxiv 2601.03525, 2025.
3. DynaFix: Iterative Automated Program Repair Driven by Execution-Level Dynamic Information. arxiv 2512.24635, 2025.
4. EDDOps: Evaluation-Driven Development and Operations of LLM Agents. arxiv 2411.13768, 2024.
5. Beyond Task Completion: An Assessment Framework for Evaluating Agentic AI Systems. arxiv 2512.12791, 2024.
6. Exploring Autonomous Agents: A Closer Look at Why They Fail When Completing Tasks. arxiv 2508.13143, 2025.
7. VMAO: Verified Multi-Agent Orchestration. arxiv 2603.11445, 2025.
