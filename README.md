# coder-loop

N 角色字符串调度引擎。给定一个 preset（角色定义、状态集、phase 列表、prompt 与变量绑定），coder-loop 按 preset 描述的顺序 spawn 各 phase 的 agent，捕获输出，根据状态推进队列，直到队列里所有 item 落在 terminal 状态。

**这不是一个 GitHub PR loop。** GitHub issue/PR 迭代是它内置的一个 preset（`gh-issue-pr-iteration`）。引擎本身不知道 GitHub 的存在、不知道 phase 数量、不知道 phase 名字、不知道 status 字面量。

---

## 按身份找文档

| 你是 | 看哪 | 你要做什么 |
|---|---|---|
| **Operator**（想在一个 repo 上把 coder-loop 跑起来） | [docs/operator-quickstart.md](./docs/operator-quickstart.md) | bootstrap target 的 `.coder-loop/`、灌队列、起循环、看 trace |
| **Preset 作者**（写新 preset 或改 bundled preset） | [docs/preset-authoring.md](./docs/preset-authoring.md) | `preset.toml` 字段、变量 DSL、`runtime.*` 白名单、minimal template |
| **`gh-issue-pr-iteration` 维护者**（动 bundled preset 的 fragment） | [docs/gh-issue-pr-iteration-fragments.md](./docs/gh-issue-pr-iteration-fragments.md) | 32 fragments 的 verdict 跳转图 + review 13-step 顺序 |
| **运维 / supervisor**（循环挂了、想 reset 状态、想看上一轮跑哪儿了） | [docs/operations.md](./docs/operations.md) | 稳定 API：`coder-loop doctor` / `coder-loop status <target> --json` / `coder-loop daemon ...`；runtime 文件只是 fallback reference |

不在以上四类的人——看完下面这一页（设计思想 + 安装 + References）就够。

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

这些是**preset 设计原则**，不是引擎行为。引擎不知道「信号」是什么——它只调度 phase 顺序、传变量、捕获 trace。是 preset（默认 `gh-issue-pr-iteration`）按 plan/iter/review 三段切分把信号生成/产生/消费做成了 phase 流水线。

不同 preset 可以选择不同的切分：1 phase（如 `single-phase-example`，仅 run）、2 phase（如 `gh-issue-pr-iteration`，iter+review）、N phase（plan+iter+review+publish 等）都行。引擎对 N 没有上界。

### 四个设计决策（gh-issue-pr-iteration preset）

下面四条是 `gh-issue-pr-iteration` preset 的设计前提，不是引擎契约。换 preset 时这些可以改。

**1. Checkpoint 取代 checkbox**

传统 issue 写 `- [ ] docker build 成功`。这是自然语言，不是可执行验证。iteration agent 可以跳过、重新解释、或声称完成。`gh-issue-pr-iteration` 的 plan 把每条验收标准编译为 `{dimension, command, env, expect}` 四元组，agent 无法跳过。

**2. 维度覆盖强制**

issue #69 事后分析：Phase 3 验收标准全是功能维度，但 7 个 bug 中 6 个属于环境/集成/假设维度。`gh-issue-pr-iteration` 的 plan 要求每个 issue 的 checkpoint 覆盖 function / environment / integration / assumption；review 检查每个维度是否有至少一个 PASS。

**3. Spike 前置于实现**

如果 Phase 的架构假设依赖第三方组件未文档化行为，假设必须在实现前被验证。`gh-issue-pr-iteration` 的 plan 扫描风险信号、为高风险假设创建 spike issue。spike 失败触发设计调整，而非在错误假设上堆叠代码。

**4. 推迟验证不可遗忘**

某 checkpoint 当前环境无法执行（如本机没 Docker daemon），plan 将其作为 inherited verification obligation 分配到下游 issue，不可二次推迟。

---

## 安装

仓库本身用 bun + TypeScript，不发布到 npm：

```bash
bun install                                          # 安装 devDependencies
bun link                                             # 注册 coder-loop bin 到全局
cp .claude/commands/dev-*.md ~/.claude/commands/     # 注册 slash commands
```

之后 `coder-loop` 命令和 `/dev-plan` `/dev-loop` 在任意目录可用。也可以不 `bun link`，调用改成 `bun /path/to/coder-loop/src/loop.ts`。

在目标 repo 上启动前，先通过 `install` 建立 target-side bootstrap 契约：

```bash
coder-loop install /path/to/target --repo <owner>/<repo>
coder-loop doctor /path/to/target --repo <owner>/<repo>
coder-loop status /path/to/target --json
```

后台循环由 daemon API 管理；`/dev-loop [N]` 也是这个 API 的人类快捷入口，不再手写 `nohup`：

```bash
coder-loop daemon start /path/to/target
coder-loop daemon status /path/to/target --json
coder-loop daemon stop /path/to/target
```

`/dev-plan` 引用以下用户级规则与 skill：

- `~/.claude/rules/github-issue-pr-routing.rule.md`
- skill `writing-issue / writing-pr / review-pr`

不是 coder-loop 仓库内的资产，由用户自己维护。缺失时 `/dev-plan` 仍可运行，但 issue 形式、PR 路由、review gate 设计会退化。`/dev-loop` 没有此类依赖。

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
