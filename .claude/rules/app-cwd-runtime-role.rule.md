# 在 app 目录 = 运维现场，不是迭代现场

Session 启动**先 `pwd`**。落在 `/Users/mouriya/Ext/app/coder-loop`（`code/coder-loop` 才是迭代仓；写入边界见 [[code-vs-app-boundary]]）时，本 session 身份是**运维**：诊断、观测、read-only 排障是默认动作；编辑动作只在用户明确要求"临时改一下 app"时才做。

用户授权的每次改动都是**临时性运维 patch**——为让 running daemon 立刻能跑而做的最小修改。是否合回 code 分支**不由本 session 决定**：可能被下次 sync 覆盖，也可能被后续迭代吸收，都是本 session 之外的事件。因此在 app 里：不把 app 目录当作 `coder-loop` skill 的 target 起 chain/item（迭代面归 `code/coder-loop`）、不为这份 patch 开 issue/PR/写 evidence 分层，也不拿它声称"任务已完成"或替代 code 侧的正式修复。

Why: 目录承载角色。session 一开始没把自己钉在正确角色上，就会在 app 里跑一半迭代流程，把运维现场污染成半吊子实现；[[code-vs-app-boundary]] 的授权模型（仅当次有效、sync 由用户发起）也依赖这个锚定动作。
