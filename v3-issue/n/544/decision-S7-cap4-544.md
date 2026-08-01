# RFC #544 R8 / S7 — CAP-4 evaluation decision 决策档案

> 事实基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。输入为 AGG CAP-4/D8/D13/F档、`detail-I15-544.md`及I13/I14摘要；未重读源码、运行实验、实现、估算或拆 issue。

## A. 主 agent 摘要（≤一页）

CAP-4稳定要求已经固定，无“是否实现”裁决：以 `(parId, epoch)` 和 binding version 标识evaluation；decision是`advance | hold | reopen`封闭ADT；当前operator先查询指定evaluation的capability，再通过F档typed operation提交；daemon/evaluator消费decision并使status、event、audit对同一identity/operator/decision对齐。无capability时GUI展示authority缺口，不用resume/unblock/改join冒充decision。

当前资产包括task-tree exact boundary、evaluation identity/history/latest读取、binding version、初始化器和status taskTree投影；当前缺失decision payload、capability查询、typed submit operation、领域consumer与对应status/event/audit。

R7正确揭示了schema只保证PK/CHECK/FK、epoch可晚插、lifecycle `decided`不携三分decision等边界。但它从S6继承的operator认证重构、durable operation、idempotent replay、outbox/saga/command log和known-outcome不是CAP-4稳定前提，全部删除为必备保证。CAP-4只需沿S6固定的既定operator主体、daemon裁判、F typed façade和最小错误传播/结果可观察性接入。

Decision storage、capability计算/保存方式、epoch/currentness机制都是工程形态。操作员裁决0，owner gate 0。

## B. 完整档案

### B1. 稳定语义与当前缺口

| 对象 | 稳定要求 | 当前事实 | 判定 |
|---|---|---|---|
| identity | evaluation由`parId + epoch`并关联binding version | identity、history/latest、bindingVersion已有 | 可保留；提交必须绑定指定identity |
| decision | `advance|hold|reopen`封闭ADT，与lifecycle分离 | lifecycle有`evaluating/decided/consumed`，无decision payload | 必须新增精确domain事实 |
| capability | current operator查询指定evaluation是否可决及合法动作 | 无query/evaluator/authority result | 必须新增typed query；具体机制工程选择 |
| operation | F档包含CAP-4 typed decision operation | 当前无command/handler/result | 必须接入S6 F typed façade |
| consumption | evaluator/consumer执行decision领域效果 | 无consumer，初始化器固定写lifecycle `decided` | 必须真实消费；具体三decision effect由CAP实现语义给出 |
| observability | status/event/audit对齐identity/operator/decision | status仅有evaluation snapshot，无CAP-4 event/audit | 必须同源投影并可核验 |

### B2. Identity与decision ADT边界

- lifecycle和operator decision是两个概念，不能把现有`decided`字符串、`reopen.count`或latest epoch改名冒充三分decision。
- typed request必须携指定evaluation identity和必要的binding/currentness证据；daemon在领域写入口验证后返回accepted、rejected或failed的精确结果。
- 同一evaluation是否只允许一个accepted decision、旧无payload `decided`如何迁移、decision effect何时完成，由选定的storage/currentness形态共同定义；不要求额外durable operation journal。
- status、event与audit必须引用同一evaluation identity、operator subject和decision value，不能由前端拼装。

### B3. Decision storage工程形态

| 形态 | 必须成立 | 确定后果 |
|---|---|---|
| evaluation精确sum variant | `evaluating`无decision，`decided`必须携decision/operator，`consumed`明确保留或引用decision | 单一row即可读取lifecycle与decision；需要显式处理旧无payload数据 |
| 独立immutable decision record | evaluation lifecycle保持原义；decision表以evaluation identity关联三分value/operator/time/binding | decision可独立审计/查询；必须定义record与lifecycle一致性 |
| append-only decision record + evaluation projection | accepted decision作为immutable domain record，evaluation由consumer投影 | 历史与materialization可分离；不因此要求通用command log、永久保留或重放协议 |

optional裸string会产生非法组合，不是完整ADT。具体表、字段和迁移属于工程设计。

