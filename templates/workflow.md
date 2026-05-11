# coder-loop workflow

替换本文件为你的 target 项目特有的工作流约定。`coder-loop install` 在首次部署时落该模板；已有 `.coder-loop/workflow.md` 视为 operator 自定义，install 不覆盖。

## Goal

写一句话描述本 target 上 coder-loop 队列的目标。例：「持续推进 open `kind:code` issue，PR 通过 review 后 merge 入 main」。

## Source of truth

- Queue / order / state: `.coder-loop/runtime/state.json`
- Current issue handoff: `.coder-loop/runtime/issues/<issue>.md`
- Shared durable facts: `.coder-loop/runtime/shared.md`
- Runtime evidence / logs: `.coder-loop/runtime/evidence/` and `.coder-loop/runtime/logs/`
- Live GitHub issue / PR state verifies reality.

## Project commands

列出本 repo 跑测试、跑 lint、跑 build、跑 dev server 的实际命令。plan/intake fragment 用这些命令在 checkpoint 表格里 ground `Command` 列。

```
# 例：
# test:        bun test
# lint:        bun x tsc --noEmit
# build:       bun run build
# dev:         bun run dev
```

## PR conventions

- 列本 repo 的 PR title / body 习惯（中文或英文、是否要求 `Closes #N` 首行、evidence 段格式等）。
- 列 review checklist（CI parity 要求、screenshot 要求、迁移要求）。

## CI parity

- 列 review agent 必须在本机 reproduce 的 CI check（package scripts、container build、smoke test）。

## Out of scope

- 列 coder-loop 不应该自动做的事（自动 merge / 自动 deploy / 自动 push 到非 issue 分支）。
