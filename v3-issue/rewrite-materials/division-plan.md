# v3 RFC 新划分方案（主 session 起草，v3.1，经三轮对抗修订）

状态：v3.1。v1→v2 第一轮对抗、v2→v3 第二轮对抗、v3→v3.1 第三轮复核修补（裁决记录见文末）。待第四轮复核通过后定稿。定稿前不据此改 A.md 正文。

## 权威标注纪律（本文件自身即遵守）

每条规范性陈述标注三元组【等级 | 位置 | 状态】：
- 等级：`操作员原话` / `record 收敛`（assistant 推导未被反驳）/ `主 session 裁决`（重写过程中的新决定，含对 codex 异议的采纳）/ `旧 RFC 候选`（保留自 A.md 旧文、未经新模型重审）
- 位置：只填文献锚点（record-N 的时间段或轮次、A.md 章节）；无文献锚点填 `—`。来源判断一律写等级槽，不塞位置槽。
- 状态：`已裁决`（操作员明确说过）/ `未反驳`（推导且操作员未反对）/ `待复核`（进入对应面的重写对抗轮清单）——封闭三态，不得使用其他状态词。
混合来源必须拆开标注。`旧 RFC 候选` 只是 provenance，不自成权威。

## 划分依据

1. **定义态 / 运行态**【record 收敛 | record-3 第 13/15 轮 | 未反驳】
2. **函数域 / 对象域**，只经针眼相接【操作员原话 | record-3 第 15 轮"所有机制都是闭包内的，和任务调度完全无关" | 已裁决】
3. **入站 / 出站**：外部工作注入与外部执行终端方向相反、状态机不同，各自成面【主 session 裁决（采纳 codex 第一轮异议）| — | 未反驳】
4. **主流转 / 旁路**：hook、GUI 不拥有主流转裁决权【操作员原话 | record-3 第 18 轮 | 已裁决】

核心纪律：**每个事实和决策只有一个 owner 面；其他面只消费其 typed 合同，不得复制 parser、状态机或权威记录。权威方向单向；需求流向可以双向。**【主 session 裁决（采纳 codex 第一轮替代案表述）| — | 未反驳】

## 面 0：公共设计模型（总纲）

- 纯函数化公理（两提升口、信任压缩、副作用丢弃）【操作员原话 | record-3 第 16 轮 | 已裁决】
- 双域对偶与针眼【操作员原话 | record-3 第 15/16 轮 | 已裁决】
- 五时态与 context 单调累积**概览**【操作员原话 | record-3 第 6/11 轮 | 已裁决】；"概览归总纲、执行协议归面 2"【主 session 裁决 | — | 未反驳】
- 两层校验**形态区分**（parser vs 带异常 map 子函数）【操作员原话 | record-3 第 11 轮 | 已裁决】
- 异常时态归属**规则**【操作员原话 | record-3 第 14 轮 | 已裁决】；逐时态展开表归面 2【主 session 裁决 | — | 未反驳】
- 编译期/运行时精确边界（可达性证明 ≠ 运行结果）【record 收敛 | record-1 2:36-2:38 段 + record-3 第 3 轮 | 未反驳】
- 分形交接形状：步骤与 task 共用交接合同形状【操作员原话 | record-2 3:23 段"leaf和步骤都存在交接……只是打包的值不同" | 已裁决】；"一份文法两个作用域"与持久性差异（任务层日志承诺/步骤层可蒸发）【record 收敛 | record-2 3:24 段 assistant 推导 | 未反驳】
- 公共词汇；preset 术语张力【主 session 裁决（对操作员用法的观察）| record-3 第 7 轮 | 待复核（待操作员裁决）】
- 现状：草稿 c35d44b 欠修订轮；修订输入=四点审读意见 + 0.9 整节删除 + 分形形状补入 + 本标注纪律。

## 面 1：定义态——preset 定义资产、代码生成与编译面

- 三面一体定义资产、map 骨架生成、注释枚举 context、"map 不写完=preset 没写完"、staleness 即失配【操作员原话 | record-3 第 4/5 轮 | 已裁决】
- 两层交接契约的**声明位**（步骤/任务同一文法，声明位在此；运行语义归面 2/面 3）【主 session 裁决 | — | 待复核】
- 双面闭合检查、警告/严格两档【操作员原话 | record-3 第 4 轮 | 已裁决】；谓词槽语法形状在此、求值语义面 2、概念面 0【主 session 裁决 | — | 未反驳】
- 定义冻结与取回（CompileEnvelope、identity 分域、publish、pin、resolver、corrupt/GC、legacy-unproven、H1/H2 restart）【旧 RFC 候选 | A.md 旧 547 §2/§3/§8 | 待复核】
- 两个保证的正面表述（编译面正常工作=可达性证明；运行时有对应内容=map 资产随 pin+resolver 取回）【主 session 裁决（操作员点名两个待设计面的落点归纳）| record-3 第 19 轮 goal 原文 | 未反驳】
- 非目标：脚本扫描/发现/注入=纯 TS 工程事务【操作员原话 | goal 原文 | 已裁决】

