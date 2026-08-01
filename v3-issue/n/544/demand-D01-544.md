# RFC #544 R10 / D1 — 严格只读 status snapshot 原子需求

> 需求事实源仅为 AGG D1 稳定语义、`expected-foundation-544.md` 的 F/X/U 地基，以及纠偏后的 S1 摘要。本报告定义能力需求，不选择 opener、transaction wrapper、投影或序列化实现形态；不把特殊文件系统、断电、资源 cap 等风险扩成需求。

## A. 一页摘要

D1 要交付的是一条 **daemon 不在场也可调用的 engine-owned status snapshot 读取能力**。它必须在同一次调用中同时成立：

1. SQLite 从打开到关闭严格只读，不创建文件、不改变 journal/WAL/schema、不执行 migration；
2. daemon-down 重复读取对 DB/WAL/journal/schema 的 bytes 与 metadata 中立；
3. 数据库不可消费时返回显式 typed schema mismatch/读取失败结果，不伪装成 `missing-state`；
4. snapshot 的 SQLite 持久部分来自同一 read snapshot，不能把不同 commit 的 queue/current/runs/taskTree 拼成合法对象；
5. 输出沿同一个 engine-owned 精确 boundary 流向最终 CLI/HTTP wire，不能在验证后再发生未验证改写；
6. target/root、chain 与 taskTree 的持久事实身份不由进程、worktree 或 git 痕迹反推。

共形成 **9 项原子需求 D01-R01–R09**。其中 D1 自身必须建立 5 项；相邻地基 F03–F05 直接供给 4 项，D1只需消费而不得另建平行实现；地基缺口为 0。U01–U04仍是实现后的运行证明输入，不改变需求，也不阻塞R10。

验收必须观察真实副作用与结果：daemon停止后调用；读取前后逐文件比较 bytes/metadata/schema；构造不可消费schema观察typed结果；用并发writer barrier证明SQLite持久槽属于同一commit；让最终CLI/HTTP JSON由同一boundary重新parse。类型检查、静止fixture或“只执行SELECT”不能单独证明D1。

## B. 原子需求矩阵

### B1. 需求、供给与所有权

| 需求 ID | 原子需求 | 稳定来源 | F 映射 | Owner / 分类 | 验证时必须观察 | 仍未知 |
|---|---|---|---|---|---|---|
| **D01-R01** | 存在一条engine-owned status snapshot读取入口；daemon进程不存在时仍可调用，不依赖socket RPC取得SQLite状态 | AGG D1定义；daemon-down立身场景 | F01 | **D1自身建立** | 停止daemon后直接调用成功或返回typed DB结果；无RPC活性前提 | U01、U02 |
| **D01-R02** | SQLite连接从建立到关闭均为read-only，不创建主DB或sidecar来“补齐”缺失状态 | AGG D1“SQLite以read-only打开” | F01 | **D1自身建立** | 缺盘、正常盘、只读权限盘前后目录成员、mode、bytes与metadata对比 | U01、U02 |
| **D01-R03** | 读取路径不改变journal mode，不执行WAL/journal mutation，不执行schema migration | AGG D1“无WAL/journal mutation；无schema migration” | F01 | **D1自身建立** | DELETE/WAL与旧schema代表盘读取前后`journal_mode`、`user_version`、schema、DB/WAL/SHM状态不变 | U01、U02 |
| **D01-R04** | daemon-down期间对同一可消费盘重复读取，DB/WAL/journal/schema bytes与metadata中立 | AGG D1明确验收性质 | F01 | **D1自身建立** | 通过生产D1入口连续多次读取；逐文件hash、size、mode、mtime/ctime与schema均不变 | U01、U02 |
| **D01-R05** | 数据库不可消费时返回显式typed结果；schema version mismatch不能被折成missing-state、普通成功或无分类字符串 | AGG D1“显式类型化schema-version mismatch” | F02 | **D1自身建立** | old/new不可消费schema、缺盘、损坏与权限失败产生可穷尽区分的结果；分类不因读取阶段改变 | U02 |
| **D01-R06** | 一次status的全部SQLite持久槽及完整taskTree属于同一read snapshot；并发writer提交只能得到旧整形或新整形，不能得到跨commit拼接 | “status snapshot”语义；S1已证多连接撕裂；CAP-1/D9接缝 | F03 | **地基直接供给，D1消费** | 第二writer在chain/items/current/runs/tree查询边界提交；成功结果可归属于单一commit | U03 |
| **D01-R07** | snapshot的持久身份来自绑定的loop-data root/target、chain与normalized task-tree事实源；不从进程、worktree或git现状重建闭包状态 | D1固定SQLite数据面；CAP-1展示原则 | F03，X07 | **地基直接供给，D1消费** | 改变进程/worktree旁证不改变持久tree投影；切换root/target不能串读 | U03 |
| **D01-R08** | D1产出的snapshot对象必须通过唯一engine-owned精确boundary；顶层及内部槽无匿名object，消费类型从boundary派生 | D3代码红线是D1输出接缝 | F04 | **地基直接供给，D1消费** | 正常、daemon-down、typed DB失败对象均parse；逐槽非法shape被拒绝；无平行手写消费类型 | U04 |
| **D01-R09** | 最终CLI `status --json`与HTTP response wire是同一boundary已验证对象的序列化结果；boundary之后不得再做未验证结构改写 | D3验收；D5消费D1 | F05，X07 | **地基直接供给，D1消费** | 最终CLI与HTTP JSON都由同一boundary parse；domain→wire字段diff可审，`extra`等变换不会发生在最终验证之后 | U04 |

