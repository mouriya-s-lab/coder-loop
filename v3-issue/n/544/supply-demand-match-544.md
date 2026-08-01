# RFC #544 R11 — F01–F30 与 D1–D14 供需匹配及接缝收口

> 输入仅为 `expected-foundation-544.md`、`demand-D01-544.md`–`demand-D14-544.md`、`demand-audit-544.md` 与纠偏后的decision档案。本报告不读取源码、运行实验、选择工程形态、拆issue、排序实施或估算规模。

## A. 主 agent 摘要（≤一页）

### 匹配结论

R10的 **155/155项原子需求全部完成唯一主分类**：

| 分类 | 数量 | 判定规则 |
|---|---:|---|
| **直接复用** | **1** | 现存4.3 segment发现/排序导出契约已足以被同仓D6消费，不依赖额外F修补 |
| **修补后复用** | **34** | consumer依赖F01–F30或外部CAP producer达到R9预期保证后复用；consumer不得复制实现 |
| **过渡兼容** | **7** | 只处理稳定设计明确保留的legacy artifact、v2退化树、真实历史坏/partial或unsupported schemaVersion边界 |
| **消费能力自建** | **113** | 对应D交付物自己建立route、projection、UI、host、读取、导航、控制或证据责任 |
| **地基仍缺** | **0** | R10已经判定无真正缺口；本轮未发现反证 |

**总计：155。** 没有把“可保留资产”整体误报成直接复用；除D6-A1外，所有需要R9保证落地的共享能力都归“修补后复用”。

### 接缝与循环

识别 **16组跨D接缝**。每组都指定唯一producer/能力owner与consumer；consumer只做派生、展示或调用，不吞producer的一半实现。实质循环依赖 **0**。

两个表面环已拆开：

1. D3提供可扩展的单一status boundary；CAP-4/F30提供domain字段；D8/D9/D13只消费组合结果，不要求D3先发明CAP-4语义。
2. events producer提供ADT/segment/write保证；D6拥有reader/SSE；D4/D7/D9只消费query/visibility，不各建tailer或第二event shape。

### 阶段判定

供需覆盖、owner和接缝已经闭合，**可以进入R12滚动重拆**。R12只能按这里的分类与owner边界拆现场足够清楚的下一批；不得重新引入historical D11、replay/schema framework、context write recovery、durable mutation或其他R9排除机制。

## B. 155项全覆盖分类矩阵

### B1. 按D报告逐项分组

| D | 直接复用 | 修补后复用 | 过渡兼容 | 消费能力自建 | 地基仍缺 | 小计 |
|---|---|---|---|---|---|---:|
| **D1** | — | R06–R09 | — | R01–R05 | — | 9 |
| **D2** | — | — | R06、R08 | R01–R05、R07、R09 | — | 9 |
| **D3** | — | A04–A06 | — | A01–A03、A07–A09 | — | 9 |
| **D4** | — | R01–R03、R09–R10 | — | R04–R08 | — | 10 |
| **D5** | — | — | — | R01–R11 | — | 11 |
| **D6** | A01 | A04–A05 | A02 | A03、A06–A11 | — | 11 |
| **D7** | — | R01–R05 | — | R06–R13 | — | 13 |
| **D8** | — | — | — | R01–R11 | — | 11 |
| **D9** | — | A05、A10 | A08 | A01–A04、A06–A07、A09、A11–A12 | — | 12 |
| **D10** | — | R01–R06 | R08、R12 | R07、R09–R11 | — | 12 |
| **D11** | — | — | R09 | R01–R08、R10 | — | 10 |
| **D12** | — | A02、A10 | — | A01、A03–A09、A11 | — | 11 |
| **D13** | — | R01–R05 | — | R06–R15 | — | 15 |
| **D14** | — | — | — | R01–R12 | — | 12 |
| **总计** | **1** | **34** | **7** | **113** | **0** | **155** |

> ID均继承各自报告前缀，例如D1的R06表示`D01-R06`，D6的A01表示`D6-A1`。范围表达式为闭区间。

### B2. 主分类解释

#### 直接复用（1）

