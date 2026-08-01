# #735 feat(engine): doc 渲染声明驱动化

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:12Z  | updated: 2026-07-27T01:00:44Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/735
- comments: 0  | timeline events: 5

---

## Body

## 必须先读的关联 issue

继承 [#547](https://github.com/mouriya-s-lab/coder-loop/issues/547) 的共享契约与关闭验证。

## 目标

消费编译产物，清除按变量名分支。

runtime-inputs doc 渲染完全由 `[phases.variables]` 的 doc 声明驱动，引擎渲染路径不存在任何按变量 key 字面量的分支。

## 问题

> "doc 渲染存在按变量名分支的特判（`renderRuntimeInputsDoc` 的 `"ISSUE"` 特例，#539 已在 #534 树登记 v2 修复）" — #547 定位事实

机制上引擎只要允许一处按变量名分支，就为任意「知名变量名特权」开了口子——每个后续特判都会引用这个先例。

## 预期结果

性质表述：

1. **完全声明驱动**：runtime-inputs doc 的每一行输出都可追溯到某绑定的 doc 声明字段；引擎渲染函数的输入是声明结构，不读变量 key 的字面量值做分支。
2. **声明面扩 `prefix`**：覆盖原特判所表达的排版需求；bundled preset 迁移为显式声明，渲染语义与 #539 修复后的正确行为等价。
3. **编译器守护**：doc 声明是 typed 结构（arktype parse），新增 doc 字段必须过 parse + 渲染两端类型链，不能以「渲染函数里认变量名」旁路。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 变量名特判死亡（RFC 关闭验证行 2 之本 child 份额） | `grep -rnE '=== "ISSUE"' src/` | local | 无输出 |
| function | 不以别的字面量重生 | 单元测试：两个仅 key 名不同、doc 声明相同的绑定 → 渲染输出逐字节相同（除 key 名本身） | local | 测试绿 |
| function | prefix 声明生效 | fixture preset 绑定声明 `doc.prefix`，渲染 runtime-inputs doc | local | 输出含 prefix 行，位置符合声明 |
| integration | bundled preset 语义等价 | 迁移前后对 gh-issue-pr-iteration 渲染 runtime-inputs doc 做 diff | local | 语义等价（与 #539 修复后的正确行为一致），diff 列入 PR evidence |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: #549。
- Blocks: #744。


---

## Comments (0)

---

## Timeline (5)

- 2026-07-17T20:37:13Z `assigned` @RiriAgent
- 2026-07-17T20:39:11Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:40:10Z `parent_issue_added` @RiriAgent
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-26T16:15:16Z `cross-referenced` @RiriAgentsrc=550