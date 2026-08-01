# RFC #544 R10 — D1–D14 需求侧全量独立核算

> 核算输入仅为 `demand-D01-544.md`–`demand-D14-544.md`、`expected-foundation-544.md` 与 AGG D1–D14/CAP稳定条款。本报告未读取源码、旧 issue 或实验结果，也未修改任何需求报告。

## A. 主 agent 摘要（≤一页）

### 核算结论

- **逐份gate：14/14通过。** 每份报告都有可枚举原子需求、稳定条款或明确CAP来源、F/X映射、owner分类、地基供需判断和可证伪验证面；没有把当前实现、旧 issue、测试或风险本身当成需求来源。
- **D1–D14覆盖：14/14。** AGG每个交付物恰有一份同号需求报告；未发现稳定性质遗漏，也未发现两个报告争夺同一domain事实所有权。
- **原子需求总数：155。** 分项为D1 9、D2 9、D3 9、D4 10、D5 11、D6 11、D7 13、D8 11、D9 12、D10 12、D11 10、D12 11、D13 15、D14 12。
- **真正地基缺口总数：0。** 各报告中的U01–U15均被正确保留为运行证明、真实shape、fixture、规模或环境未知；没有把未知接口细节误写成R10 blocker。
- **F01–F30覆盖：30/30。** 每项至少有一个直接消费者或明确核验owner；无孤立地基保证。跨报告重复引用均是producer→consumer或综合证据关系，不是重复实现所有权。
- **C1–C5伪裁决没有复活。** 最终status wire、固定events可见结果、current name-based D11、CAP-2 pinned可达、CAP-3/CAP-6 typed seam均沿R9结论使用。
- **范围增长扫描通过。** 可选server caps/schema framework/replay/context write recovery/durable mutation/historical D11等只出现在明确排除或风险边界中，没有进入“必须交付”列。
- **R11 gate：通过。** 14份报告可以进入供需匹配与接缝识别；R11不得把本核算中的接缝再扩成新平台机制。

### 完成判据

本核算只证明需求侧材料完整、归属一致并受稳定设计约束；不证明F01–F30已经实现或通过运行时验证，也不授权提前重拆。

## B. 逐份gate矩阵

标记：✓=通过；“原子数”按各报告命名的R/A条目去重计数。

| 报告 | 原子数 | 稳定需求可追溯 | F/X映射 | Owner归属 | 地基缺口 | 无伪裁决/自生保证 | Gate |
|---|---:|---|---|---|---:|---|---|
| **D1 strict status read** | 9 | AGG D1：strict read、daemon-down中立、typed mismatch | F01–F05、X07 | D1拥有读取；D3/CAP-1供boundary/tree | 0 | 未增加FS/断电/cap；不建跨介质事务 | ✓ |
| **D2 attempt artifacts** | 9 | AGG D2：实发同源、fresh/resume/finalizer、失败diagnostic | F16–F21、X01/X03/X04 | D2拥有artifact；CAP-2/3提供pinned/typed seam | 0 | pair完整性只约束本attempt文件，不扩成runner/跨介质事务；D11仍current | ✓ |
| **D3 exact status boundary** | 9 | AGG D3：无匿名槽、类型单源、CAP-1集成、shape diff | F01–F05、F30、X01 | D3拥有最终CLI/HTTP boundary；CAP-1/4供字段 | 0 | 未复活domain-vs-wire裁决；artifact不塞status | ✓ |
| **D4 hooks/gate hold** | 10 | AGG D4/CAP-5：effective view、hold、hook events | F03–F05、F10–F15、X01/X03 | CAP-5拥有shape；D4拥有status/UI消费 | 0 | 不新增hook执行、retry、registry、第二日志/cap | ✓ |
| **D5 gateway host** | 11 | AGG D5/架构：单gateway、两数据面、明确listeners与静态资产 | F01–F09及相关接缝 | D5拥有host/listener/static/read routes | 0 | 不新增auth/public ingress/supervisor/server caps/replay | ✓ |
| **D6 events read/SSE** | 11 | AGG 4.3/D6：history/filter、active offset、normal rotation、SSE生命周期 | F10–F15、X03/X07 | events producer供writer/contract；D6拥有reader/SSE/visibility | 0 | replay/schema framework/crash journal/三流全序均排除 | ✓ |
| **D7 liveness/lifecycle UI** | 13 | AGG D7：三证、死态、断网区分、start/stop/restart、首屏 | F01–F15、F25–F27 | D7拥有观测/控制闭环；D1/D2/D6/D8供事实与动作 | 0 | 不建supervisor、原子三证、durable operation或replay | ✓ |
| **D8 F mutation** | 11 | AGG D8/F档：exact写面、daemon裁判、四verb、CAP-4入口 | F07–F10、F25–F30、X02/X03/X06 | D8拥有GUI façade；daemon/CAP-4拥有合法性/domain | 0 | 认证重构、全面封store、durable op/outbox/saga/log均排除 | ✓ |
| **D9 drilldown/tree** | 12 | AGG D9/CAP-1：层级、URL、tree union、event双向跳转、v2退化 | F03–F05、F11/F15/F18/F28–F30 | D9拥有导航；D3/CAP-1/D6供shape/filter | 0 | 无slot/parallel shape；artifact独立route；无全局event序 | ✓ |
| **D10 attempt display** | 12 | AGG D10：逐字prompt、typed bindings、missing状态 | F16–F21、X01/X04 | D10拥有展示；D2/CAP-3供artifact/typed seam | 0 | 不重建历史、不扩D11、不解析prompt控制语义 | ✓ |
| **D11 compile preview** | 10 | AGG D11/CAP-7：current name、单artifact、三视图/findings/schemaVersion | F20–F21、X04 | CAP-7拥有artifact；D11拥有current preview | 0 | historical-pinned/双视图/第二compiler/repository GC均排除 | ✓ |
| **D12 context read UI** | 11 | AGG D12/CAP-6：operator read、三scope、envelope、opaque body | F07–F09、F22–F24、X02/X05 | CAP-6拥有shape；D12拥有typed消费/UI | 0 | write recovery/idempotency/outbox/retention/auth六维合同均排除 | ✓ |
| **D13 mobile/PWA** | 15 | AGG D13：同应用、PWA、移动首屏、控制可用、PC不回归 | F01–F15、F25–F30 | D13拥有responsive/PWA/mesh体验；复用D5/D7/D8 | 0 | 不建mobile backend/client/auth/offline mutation/server caps | ✓ |
| **D14 docs/evidence** | 12 | AGG D14：运行手册、十行关闭验证、红线、owner回退 | F01–F30 | D14只拥有文档/综合证据；产品失败回D1–D13 | 0 | 不现场修产品、不接管#684/#685、不加新机制 | ✓ |