## 面 2：函数域运行时——闭包执行语义

- 五时态执行协议、两层校验执行协议、检查/路由正交、特殊 context 值与 n 三分、纯程序节点、异常归属展开表【操作员原话 | record-3 第 6-11/14 轮 | 已裁决】
- n=0 即闭包交付；交付的消费归面 3（针眼两侧分工）【主 session 裁决 | — | 未反驳】
- fail 的闭包内机制：fail 特殊步骤、NIL 默认实现【操作员原话 | record-3 第 10 轮 | 已裁决】；步骤级动作执行 + 无法在步骤层消化时发出 **typed escalation**，级联 policy ADT/evaluator 归面 3【主 session 裁决（采纳 codex 第二轮方案）| — | 待复核】
- 漏气孔归属拆分：epilogue 常量、地址代值 → 本面（函数输入与值管道）；隐式 env/sandbox、session 身份 → 面 5【主 session 裁决（codex 第二轮异议 2）| — | 未反驳】；四漏气孔事实本身【record 收敛 | record-3 第 17 轮 subagent 代码调查 | 未反驳】
- provider 仅一节：纯函数调用实现细节的陈述【操作员原话 | record-3 第 17 轮"这并不重要" | 已裁决】；合同本体归面 5【主 session 裁决 | — | 未反驳】
- 旧 545 opaque append/read 通道从核心删除、不占 context 词【主 session 裁决（采纳 codex 第一轮悬置 3 立场）| — | 待复核】；agent 填值=typed 提升口【操作员原话 | record-3 第 3 轮 | 已裁决】

## 面 3：对象域——任务代数与调度

- 三域切分【操作员原话 | record-2 2:28 段设计自述 + record-1 | 已裁决】；前向单调、异常作为落定值、群组消费（seq=大小 1 退化）【record 收敛 | record-1 2:30-2:35 段 | 未反驳】；dependsOn 布尔门【操作员原话 | record-1 2:30 段 | 已裁决】
- 动词表（spawn/commit/admit/release/await）【record 收敛 + 旧 RFC 候选 | record-1 2:35 段清单轮 + A.md 旧 546 | 待复核】
- 动态追加：位置+时机入链【操作员原话 | record-1 2:48 段 | 已裁决】；重新锚定=提议方对开放前沿的重新声称、引擎只判不选【操作员原话 | record-2 3:09 段 | 已裁决】
- **admit 协议**：开放前沿查询（判定副产品）、typed 拒绝结果、重新声称提交；内部派生方经面 2 声明通道、外部调用方经面 4——同一端口两类调用者【record 收敛 | record-2 3:03 段 + record-1 2:28 段 | 未反驳】；协议 owner 落此面【主 session 裁决（codex 第二轮异议 5）| — | 待复核】
- 群组结束=消费+可选等待窗口：可选等待时间（如六十秒）【操作员原话 | record-2 3:06 段 | 已裁决】；期满作为事件入日志【record 收敛 | record-2 3:07 段 assistant 推导 | 未反驳】；窗口重置/固定为声明参数【record 收敛 | record-2 3:07 段 | 待复核】
- committed transition/锁/crash replay/唯一活 run【record 收敛 + 旧 RFC 候选 | record-1 + A.md 旧 546 §10 | 待复核】；闭包资源合同、GC/publication、residue 对账【旧 RFC 候选 | A.md 旧 546 §11-12 | 待复核】
- **fail 级联 policy owner**：级联配置 schema、policy ADT、evaluator、任务/组/item 层动作执行全归本面；消费面 2 的 typed escalation【主 session 裁决（codex 第二轮异议 4 方案）| 级联层级为操作员原话 record-3 第 10 轮 | 待复核】
- 消费面 5 的封闭事实 ADT（映射见面 5）【主 session 裁决 | — | 待复核】
- 升层消费、await 不构成第二跨域通道【主 session 裁决 | record-2 3:24 段相关 + 本 session 推导 | 未反驳】
- 迁移：v2 slot 串行是资源限制非业务 seq【旧 RFC 候选 | A.md 旧 546 §15 | 未反驳】

