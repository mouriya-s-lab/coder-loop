# v3 RFC 新划分方案（主 session 起草，v3.2，经四轮对抗修订）

状态：v3.2。历经四轮对抗（22+6+3+5 组发现逐条裁决，记录见文末与 git 历史）。待第五轮复核通过后定稿。定稿前不据此改 A.md 正文。

## 权威标注纪律（本文件自身即遵守）

每条规范性陈述标注三元组【等级 | 位置 | 状态】：
- 等级：`操作员原话` / `record 收敛`（assistant 推导未被反驳）/ `主 session 裁决`（重写过程新决定，含对 codex 异议的采纳；record-3 未载的本 session 裁决也归此级并注明）/ `旧 RFC 候选`（保留自 A.md 旧文、未经新模型重审；其中旧文记录的操作员裁决在正文说明，不另设等级）
- 位置：只填文献锚点（record-N 时间段或轮次、A.md 章节），可并列多个；无锚点填 `—`。来源判断一律写等级槽。
- 状态：`已裁决` / `未反驳` / `待复核` ——封闭三态，逐字使用，不加后缀。
一条陈述含多来源时拆成多条三元组分别标注。`旧 RFC 候选` 只是 provenance，不自成权威。

## 划分依据

1. **定义态 / 运行态**【record 收敛 | record-3 第 13/15 轮 | 未反驳】
2. **函数域 / 对象域**，只经针眼相接【操作员原话 | record-3 第 15 轮 | 已裁决】
3. **入站 / 出站**方向相反、状态机不同，各自成面【主 session 裁决 | — | 未反驳】
4. **主流转 / 旁路**：hook、GUI 不拥有主流转裁决权【操作员原话 | record-3 第 18 轮 | 已裁决】

核心纪律：**每个事实和决策只有一个 owner 面；其他面只消费其 typed 合同，不得复制 parser、状态机或权威记录。权威方向单向；需求流向可以双向。**【主 session 裁决 | — | 未反驳】

## 面 0：公共设计模型（总纲）

- 纯函数化公理（两提升口、信任压缩、副作用丢弃）【操作员原话 | record-3 第 16 轮 | 已裁决】
- 双域对偶与针眼【操作员原话 | record-3 第 15/16 轮 | 已裁决】
- 五时态与 context 单调累积概览【操作员原话 | record-3 第 6/11 轮 | 已裁决】；概览归总纲、执行协议归面 2【主 session 裁决 | — | 未反驳】
- 两层校验形态区分【操作员原话 | record-3 第 11 轮 | 已裁决】
- 异常时态归属规则【操作员原话 | record-3 第 14 轮 | 已裁决】；展开表归面 2【主 session 裁决 | — | 未反驳】
- 编译期/运行时精确边界【record 收敛 | record-1 2:36-2:38 段、record-3 第 3 轮 | 未反驳】
- 分形交接形状【操作员原话 | record-2 3:23 段 | 已裁决】；一份文法两个作用域、持久性差异【record 收敛 | record-2 3:24 段 | 未反驳】
- 公共词汇；preset 术语张力观察，最终命名待操作员裁决【主 session 裁决 | record-3 第 7 轮 | 待复核】
- 现状：草稿 c35d44b 欠修订轮；修订输入=四点审读意见、0.9 整节删除、分形形状补入、本标注纪律。

## 面 1：定义态——preset 定义资产、代码生成与编译面

- 三面一体定义资产、map 骨架生成、注释枚举 context、map 不写完=preset 没写完、staleness 即失配【操作员原话 | record-3 第 4/5 轮 | 已裁决】
- 两层交接契约的声明位（运行语义归面 2/面 3）【主 session 裁决 | — | 待复核】
- 双面闭合检查、警告/严格两档【操作员原话 | record-3 第 4 轮 | 已裁决】；谓词槽语法在此、语义面 2、概念面 0【主 session 裁决 | — | 未反驳】
- 定义冻结与取回（CompileEnvelope、identity 分域、publish、pin、resolver、corrupt/GC、legacy-unproven、H1/H2 restart）【旧 RFC 候选 | A.md 旧 547 §2/§3/§8 | 待复核】
- 两个保证：编译面正常工作=可达性证明；运行时有对应内容=map 资产随 pin+resolver 取回【主 session 裁决 | record-3 第 19 轮 goal 原文 | 未反驳】
- 非目标：脚本扫描/发现/注入=纯 TS 工程事务【操作员原话 | goal 原文 | 已裁决】