### B4. Capability工程形态

| 形态 | 必须成立 | 确定后果 |
|---|---|---|
| 查询时计算 | daemon按operator、evaluation、binding/currentness实时返回合法decision集合，submit时重验 | 无grant漂移；query到submit变化返回typed stale/no-capability |
| 持久grant/lease | grant绑定operator与evaluation并在submit核验/消费 | 可显式撤销/过期；期限与刷新是工程参数，不由本RFC生成 |
| opaque capability handle | daemon签发并验证绑定operator/evaluation/actions的handle | client不复制authority规则；handle生命周期与防重放是实现细节 |

三者均沿S6既定operator调用和daemon裁判，不要求重建正向operator认证；capability只授权该evaluation decision，不授予其他F动作。

### B5. Epoch/currentness工程形态

| 形态 | 必须成立 | 确定后果 |
|---|---|---|
| 单调epoch + expected-current检查 | evaluator创建下一epoch，submit验证current epoch/binding | late旧epoch拒绝；需定义是否允许gap |
| 显式current pointer + row version | current指针而非`max(epoch)`决定可决对象 | history可包含晚插epoch；并发以version conflict表达 |
| per-par serialized evaluator | evaluation创建和decision由同一par序列处理 | 同par顺序明确；不要求建立S6通用durable command log |

稳定文本没有规定epoch连续性、CAS字段或日志机制；选择任一形态只需让stale/conflict精确可见。

### B6. S6与observability接缝

| 边界 | S6责任 | S7责任 |
|---|---|---|
| caller | gateway按既定operator主体调用，daemon裁判 | capability/query/decision引用该operator，不另建认证体系 |
| F typed façade | exact GUI mutation surface与typed args/result/error | 提供CAP-4 query/submit ADT和三分decision |
| 最小结果语义 | accepted/rejected/failed明确，成功状态可核验 | decision记录/消费结果进入status，event/audit同identity |
| target | daemon在副作用前验证请求目标 | evaluation/binding/currentness精确匹配 |
| observability | status/events为GUI核验面 | 输出identity/operator/decision与领域结果，不平行定义shape |

不再要求S6提供persistent operation identity、断连后query/replay、outbox/saga/log或跨介质known-outcome。若具体实现选择这些强化，不能把它们写成CAP-4验收前提。

### B7. 最小验证账本

1. `advance|hold|reopen`逐variant经过domain、typed operation、storage/consumer、status/event/audit。
2. wrong par/epoch/binding/operator、无capability、stale与重复decision得到typed reject/conflict，不产生非法领域写。
3. 有capability时GUI只显示合法动作并能提交；无capability时显示authority缺口。
4. 每个decision真实触发CAP实现定义的领域效果；accepted/rejected/failed明确，成功后status可读，相关event/audit可核验。
5. 旧无payload `decided`、late epoch和并发提交按所选工程形态得到明确结果。
6. 不用resume/unblock/改join冒充decision，不由GUI生成parallel identity或authority判断。

这些验证不要求通用durable operation、跨介质原子提交或全局exactly-once。

### B8. 决策分类

| 类别 | 结论 |
|---|---|
| 已定必须交付 | evaluation identity/binding、decision ADT、current-operator capability、typed F operation、领域consumer、status/event/audit对齐 |
| 操作员裁决 | 0 |
| owner gate | 0 |
| 工程形态 | decision storage、capability、epoch/currentness机制 |
| 删除的伪前提 | operator认证重构、全面store authority重构、durable operation/idempotency、query/replay、outbox/saga/log、known-outcome |
| 工程未知 | 三decision具体effects、迁移、epoch分配、capability期限/reason、audit粒度；不改变稳定交付面 |

### B9. 证据索引

- CAP-4、D8、D13、F decision：`AGG-544-gui-observability-gateway.md`
- evaluation/schema/identity/currentness事实：`detail-I15-544.md`
- mutation接缝风险：`detail-I13-544.md`、`detail-I14-544.md`
- R7分类：`detail-investigation-audit-544.md`