| 需求ID | 现存足够资产 | 为什么不需R9修补 | Owner / consumer |
|---|---|---|---|
| **D6-A1** | 4.3已导出的segment发现、名称parse与确定排序规则 | 该原子项只要求调用既有同仓导出规则；writer、历史韧性和continuity分别由其他原子项承担 | events contract owner / D6 reader |

“current event ADT”“TaskTree boundary”“store/index”“Bun spike”等其余可保留资产都只覆盖更大原子需求的一部分，未计为直接复用。

#### 修补后复用（34）

| 需求组 | 依赖的F/CAP保证 | Producer owner | Consumer只做什么 |
|---|---|---|---|
| D1-R06–R09 | F03–F05 | status foundation / D3 boundary | D1调用同一read snapshot与boundary，不另建 |
| D3-A04–A06 | F03/F04、CAP-1、F30 | taskTree/CAP-4/status producers | 组合进同一boundary |
| D4-R01–R03 | CAP-5 typed seam | CAP-5 owner | 集成hook current/event shape |
| D4-R09–R10 | F04/F05、F11–F15 | D3、events/D6 | 复用status与events消费面 |
| D6-A04–A05 | F12 | events writer owner | reader依赖normal writer/rotation结果 |
| D7-R01–R05 | F01–F09、F11–F15 | D1/D3、transport、events | 首屏消费三证、持久终态和历史 |
| D9-A05/A10 | F04/F05、F11 | D3、D6 | 用派生status types与typed event filter |
| D10-R01–R06 | F16/F17/F19/F21 | D2、CAP-2/3 | 展示真实artifact与typed seam |
| D12-A02/A10 | CAP-6/F22–F24 | CAP-6 owner | parse真实boundary并跟随pagination/filter |
| D13-R01–R05 | F01–F15、F25–F30 | D5/D7/D8/CAP-4等 | 移动端复用同一数据、控制与信任模型 |

修补后复用不是实施顺序：它只说明consumer不能在producer保证未成立时以本地fallback代替。

#### 过渡兼容（7）

| 需求ID | 兼容对象 | 最窄边界 | 禁止扩张 |
|---|---|---|---|
| **D2-R06** | artifact partial/write-failed | 失败不挡attempt，遗留partial不能冒充present | 通用recovery/跨介质事务 |
| **D2-R08** | legacy-missing与write-failed/incomplete | 独立typed route穷尽真实状态 | 重建历史artifact |
| **D6-A02** | 真实历史bad/partial或已证不兼容shape | 精确parse并只对实证情况做最小处理 | schema-version/migration framework |
| **D9-A08** | v2退化树 | 走同一CAP-1 union renderer | slot/`LegacyTree`平行shape |
| **D10-R08** | present/legacy-missing/write-failed | typed consumer ADT | nullable/catch-all |
| **D10-R12** | legacy-missing/write-failed UI | 如实文案与diagnostic关联 | 猜测/补造输入 |
| **D11-R09** | unsupported CAP-7 schemaVersion | typed consumer rejection并显示实际版本 | silent downgrade、多代compiler |

#### 消费能力自建（113）

消费能力自建由对应D owner完成，分为以下责任族；不指定具体工程形态：

| 责任族 | 需求ID范围 | 原子数 | 唯一owner |
|---|---|---:|---|
| strict status读取本体 | D1-R01–R05 | 5 | D1 |
| attempt artifact producer | D2-R01–R05、R07、R09 | 7 | D2 |
| exact status boundary | D3-A01–A03、A07–A09 | 6 | D3 |
| hooks status/UI关联 | D4-R04–R08 | 5 | D4 |
| gateway host/two data planes | D5-R01–R11 | 11 | D5 |
| events filter/continuity/SSE/visibility | D6-A03、A06–A11 | 7 | D6 |
| liveness/lifecycle UI闭环 | D7-R06–R13 | 8 | D7 |
| F mutation façade与CAP-4 UI | D8-R01–R11 | 11 | D8 |
| drilldown/tree/event navigation | D9-A01–A04、A06–A07、A09、A11–A12 | 9 | D9 |
| attempt artifact route/display | D10-R07、R09–R11 | 4 | D10 |
| current compile preview | D11-R01–R08、R10 | 9 | D11 |
| context typed消费/UI | D12-A01、A03–A09、A11 | 9 | D12 |
| mobile/PWA/mesh收口 | D13-R06–R15 | 10 | D13 |
| docs/runbook/frozen-SHA evidence | D14-R01–R12 | 12 | D14 |
| **合计** | — | **113** | — |