**Gate总计：14/14。**

## C. AGG D1–D14覆盖与边界

| AGG交付物 | 报告覆盖的稳定终态 | 未被其他报告重复取得的owner边界 |
|---|---|---|
| D1 | strict daemon-down status读取 | SQLite读取/typed DB result |
| D2 | attempt prompt/bindings实发同源artifact | artifact producer与失败diagnostic |
| D3 | 最终status exact boundary | 公共CLI/HTTP status wire |
| D4 | hooks current view与gate hold | hooks UI消费；CAP-5仍拥有domain shape |
| D5 | 单gateway/两数据面/显式监听 | gateway host与route ownership |
| D6 | events history/offset/SSE/visibility | events reader和SSE资源生命周期 |
| D7 | daemon活性首屏与恢复 | 三证/生命周期用户闭环 |
| D8 | F档GUI写面 | mutation façade；daemon仍为裁判 |
| D9 | 层级、树与event导航 | router与tree/object presentation |
| D10 | attempt输入展示 | artifact consumer，不取得producer所有权 |
| D11 | current compile preview | CAP-7 artifact consumer，不取得compiler所有权 |
| D12 | context entries只读展示 | CAP-6 consumer，不取得write协议所有权 |
| D13 | mobile/PWA同构收口 | responsive/PWA/mesh体验 |
| D14 | 文档、运行手册与证据总账 | frozen-SHA evidence；非产品修复 |

覆盖结果：**D1–D14=14/14，遗漏0，owner冲突0。**

## D. 原子需求总账

| 报告 | 原子数 | 累计 |
|---|---:|---:|
| D1 | 9 | 9 |
| D2 | 9 | 18 |
| D3 | 9 | 27 |
| D4 | 10 | 37 |
| D5 | 11 | 48 |
| D6 | 11 | 59 |
| D7 | 13 | 72 |
| D8 | 11 | 83 |
| D9 | 12 | 95 |
| D10 | 12 | 107 |
| D11 | 10 | 117 |
| D12 | 11 | 128 |
| D13 | 15 | 143 |
| D14 | 12 | **155** |

跨报告同时出现的identity、typed boundary、events或status词项未重复计为一个“共享实现需求”：各报告只计自身的producer、consumer或验证责任。R11应以接缝合并实现依赖，而不是删掉消费方验收。

## E. F01–F30全量消费核算

