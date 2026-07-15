# 当前仓库是可运行的 v2，禁止发散到 v3

本仓库（`app/coder-loop`）是**可运行的 v2** — 中央 daemon 从此处 exec，`src/`、`presets/`、`docs/`、`scripts/` 都是 v2 的实现。`v3/` 目录仅存放 v3 的设计草稿（如 `execution-orchestration.md`），不是当前运行代码，也不承接维护改动。

## 禁止

- 在 `src/` / `presets/` / `docs/` / `scripts/` 里为 v3 铺路——引入 v3 概念的类型、字段、CLI、fragment、迁移 shim、feature flag、兼容层。
- 在 `v3/` 目录里落实现代码或跑测试；`v3/` 只写 / 修 设计文档。
- 把 v3 的名词、模型、术语渗透进 v2 的 CLAUDE.md、README、design doc 或 runtime error message。
- 因看到 `v3/` 的方向就在 v2 里"顺手改造"——所有 v2 改动只用 v2 现有概念表达。

## 允许

- 读 `v3/` 里的设计草稿，用于对齐方向或回答问题。
- 修 `v3/*.md` 的措辞、结构、示例——它们本来就是可迭代的设计稿。

Why: v3 是尚未落地的方向草案，v2 是眼下唯一能跑的实现。以 v3 视角改 v2 会把设计草稿里的未决问题引入运行路径，制造 v2 层面看不出根因的 bug；也让 v2 的稳定性承担 v3 设计变动的成本。v3 的实现工作要另立仓库或分支，不在此处发生。