#### 地基仍缺（0）

未发现任何需求必须依赖F01–F30、CAP-1–CAP-7或稳定AGG之外的新保证。U01–U15仍是运行、fixture、规模或外部shape未知。若R12发现必须新增地基机制，应退回R9/R10并指出与本表的具体矛盾，不能直接在issue中补造。

## C. D需求 → F/owner → 分类全覆盖矩阵

| D | 主要F/CAP供给 | 本D owner产物 | 分类组成 |
|---|---|---|---|
| D1 | F01–F05 | strict reader与typed DB result | 修补后4 + 自建5 |
| D2 | F16–F21、CAP-2/3、X03/X04 | attempt artifact producer/boundary | 兼容2 + 自建7 |
| D3 | F03–F05、CAP-1、F30/X01 | final status boundary | 修补后3 + 自建6 |
| D4 | CAP-5、F03–F05、F11–F15 | hooks/gate UI projection | 修补后5 + 自建5 |
| D5 | F01–F09 | gateway host、routes、listeners | 自建11 |
| D6 | F11–F15 | history/filter/offset/SSE/visibility | 直接1 + 修补后2 + 兼容1 + 自建7 |
| D7 | F01–F15 | liveness/lifecycle UI | 修补后5 + 自建8 |
| D8 | F07–F10、F25–F30 | exact F mutation façade | 自建11 |
| D9 | F03–F05、F11/F15/F18/F28–F30、CAP-1 | drilldown/tree/event navigation | 修补后2 + 兼容1 + 自建9 |
| D10 | F16–F21 | attempt artifact display | 修补后6 + 兼容2 + 自建4 |
| D11 | F20–F21、CAP-7 | current compile preview | 兼容1 + 自建9 |
| D12 | F07–F09、F22–F24、CAP-6 | context read consumer/UI | 修补后2 + 自建9 |
| D13 | F01–F15、F25–F30 | mobile/PWA/mesh | 修补后5 + 自建10 |
| D14 | F01–F30 | docs/runbook/evidence | 自建12 |

行合计与B1完全一致，**155/155覆盖，无重复主分类，无未分类项。**

## D. 跨D接缝与唯一owner

