# #716 feat(engine): status snapshot 严格只读 SQLite 入口

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:30Z  | updated: 2026-07-27T01:00:22Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/716
- comments: 0  | timeline events: 9

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

提供真正 read-only、零 WAL/journal/schema mutation 的 snapshot 入口；schema 不兼容返回精确错误。

## 问题

#544 把 daemon 定为 SQLite 唯一 writer、独立网关严格只读，并要求网关经 `openSqliteStateStore({ createIfMissing: false })` 复用 `buildCoderLoopStatusSnapshot`——但当前源码与该前提矛盾：

- 当前源码： `openSqliteStateStore` opens `Database(... readwrite: true)`, may execute `PRAGMA journal_mode = WAL`, and always calls `migrateStateSchema`.

后果：网关在 daemon 存活或死亡时都可能改变 journal 状态与 schema。这个进程/所有权边界在任何 GUI 代码写下之前就已不成立，且引擎侧没有任何 issue 拥有「严格只读 snapshot 入口」。

## 预期结果

本 issue 交付一条引擎侧的严格只读 status snapshot 路径：

- SQLite opened read-only;
- no WAL/journal mutation;
- no schema migration;
- explicit typed schema-version mismatch result when the on-disk DB is not consumable;
- repeated gateway reads proven byte/metadata neutral while daemon is down.

## 依赖关系

- Depends on: 无。
- Blocks: #718、#720、#722、#724、#729。


---

## Comments (0)

---

## Timeline (9)

- 2026-07-17T20:36:31Z `assigned` @RiriAgent
- 2026-07-17T20:38:37Z `cross-referenced` @RiriAgentsrc=718
- 2026-07-17T20:38:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:38:42Z `cross-referenced` @RiriAgentsrc=722
- 2026-07-17T20:38:51Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:39:46Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:17Z `cross-referenced` @RiriAgentsrc=574
- 2026-07-17T20:41:21Z `cross-referenced` @RiriAgentsrc=576
- 2026-07-27T04:27:05Z `cross-referenced` @RiriAgentsrc=724