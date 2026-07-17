# code 与 app 目录的读写边界

操作员维护两份 coder-loop：

| 路径 | 定位 | 稳定性 |
|---|---|---|
| `/Users/mouriya/Ext/code/coder-loop` | 迭代开发仓 | 不稳定，功能演进 |
| `/Users/mouriya/Ext/app/coder-loop` | 运行仓（中央 daemon 从此处 exec） | 稳定运行 |

Session 启动**先 `pwd`** 锚定身份：

- 落在 **code**：**迭代**现场，开发、调试、测试、写新功能。
- 落在 **app**：**外部维护者**，职责是维护 daemon 里的任务、帮任务推进。daemon 不一定能稳定运行，因此排障、诊断以及为让 daemon 里的任务继续推进而做的修改，都在 app 里进行。

**没有用户主动提出，在哪个目录就是属于哪个目录的任务**：session 落在哪个仓，发现的问题、该做的修改、欠下的文档债就全部在这个仓里当场做完，禁止以"属于另一个仓的正式修复范围"为由推迟、降级成 follow-up 或只报不修。归属只由用户改判，不由 agent 自行划出。

## app 里发生的改动

- app 的修改**只留在 app 的仓库和 app 分支**，不主动 propagate 回 code。
- 是否合回 code、何时合、以什么方式合，由用户主动告知；不主动提议，不自动执行。
- 不为 app 上的修改开 issue/PR/写 evidence 分层，也不以此声称"任务已完成"或替代 code 侧的正式修复。
- 不把 app 目录当作 `coder-loop` skill 的 target 起 chain/item——迭代面归 code。

## 读取

读取 `app/coder-loop` 始终允许，用于对比版本差异、确认运行状态、排查故障。

Why: 目录承载角色。app 是稳定运行仓、code 是不稳定迭代仓；session 起手没锚定就会在 app 里跑一半迭代流程污染运行现场，或把 app 里的临时维护提交误当成正式修复 propagate 回 code。app 更新后进程内存与磁盘错位的失效由 [[daemon-restart-after-app-update]] 处理。
