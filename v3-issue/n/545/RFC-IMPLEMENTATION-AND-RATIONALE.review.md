# `RFC-IMPLEMENTATION-AND-RATIONALE.md` 独立复核

## A. Verdict

**PASS**

正文已经满足“单独解释 RFC 实现什么、为什么实现”的要求。它是一篇可独立阅读的完整技术论述，不是概要、验收清单或旧阶段报告的拼贴；当前代码资产、RFC 目标行为、产品可达边界和外部 CAP-IN 依赖也已明确分开。上一轮发现的六项需求污染均已消除，没有发现新的阻塞问题。

## B. 结构与原创性

正文从实际问题出发，依次论述通道边界、entry 模型、daemon authority、read 协议、group 消费、required/expected、prompt、持久层地基、类型边界、组合运行形态与排除项。各关键机制不仅描述 what，也说明 why：

- `RFC-IMPLEMENTATION-AND-RATIONALE.md:5-19` 解释为什么 GitHub、`shared.md` 与 context 必须并存，而不是用新通道替换旧通道；
- `:23-37` 解释 opaque body、封闭 scope、无 run scope、append-only 与 credential-derived author 分别防止什么错误；
- `:49-66` 解释为什么 read 必须主动拉取、为什么使用稳定 keyset、为什么并发分页需要定义观察集合；
- `:68-76` 解释 context 为什么只能消费并行结构结论，不能从 fixture ancestry 发明 membership；
- `:78-86` 解释 outcome 为什么是 durable author existence，而不是一次 provider 调用；
- `:132-138` 解释排除项如何防止 context 膨胀成业务数据库、消息总线或第二套工作流语言。

全文没有 TL;DR 或概要章节，也没有沿用 `D/S/F/J` 编号充当正文骨架。对当前目录既有 Markdown 重新做连续文本相似检查，没有发现 100 字以上的大段照抄；正文保持独立组织与独立表述。用户无需先读旧文档即可理解问题、机制、理由、依赖和非目标。

## C. 事实与边界

### C.1 当前实现与目标实现

`RFC-IMPLEMENTATION-AND-RATIONALE.md:96-110` 把当前代码准确描述为“局部构件”，并逐项列出尚未完成的产品能力，没有再把当前 write asset 概括成 read/group/outcome 已完成。`:140-154` 以固定基线 `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd` 的源码和测试位置支撑当前事实；阶段报告在 `:156` 仅作为调查索引，不再替代源码与运行证据。

内部 store API/test fixture 与产品入口的边界已经正确：`:41` 明确内部 SQLite/store primitive 不因可直接调用而成为产品 API；`:110` 明确保留内部持久化表达能力，不从内部 shape 推导产品旁路或 item-delete lifecycle。正文没有再声称当前存在产品 item-delete 命令或竞态。

### C.2 RFC 自有能力与外部 CAP

group 部分 `:68-76` 明确把合法任务数学、stable group identity、membership 与真实 branch producer交给并行结构层；context 只消费并验证其结论。required/expected 部分 `:84-86` 明确全 run 合同等待统一 scheduler lifecycle。`:118` 明列 tool DSL、合法 `par` 数学、真实 producer 与 trigger/validator lifecycle 是外部能力；`:122` 又在“完成后的实际运行”开头声明该章节描述 RFC-owned context 能力与 CAP-IN 同时到位后的组合行为，不冒充 RFC 自己实现外部能力。

因此“完成后的实际运行”没有混淆 RFC 本身、未来 context 消费能力与外部 CAP。

### C.3 事实引用

复核了正文点名的关键直接代码面：固定基线确有 `AGENT_ATTRIBUTED_COMMANDS`、内部 `listContextEntries`、positional chain selector、group admission 拒绝、现有 append integration 与不完整响应测试。引用层级现在正确：源码/测试证明当前状态，阶段报告只追踪更长调查过程；没有以已经纠错的旧报告结论作为权威事实。

## D. 需求污染复核

### D.1 Storage authority 与 item lifecycle

**已消除。** `:41,110` 只要求产品可达读写经过 daemon authority，允许内部 persistence primitive 继续存在；没有封闭 store/test API 的新要求，也没有 item-delete 生命周期要求。稳定约束只保留 admission 当下 key 合法与 chain 终结清理。

### D.2 Admission、audit 与 caller result

**已消除。** `:45` 精确限定接受/拒绝 admission verdict 与对应 entry/audit 的一致性，并明确 socket response 不参加 durable admission 关系。`:103` 再次说明 response 只需完整成功或显式失败，不与 entry/audit 原子提交，也不保证 caller 能判断 entry 是否存在。没有 exactly-once、operation identity 或 result-query 保证。

### D.3 Session guarantee

**已消除。** `:47,104,110` 明确区分 transport 必须显式失败且不挂起，与 unfinished begin/chunk session 的清理、TTL、恢复、持久化。后四项被明确排除，没有从当前内存 session 形状生长新产品义务。

### D.4 Prompt scope 与 command shape

**已消除。** `:90` 不再预先决定 chain selector 由 credential 自动填充：最终 command 自动推导的参数才标注无需填写，显式 selector/key 则提供合法值；同时明确固定基线 append 仍要求 positional chain selector，未来 shape 由 runtime command contract决定。`:92` 继续保持 handle 是地址而不是 capability。

### D.5 Pagination、malformed、group 与 lifecycle

- 分页并发集合只要求定义并证明一致集合，不预设页间新 entry 纳入或排除（`:55-62`）。
- malformed row 以明确 boundary failure 暴露，不新增逐行跳过、生产清洗或“存量已清洁”保证（`:66,106,130,134`）。
- group membership 不从 ancestry 推导，不定义 nested 数学、结合律或“最近/全部祖先”伪问题（`:68-76,136`）。
- chain cleanup 是 RFC 地基；统一 run finalize 与异构 run lifecycle 仍明确依赖外部能力（`:84-86,102,118,122`）。

## E. 必须修复项

**无。**

上一轮六项均已按被指出的局部缺陷原位收敛，没有通过整体重写隐藏问题，也没有产生反向摆动。

## F. 非阻塞建议

**无。** 当前文档可作为本次用户要求的正式独立说明交付。
