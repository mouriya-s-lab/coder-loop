# 复杂任务使用 coder-loop 的触发规则

coder-loop 是长任务 / 多 actor / 多阶段工作的调度器，不是所有改代码请求的默认包装层。本规则只决定是否把工作交给 chain / daemon 调度；它不覆盖 GitHub issue/PR routing，也不替代 preset contract、可选 operator 写作 skill，或 runtime verification 规则。

## 触发条件

满足任一条件时，优先使用 coder-loop 或至少先规划 chain / item：

- 复杂编码任务跨多个 issue、多个 PR、多个 repo，或需要父子 issue 图。
- 任务预期长于单 session，需要 daemon 持续推进、review 接力或恢复。
- 用户明确要求“用 coder-loop”、“队列跑”、“daemon 跑”、“自动 review”。
- 任务需要持续巡查、故障诊断、block / unblock side effect 或后续 patrol。
- 任务有依赖顺序，需要 `chain create` / `item add` 表达可执行 item，而不是靠聊天记忆。

典型流程：

```bash
coder-loop doctor <target> --repo <owner>/<repo>
coder-loop chain create <chain-name> --config-json '{"repository":"<owner>/<repo>"}' --json
coder-loop item add <chain-name> --issue <n> --repo-cwd <target> --json
coder-loop daemon start <target>
coder-loop status <target> --json
coder-loop daemon status <target> --json
```

## 不触发条件

这些工作通常手动完成更快，不强制进 coder-loop：

- 简单单文件修复，影响面清楚，能在当前 session 完成。
- 低风险文档更新或小 bugfix，不需要多轮 review / daemon 恢复。
- 只读调查、一次性命令、格式化、翻译、轻量说明。
- 用户明确说不要 coder-loop 或要人工直接实现。

## 与既有规范的边界

不触发 coder-loop 不等于跳过规范：仍然遵守 GitHub issue/PR routing、对应 repo/preset 的写作与 review 契约，仍然做 runtime verification。

触发 coder-loop 也不等于让 agent 跳过规划：复杂任务应先把 issue / chain / item 拆到可执行粒度，再启动 daemon。执行中巡查使用只读巡查清单；故障时切到 Level 1/2/3 诊断流程。

本规则不引用旧 skill 系列作为依赖；当前入口是稳定 CLI/API：`doctor`、`chain create`、`item add`、`daemon start`、`coder-loop status`、`daemon status`。