### B2. 计数与依赖判定

| 分类 | 需求 | 数量 | 判定 |
|---|---|---:|---|
| D1自身建立 | D01-R01–R05 | **5** | 是D1能力本体，不能外包给gateway或daemon writer入口 |
| 地基直接供给 | D01-R06–R09 | **4** | 由F03–F05及X07提供；D1必须消费同一资源/boundary，不复制实现 |
| 地基未闭合 | 无 | **0** | U01–U04是运行证明未知，不是缺失合同或阶段gate |
| 原子需求总计 | D01-R01–R09 | **9** | 可进入后续需求拆分 |

F06–F30属于daemon、events、attempt、context、mutation与CAP-4等其他能力地基；除它们未来经同一status boundary投影的接缝外，不生成D1自身的额外读、事务或错误要求。

### B3. 事务、错误与 identity 的边界

#### Read / transaction

- “SQLite文件相同”不等于同一read snapshot；D01-R06要求整个持久投影共享一个commit视图。
- 非DB的events、process与活性三证有各自采样时间；D1不建立跨介质全局事务。
- 单连接、逐statement SELECT、逐helper transaction都不能自行充当D01-R06的验收证据；报告不据此指定具体transaction API。

#### Error

- D01-R05的最小稳定要求是schema不可消费时的typed mismatch；F02同时提供缺盘/不可用等精确读取失败接缝。
- 错误variant的字段名、HTTP状态码与UI文案不是D1需求；但结果必须可穷尽区分，不能回退为catch-all `missing-state`。
- 失败发生在chain resolution还是后续tree读取，不得改变同一问题的domain分类。

#### Identity

- root/target、chain、read snapshot与taskTree持久身份必须贯穿一次调用。
- D1不从pid、socket、worktree、branch或git状态生成持久业务事实。
- 最终wire identity由同一engine-owned boundary维持；gateway不得另建第二schema或SQL投影。

### B4. 验证观察矩阵

| 观察面 | 最小场景 | 通过证据 | 不能替代 |
|---|---|---|---|
| 严格只读 | missing/current WAL/DELETE/old/future/corrupt/permission代表盘 | 调用前后目录清单、hash、mode、mtime/ctime、journal/schema对比 | 只看主DB hash、只执行SELECT、文件权限拒写 |
| daemon-down | daemon已停止，连续调用D1及最终HTTP route | snapshot/typed failure可得；重复读磁盘中立 | daemon活态mock或直接store unit test |
| 单一commit | reader每个持久槽与tree递归边界设barrier，第二writer提交 | 返回对象完整对应barrier前或后commit | 静止DB round-trip、exact shape parse |
| typed error | old/new mismatch、缺盘、损坏、权限 | 精确ADT与稳定exit/HTTP映射接缝；无catch-all折叠 | stderr字符串断言 |
| 最终wire | 正常、daemon-down、错误三类CLI/HTTP响应 | 同一boundary复parse；非法逐槽负例拒绝；无post-parse改写 | builder对象单测、局部events boundary |

### B5. 仍未证明但不得扩成需求

| 未知 | 后续处理 | 不得生成的需求 |
|---|---|---|
| **U01** live WAL在当前Bun/SQLite上实现metadata中立的具体配置 | 实现前做最小spike并以D01-R02–R04验收 | 指定某个未验证SQLite flag或放宽严格只读 |
| **U02** 真实历代盘、特殊/网络FS、migration中断全集 | 用可取得的真实盘补兼容矩阵；声明验证环境边界 | 所有特殊FS/断电均必须支持、通用迁移框架 |
| **U03** 生产writer频率、最大tree深度与snapshot寿命 | 并发与性能测试参数 | 分布式事务、全局锁或跨介质snapshot |
| **U04** 活chain全部optional wire与历史`extra`冲突分布 | D3 shape diff/golden输入 | 平行兼容schema、未证明的永续wire字段 |

### B6. 明确排除

1. response/server caps、server idle/handler deadline与connection cap不属于D1。
2. 特殊文件系统、断电和migration kill恢复不由本需求自动承诺。
3. 不选择独立opener、mode ADT、投影packet或transaction wrapper等工程形态。
4. 不把status改走daemon RPC；否则daemon-down读取能力消失。
5. 不建立SQLite/events/process的跨介质全局snapshot。
6. 不允许gateway复制snapshot schema、SQL查询或另建wire parser。

## C. 证据索引

- 稳定语义：`AGG-544-gui-observability-gateway.md` D1；其消费接缝为D3、D5、CAP-1、D9。
- 修补后地基：`expected-foundation-544.md` F01–F05、X07、U01–U04。
- 纠偏后事实摘要：`decision-S1-status-544.md` A及其固定需求/工程分叉表。
