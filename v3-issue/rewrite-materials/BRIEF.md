# A.md 重写任务说明（BRIEF）

## 我们要干什么

操作员与 Claude（主 session）经过长时间设计讨论，确认 `v3-issue/A.md`（五篇 v3 RFC 合集：#543/#544/#545/#546/#547/#548）存在结构性错误，需要**在现有 RFC 基础上重写**——不是推翻重来，而是：保留没有问题的部分，删掉有问题的部分，按新收敛的设计模型修正抽象。

## 必读材料（按顺序读，全部在本目录）

1. `record-1-用户与设计水准评价.md` — 第一份对话记录（546 审计的元评价 + 任务代数设计推演）
2. `record-2-对话记录评价.md` — 第二份对话记录（代数性质、封口、位置时机、交接契约、分形结构）
3. `record-3-本session设计讨论纪要.md` — **最新、最权威**的设计收敛（时态模型、纯函数化公理、双域对偶、值管道、fail/NIL、hook/GUI 最终定义、重写纪律）

三份材料有时间先后，冲突时以 record-3 为准，record-3 内部以操作员原话引用块为准。

重写对象只有一个文件：`/Users/mouriya/Ext/code/coder-loop/v3-issue/A.md`（1388 行）。**不要关注仓库里其他 RFC 相关文件**（v3-issue/n/、synthesized/、design/ 等都不是本任务对象）。

## 操作员钉住的重写方向（原话见 record-3 第 19 轮）

- 保留没有问题的部分，删掉有问题的部分。
- 当前 RFC 的划分面可能不对，可能需要增加面和减少面。
- 典型例子：**脚本的扫描、发现、注入，和抽象完全无关，这是纯 TS 的事情**——不应占据 RFC 的抽象篇幅。
- 需要重新设计的面：**代码生成、类型系统的拼接和设计、如何保证编译面正常工作、如何保证运行时有对应的内容**。

## 已知的保留/删除基线（record-3 第 12/18 轮，操作员未反驳的对照结论）

保留（判断为没有问题的部分）：
- 546 的对象域骨架：三域切分、前向单调、异常与业务 tag 二分、群组消费、闭包资源合同、GC 与 publication 四值证据
- 547 的定义态冻结链：CompileEnvelope 唯一判定、不可变 publish、pin、H1/H2 restart 语义、legacy-unproven
- 548 的三层分权（router/consumer/CLI）与 durable request record
- 544 的进程独立性、严格只读、三证等交付纪律
- 543 的 subprocess primitive（spawn/超时/进程组回收）

删除/重构（判断为有问题的部分）：
- 547 的 ToolOutcome/GateEvaluation journal 状态机（被 context 类型系统取代——函数域时态事实不进 daemon 账本）
- 545 的 opaque body + existence-only required + finalize 终判（升级为 typed agent 值提升口 + agent 时态出口填值校验）
- 543 的 gate 词表/decision parser/evaluation journal/四层合成/preset 层声明位（hook 收缩为时态锚点上的旁路脚本，完全独立于 preset）
- 各篇中把闭包内时态事实上浮到调度层的所有机制

新增的面（RFC 目前完全缺失）：
- 五时态模型与 context 单调累积
- 值管道：类型定义 + map 函数骨架 + 来源面/消费面双面闭合检查 + 代码生成
- 检查面（谓词槽默认恒真）与路由面（特殊 context 值、n 三分）的正交结构
- fail 的 total 语义（特殊步骤 + NIL + 配置级联 + 硬默认停机）
- 两层校验分离（填值校验 vs 流转校验）
- 异常的时态归属规则
- 纯程序节点

## 工作协议

1. **先对齐认知再动手**：你先读完三份材料 + A.md 全文，然后向主 session 复述你对设计模型和重写方向的理解（不超过 30 行要点）。主 session 确认你的认知没有问题后，才开始改动。
2. **每轮只改一定范围**：一轮聚焦一个明确范围（例如某一篇 RFC 的某几节、或新增某一个面），不整篇重写。范围由主 session 每轮商定。
3. **每次改动都 commit**：conventional commit（docs: 前缀），信息说明本轮范围。
4. 中文写作，保持 A.md 现有文风（论证式散文，不是 bullet 清单）；图用 mermaid。
5. 不修改本目录（rewrite-materials/）下的材料文件。