| 接缝ID | 唯一能力owner / producer | Consumers | 接缝合同 | 防止双方各吞半个 |
|---|---|---|---|---|
| **J01 strict status read** | D1 / F01–F03 | D3、D5、D7、D9、D13、D14 | daemon-down strict read、typed DB result、单read snapshot | consumer不得直开SQLite或重建持久事实 |
| **J02 final status boundary** | D3 / F04–F05 | D1、D4、D5、D7、D9、D13、D14 | 最终CLI/HTTP同一engine boundary与派生类型 | 各consumer不得建parallel DTO/parser |
| **J03 taskTree shape** | CAP-1 | D3、D9 | leaf/seq/par、join/reopen/closure exact union | D3只集成，D9只渲染；无人复制shape/复活slot |
| **J04 events producer/contract** | events owner / F11–F13 | D6、D4、D7、D9、D14 | ADT、segments、normal writer/rotation | D6不重写producer，其他GUI不建第二reader |
| **J05 events reader/visibility** | D6 / F13–F15 | D4、D7、D9、D13 | filter、offset continuity、SSE、固定可见结果 | consumers调用D6面，不各自tail/merge三流 |
| **J06 attempt artifacts** | D2 / F16–F18 | D10、D9链接、D14 | attempt identity、同源pair、typed missing/failure | D10展示、D9导航；artifact不进status |
| **J07 pinned definition** | CAP-2 / F19 | D2、D10 | attempt生命周期内按完整identity解引用 | D2不把artifact当repository；consumers不定TTL/GC |
| **J08 typed binding seam** | CAP-3 / F21 | D2、D10、D11 | scalar基线上的non-breaking additive typed seam | consumers不猜字段、variant或复合值shape |
| **J09 compile artifact** | CAP-7 / F20 | D11、D14 | current name-based单artifact/schemaVersion/findings | D11不编译、不读historical attempt |
| **J10 typed transport** | transport owner / F07–F09 | D5、D7、D8、D12、D13 | command args/result/error、deadline/cancel/id/framing | domain consumers不复制registry或压平错误 |
| **J11 context boundary** | CAP-6 / F22–F24 | D12、D14 | operator read、三scope、envelope/body、实际pagination/filter | D12不直读store或定义write recovery |
| **J12 F mutation façade** | D8 / F25–F27 | D7、D13、D14及CAP-4 submit接入 | exact F surface、operator调用、daemon裁判、最小结果语义 | CAP-4只提供domain operation；其他UI不建第二mutation client |
| **J13 CAP-4 decision domain** | CAP-4 / F28–F30 | D8、D3、D9、D13、D14 | evaluation identity、capability、decision、consumer及status/event/audit字段 | D8只接入façade，D3只承载shape，UI不自授权 |
| **J14 gateway host** | D5 | D6、D7、D8、D9、D10、D11、D12、D13、D14 | 同一gateway PID、routes、静态资产、显式listeners与runtime context | runtime consumers不各起server或改变root/listener边界 |
| **J15 mobile/PWA** | D13 | D14 | 同一应用的responsive/PWA/mesh消费与真机证据 | 不建立mobile backend/client或改变D5 host合同 |
| **J16 frozen-SHA evidence** | D14 | R12关闭核算 | 十行、runbook、红线与owner回退的综合证据 | D14不拥有D1–D13产品修复，也不接管#684/#685 |

接缝总数：**16**。

## E. 循环依赖检查

| 表面环 | 拆解 | 结果 |
|---|---|---|
| D1读取 ↔ D3 boundary | D1拥有读取，D3拥有公共shape；D1返回值在D3 boundary处闭合，不要求D3反向拥有SQLite | 单向组合，无环 |
| D3 status ↔ CAP-4/F30 | D3先提供可扩展exact槽机制；CAP-4提供domain字段；D8/D9/D13消费组合 | 无语义反向依赖 |
| events producer ↔ D6 reader | producer只保证ADT/segment/normal publication；D6只读/filter/SSE | 单向，无共同commit环 |
| D6 events ↔ D4/D7/D9 | consumers只调用reader/visibility；payload语义归各domain producer | 单向，无第二tailer |
| D2 artifacts ↔ D10 display | D2独立producer/boundary；D10只读展示 | 单向 |
| D8 mutation ↔ status/events核验 | D8动作结果由D1/D3/D6观察，但status/events不依赖D8才能存在 | 观测接缝，不是实现环 |
| D5 host → D13 mobile | D5独立拥有host/listener/runtime，D13只消费并拥有mobile/PWA | 单向，无双owner |
| D5/D13 → D14 evidence | D14只核验冻结SHA证据，产品失败分别回D5或D13 | 单向，无owner回写 |

- 实质循环依赖：**0**
- 双owner接缝：**0**
- “双方各吞半个”未归属项：**0**

## F. R12准入结论

| 核算项 | 数量 | Gate |
|---|---:|---|
| 原子需求覆盖 | 155/155 | ✓ |
| 直接复用 | 1 | ✓，仅D6-A1 |
| 修补后复用 | 34 | ✓，均有F/CAP owner |
| 过渡兼容 | 7 | ✓，均有窄边界 |
| 消费能力自建 | 113 | ✓，均有唯一D owner |
| 地基仍缺 | 0 | ✓ |
| 跨D接缝 | 16 | ✓，全部指定唯一producer/consumer |
| 实质循环 | 0 | ✓ |

**最终判定：可以进入R12滚动重拆。** 本报告不决定具体工程形态、issue边界、实施顺序或规模；R12必须以当前main与已明确修补的F保证为验收前提，只滚动拆现场足够清楚的下一批。