| F范围 | 主要直接消费者/核验者 | 是否有明确去向 |
|---|---|---|
| **F01–F02** strict read/error | D1、D5、D7、D14 | ✓ |
| **F03–F05** snapshot/boundary/wire | D1、D3、D4、D5、D7、D9、D13、D14 | ✓ |
| **F06–F10** liveness/transport/lifecycle | D5、D7、D8、D12、D13、D14 | ✓ |
| **F11–F15** events writer/reader/SSE/visibility | D4、D6、D7、D9、D13、D14 | ✓ |
| **F16–F18** attempt artifacts | D2、D9、D10、D14 | ✓ |
| **F19** pinned definition | D2、D10、D14 | ✓ |
| **F20–F21** current compile/additive typed seam | D2、D10、D11、D14 | ✓ |
| **F22–F24** context read | D12、D14 | ✓ |
| **F25–F27** F mutation/results | D7、D8、D13、D14 | ✓ |
| **F28–F30** CAP-4 decision chain | D3、D8、D9、D13、D14 | ✓ |

逐项文本扫描亦显示F01–F30每项至少出现在一份需求报告中；**覆盖30/30，孤立保证0。**

## F. 跨能力接缝与冲突核算

| 接缝 | Producer | Consumer | 收口规则 | 冲突 |
|---|---|---|---|---:|
| strict status → exact wire | D1/F01–F03 | D3/D5/D7/D9/D13 | 最终CLI/HTTP同一boundary，reader错误不吞 | 0 |
| CAP-1 tree → status/navigation | CAP-1/F03–F04 | D3/D9 | 原样集成与穷尽渲染，不复制shape/复活slot | 0 |
| events contract → UI/diagnostics | F11–F15 | D4/D6/D7/D9及F17/F27/F30 | domain拥有payload，D6拥有读取；无共同commit/全局序 | 0 |
| attempt artifact producer → display | D2/F16–F18 | D10/D9链接 | 独立typed route，不进status，不重建历史 | 0 |
| pinned definition → attempt artifact | CAP-2/F19 | D2/D10 | 生命周期内按identity解引用；不自行定TTL/GC | 0 |
| compile artifact → preview | CAP-7/F20–F21 | D11 | current name-based、单artifact；无historical视图 | 0 |
| context boundary → context UI | CAP-6/F22–F24 | D12 | 只消费成功持久化entries与真实pagination/filter | 0 |
| typed transport → reads/mutations | F07–F09 | D5/D7/D8/D12/D13 | transport error与domain error分离；不复制registry | 0 |
| F façade → CAP-4 | F25–F27 | F28–F30/D8/D13 | 复用operator/daemon裁判和最小结果；无durable op前提 | 0 |
| CAP-4 runtime → status/events/tree | F28–F30 | D3/D9/D13 | 同identity/operator/decision，非第二status/log | 0 |
| gateway runtime → docs/evidence | D5–D13 | D14 | frozen SHA核验，失败回owner，不由D14修产品 | 0 |

跨能力接缝：**11组；实质冲突0；循环owner 0。**

## G. 禁止范围复活审计

| 禁止项 | 报告中的实际处理 | Gate |
|---|---|---|
| response/server caps、server idle/handler deadline、connection cap | 仅列为明确排除或测试参数，不是共同前提 | ✓ |
| 通用events schema-version/migration framework | D6/D7/D14明确排除；只允许真实不兼容的最小处理 | ✓ |
| replay、`Last-Event-ID`、restart cursor | D5/D6/D7/D13/D14明确排除 | ✓ |
| crash journal、fsync/power-loss durability | D6明确排除 | ✓ |
| fallback六格membership、统一三流历史、跨流全序 | D6/D9明确排除 | ✓ |
| historical-pinned D11、current+pinned双视图 | D2/D10/D11明确排除 | ✓ |
| CAP-3/CAP-6 shape猜测 | D2/D10/D11/D12只保留owner-derived typed seam | ✓ |
| context partial restart/idempotency/outbox/retention/auth六维合同 | D12明确排除 | ✓ |
| operator认证重构、全面封store | D8/D13明确排除 | ✓ |
| durable mutation、operation query/replay、outbox/saga/log、known-outcome | D7/D8/D13/D14明确排除 | ✓ |
| artifact正文进入status | D2/D3/D9/D10明确使用独立route | ✓ |
| slot或parallel frontend shape | D3/D9/D12/D13/D14明确禁止 | ✓ |

范围复活失败项：**0。**

## H. 地基缺口与R11判定

| 项目 | 数量 | 判定 |
|---|---:|---|
| 需求报告 | 14 | 14/14通过 |
| 原子需求 | 155 | 全部有稳定来源或明确consumer接缝 |
| AGG交付物遗漏 | 0 | D1–D14全覆盖 |
| F保证遗漏 | 0 | F01–F30全覆盖 |
| owner冲突 | 0 | producer/consumer/验证责任分离 |
| 真正地基未闭合 | 0 | U01–U15均为运行/接口/fixture未知 |
| 伪裁决或自生保证 | 0 | 禁止清单未复活 |

**最终判定：R10 gate通过，可以进入R11供需匹配与接缝识别。** R11只可将155项需求映射为直接复用、修补后复用、消费方自建或已列接缝；不得据此新增机制、提高保证强度或提前重拆issue。