## 面 4：外部工作注入（入站边界）

- router/consumer/CLI 三层、into-chain/new-workspace、三 identity、幂等、durable request record、CLI typed result ADT【旧 RFC 候选 | A.md 旧 548（其 D1-D11 为操作员既有裁决）| 待复核】
- schema 消费面 1 类型权威；注入的位置+时机声称经面 3 admit 协议提交（消费不复制）【主 session 裁决 | — | 未反驳】

## 面 5：runner provider 与执行边界（出站边界）

- provider 合同形状：argv builder、model、session identity 与 resume、env/sandbox 面【主 session 裁决（自面 2/面 4 收编；provider=实现细节为操作员原话 record-3 第 17 轮）| — | 待复核】
- endpoint identity 与 probe 契约、缺席/恢复事实产生、terminal/loss 唯一 durable winner【旧 RFC 候选 | A.md 旧 548 §9 | 待复核】
- **输出封闭事实 ADT 及逐 variant 唯一消费者**【主 session 裁决（codex 第二轮异议 3、第三轮补全）| 三态区分为旧 RFC 候选 A.md 旧 547 §9 | 待复核】：
  - `pre-spawn absence`（spawn 前 endpoint 不可用）→ 面 3 以 held 调度处置消费，不建 run；
  - `terminal winner`（业务 terminal 先于 loss 提交）→ 经正常针眼交付路径（returned|exception）由面 3 的 committed transition 消费；
  - `active loss`（执行中 endpoint 丢失且 loss 先提交）→ 面 3 以 run 异常路径消费（落定为 exception，具体语义面 5/面 3 重写轮定）；
  - `unknown effect`（外部动作可能已发生但不可证明）→ 面 3 以 unknown hold 消费，不重复推进；
  - 不输出 generic held；新增 variant 必须同时指定唯一消费者。

## 面 6：hook 执行（旁路脚本）

- 时态锚点、operator 声明、不参与 context、不影响流转【操作员原话 | record-3 第 18 轮 | 已裁决】
- subprocess primitive（spawn/超时/进程组/at-least-once 恢复）与审计【旧 RFC 候选 | A.md 旧 543 §四/§五 | 待复核】
- 定位：effectful subprocess runtime，不拥有主流转裁决权、不产生领域 mutation 权威【主 session 裁决（codex 第一轮异议 16）| — | 未反驳】

## 面 7：观测产品（GUI）

- context 面+副作用面二分本体【操作员原话 | record-3 第 18 轮 | 已裁决】
- 分栏有限控制面（生命周期/unblock/decision；共享 identity 不共享权威）【主 session 裁决（本 session 对 codex 认知轮疑点的裁决，record-3 未载）+ 旧 RFC 候选 | A.md 旧 544 §4 | 未反驳】
- 544 交付纪律（进程独立、严格只读 reader、单 root、mesh-only、attempt artifact、SSE）【旧 RFC 候选 | A.md 旧 544 | 待复核】
- 边界：只拥有呈现、transport 与交互结果，不拥有 hook 审计、调度状态或 mutation 合法性的解释权【主 session 裁决（codex 第二轮表述采纳）| — | 未反驳】

## 重写约束（随划分定稿生效）

各面重写：删除与面 0 冲突的旧机制；保留新边界内成立的证据/资源/恢复合同；规范性陈述按本标注纪律执行三元组；旧 543-548 与新八面的映射表收尾轮统一落一处。【主 session 裁决 | — | 未反驳】

## v3→v3.1 裁决记录（对 codex 第三轮复核）

| # | 复核发现 | 裁决 |
|---|---|---|
| 1 | 裁决 3 部分落实：active loss 逐 variant 映射未完成 | 接受：面 5 补全四 variant 及唯一消费者 |
| 2 | 裁决 6 未落实："四元组"实为三字段、全文多处混标漏标、状态词越界 | 接受：更正为三元组、补齐核心纪律/面6/面7/重写约束标注、状态词收口封闭三态 |
| 3 | 三处引用定位错误（record-2 3:04→3:03；"record-3 裁决 5"不存在；record-1 末段→2:36-2:38 段） | 接受：全部订正；面 7 依据如实改标为主 session 裁决（record-3 未载） |

v1→v2、v2→v3 裁决记录见 git 历史（3695a61、5d7fe65）。