## 面 2：函数域运行时——闭包执行语义

- 五时态执行协议、两层校验执行协议、检查/路由正交、特殊 context 值与 n 三分、纯程序节点、异常归属展开表【操作员原话 | record-3 第 6-11/14 轮 | 已裁决】
- n=0 即闭包交付，消费归面 3【主 session 裁决 | — | 未反驳】
- fail 特殊步骤、NIL 默认实现【操作员原话 | record-3 第 10 轮 | 已裁决】
- 步骤级动作执行 + typed escalation 发出，级联 policy/evaluator 归面 3【主 session 裁决 | — | 待复核】
- 漏气孔拆分：epilogue 常量、地址代值归本面【主 session 裁决 | — | 未反驳】；四漏气孔事实【record 收敛 | record-3 第 17 轮 | 未反驳】
- provider 仅一节陈述为实现细节【操作员原话 | record-3 第 17 轮 | 已裁决】；合同本体归面 5【主 session 裁决 | — | 未反驳】
- 旧 545 opaque append/read 从核心删除、不占 context 词【主 session 裁决 | — | 待复核】；agent 填值=typed 提升口【操作员原话 | record-3 第 3 轮 | 已裁决】

## 面 3：对象域——任务代数与调度

- 三域切分与任务链设计自述【操作员原话 | record-1 2:28 段 | 已裁决】
- dependsOn 布尔门与群组消费之别【操作员原话 | record-1 2:30 段 | 已裁决】
- 前向单调、异常作为落定值、seq=群组大小 1 退化【record 收敛 | record-1 2:31-2:35 段 | 未反驳】
- 动词表（spawn/commit/admit/release/await）【record 收敛 | record-1 2:35 段 | 待复核】【旧 RFC 候选 | A.md 旧 546 §7 | 待复核】
- 位置+时机入链【操作员原话 | record-1 2:48 段 | 已裁决】；重新锚定=提议方重新声称、引擎只判不选【操作员原话 | record-2 3:09 段 | 已裁决】
- admit 协议（开放前沿查询、typed 拒绝、重新声称提交；面 2/面 4 两类调用者）【record 收敛 | record-2 3:03 段、record-1 2:28 段 | 未反驳】；协议 owner 落此面【主 session 裁决 | — | 待复核】
- 群组结束=消费+可选等待窗口：可选等待时间（如六十秒）【操作员原话 | record-2 3:06 段 | 已裁决】；期满入日志【record 收敛 | record-2 3:07 段 | 未反驳】；窗口重置/固定为声明参数【record 收敛 | record-2 3:07 段 | 待复核】
- committed transition/锁/crash replay/唯一活 run【record 收敛 | record-1 2:35 段前后 | 未反驳】【旧 RFC 候选 | A.md 旧 546 §10 | 待复核】
- 闭包资源合同、GC/publication、residue 对账【旧 RFC 候选 | A.md 旧 546 §11-12 | 待复核】
- fail 级联 policy owner：配置 schema、policy ADT、evaluator、任务/组/item 层动作执行归本面，消费面 2 escalation【主 session 裁决 | — | 待复核】；级联层级枚举【操作员原话 | record-3 第 10 轮 | 已裁决】
- 消费面 5 封闭事实 ADT（映射见面 5）【主 session 裁决 | — | 待复核】
- 升层消费；await 不构成第二跨域通道【主 session 裁决 | record-2 3:24 段 | 未反驳】
- 迁移：v2 slot 串行是资源限制非业务 seq【旧 RFC 候选 | A.md 旧 546 §15 | 未反驳】

## 面 4：外部工作注入（入站边界）

