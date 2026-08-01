# #745 feat(engine): preset compile schema artifact 分发

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:35Z  | updated: 2026-07-27T01:00:56Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/745
- comments: 0  | timeline events: 5

---

## Body

## 必须先读的关联 issue

继承 [#548](https://github.com/mouriya-s-lab/coder-loop/issues/548) 的共享契约与关闭验证。

## 目标

为外部 consumer 发布可版本化、可派生类型的 schema artifact；projection instance 不得冒充 schema。

## 问题

- [#747](https://github.com/mouriya-s-lab/coder-loop/issues/747) prohibits a hand-written projection shape and requires the new consumer repo's types to be imported/generated from the `preset compile --json` schema.
- [#746](https://github.com/mouriya-s-lab/coder-loop/issues/746) simultaneously requires the external daemon to have zero coder-loop source imports and interact only through the CLI.
- Current `coder-loop preset compile ... --json` outputs a **projection instance** with eight data keys; it does not emit JSON Schema or another schema artifact. Live inspection returned `schema == null` and `jsonSchema == null`.
- The precise arktype boundaries exist only as exported TS symbols inside `src/loop.ts:539-598`. `package.json:1-18` marks coder-loop private and exposes only the CLI binary—there is no package export or published schema artifact for the new repo to consume.

Core defect: #747's only allowed integration channel (CLI JSON) carries values, not the schema required to derive a consumer type. Therefore the issue can pass only by hand-writing/inferencing a parallel shape, importing forbidden coder-loop source, or adding an unowned schema-distribution mechanism. None satisfies its own contract.

## 预期结果

本 issue 交付 #747 所需的真实 schema 分发契约——CLI 输出 JSON Schema，或独立版本化的可消费 package/artifact——而不是把 projection instance 当作可派生 schema。

## 依赖关系

- Depends on: #549。
- Blocks: #747。


---

## Comments (0)

---

## Timeline (5)

- 2026-07-17T20:37:36Z `assigned` @RiriAgent
- 2026-07-17T20:39:14Z `cross-referenced` @RiriAgentsrc=747
- 2026-07-17T20:40:21Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:42:11Z `cross-referenced` @RiriAgentsrc=570
- 2026-07-26T16:15:09Z `cross-referenced` @RiriAgentsrc=548