- router/consumer/CLI 三层、into-chain/new-workspace、三 identity、幂等、durable request record、CLI typed result ADT【旧 RFC 候选 | A.md 旧 548 | 待复核】（其中空 chain、规范 work identity 等为旧 548 记录的操作员裁决 D1-D11，重写轮按已裁决对待）
- schema 消费面 1 类型权威；注入声称经面 3 admit 协议提交【主 session 裁决 | — | 未反驳】

## 面 5：runner provider 与执行边界（出站边界）

- provider 合同形状收编（argv builder、model、session identity 与 resume、env/sandbox 面）【主 session 裁决 | — | 待复核】；provider=实现细节【操作员原话 | record-3 第 17 轮 | 已裁决】
- endpoint identity 与 probe 契约、缺席/恢复事实、terminal/loss 唯一 durable winner【旧 RFC 候选 | A.md 旧 548 §9.4/§9.5 | 待复核】
- 输出封闭事实 ADT 及逐 variant 唯一消费者【主 session 裁决（第三/四轮对抗采纳，record-3 未载）| — | 待复核】；variant 事实基础【旧 RFC 候选 | A.md 旧 548 §9.4/§9.5、旧 547 §9 | 待复核】：
  - `pre-spawn absence` → 面 3 以 held 调度处置消费，不建 run；
  - `terminal winner` → 经正常针眼交付路径（returned|exception）由面 3 committed transition 消费；
  - `active loss`：丢失检测与 terminal/loss winner 判定归本面；winner 为 loss 时，面 3 将该 run 消费为 exception 落定；
  - `unknown effect` → 面 3 以 unknown hold 消费，不重复推进；
  - 不输出 generic held；新增 variant 必须同时指定唯一消费者。

## 面 6：hook 执行（旁路脚本）

- 时态锚点、operator 声明、不参与 context、不影响流转【操作员原话 | record-3 第 18 轮 | 已裁决】
- subprocess primitive 与审计【旧 RFC 候选 | A.md 旧 543 §四/§五 | 待复核】
- 定位：effectful subprocess runtime，不拥有主流转裁决权、不产生领域 mutation 权威【主 session 裁决 | — | 未反驳】

## 面 7：观测产品（GUI）

- context 面+副作用面二分本体【操作员原话 | record-3 第 18 轮 | 已裁决】
- 分栏有限控制面、共享 identity 不共享权威【主 session 裁决（record-3 未载）| — | 未反驳】；控制动作闭集【旧 RFC 候选 | A.md 旧 544 §4.3 | 待复核】
- 544 交付纪律（进程独立、严格只读 reader、单 root、mesh-only、attempt artifact、SSE）【旧 RFC 候选 | A.md 旧 544 | 待复核】
- 边界：只拥有呈现、transport 与交互结果，不拥有 hook 审计、调度状态或 mutation 合法性的解释权【主 session 裁决 | — | 未反驳】

## 重写约束（随划分定稿生效）

各面重写：删除与面 0 冲突的旧机制；保留新边界内成立的证据/资源/恢复合同；规范性陈述按本标注纪律执行三元组；旧 543-548 与新八面的映射表收尾轮统一落一处。【主 session 裁决 | — | 未反驳】

## v3.1→v3.2 裁决记录（对 codex 第四轮复核五组发现）

| # | 发现 | 裁决 |
|---|---|---|
| 1 | 状态词带后缀越界 | 接受：封闭三态逐字使用，说明文字移入正文或等级槽 |
| 2 | record-2 2:28 不存在（实为 record-1 2:28） | 接受：订正 |
| 3 | 混合来源未拆、来源判断混入位置槽（55/59/60/62/67/72/74/90 等） | 接受：全部拆为独立三元组，位置槽只留锚点 |
| 4 | 四 variant 出处 A.md 旧 547 §9 覆盖不全 | 接受：改为旧 548 §9.4/§9.5 并列旧 547 §9；映射裁决如实标注 record-3 未载 |
| 5 | active loss"重写轮定"形成双 owner 悬置 | 接受并裁决：检测与 winner 判定归面 5，loss 胜出由面 3 消费为 exception 落定 |

v1→v2、v2→v3、v3→v3.1 见 git 历史（3695a61、5d7fe65、6f40820）。
