# RFC #547 R5：六片现存供给核算总账

> 固定输入：`04-r3-supply-slicing.md` 与 `05-r4-compile-artifact.md`—`10-r4-engine-primitives.md`。  
> 本账只规范化、合并和反向映射 R4 报告原条目；不查源码、不运行实验、不改变原结论、不生成 R6 决策索引。

## A. 主 agent 摘要（最多一页）

### A1. 覆盖与 gate

本账按统一原子规则从六份正式报告抽取 **250 个可核算原条目**：

| 报告 | 判定/因果 | 资产 | 未知 | 接缝 | 测试同错/盲区 | 合计 |
|---|---:|---:|---:|---:|---:|---:|
| S1 / `05` | 18 | 8 | 2 | 5 | 7 | 40 |
| S2 / `06` | 20 | 5 | 2 | 6 | 16 | 49 |
| S3 / `07` | 19 | 7 | 3 | 4 | 9 | 42 |
| S4 / `08` | 16 | 5 | 2 | 6 | 17 | 46 |
| S5 / `09` | 13 | 6 | 3 | 5 | 10 | 37 |
| S6 / `10` | 12 | 7 | 2 | 4 | 11 | 36 |
| **总计** | **98** | **38** | **14** | **30** | **70** | **250** |

250 个原条目规范化为 **55 个总账 ID**：资产 12、偏离/无供给 24、静态未知/运行证明缺口 5、测试同错/盲区 7、接缝 7。附录 B6 给出全部原条目→总账 ID 映射；**未映射数为 0**。

**R5 gate：满足。** 六片所有正式判定、因果、可保留资产、未知、接缝和测试盲区均已入账；没有把绿色测试升级为符合，没有把未知改写成需求，也没有生成方案/规模。

### A2. 总账大类

1. **可保留骨架真实存在**：canonical compiler/result/projection、source hash、doc声明渲染、runtime tree/identity/SQLite约束、hook carrier、tagged definition ref、opaque item/wire主体、事务/migration、baseBranch与closure资源机制。
2. **主链未闭合**：
   - schema/finding不是不可拆错公共同源；
   - source schema→binding→admission→render没有精确类型链；
   - compiled tree→runtime tree→scheduler→transition commit没有生产链；
   - tool/gate registry→projection→doctor/prompt→runtime enforcement没有生产链；
   - definition ref没有内容，创建不pin，resume/restart重读当前源；
   - GitHub/repository/default-preset原语仍闭合。
3. **恢复/缓存放大**：daemon path cache、校验前materialize、跨事务run close、当前源重载、legacy fallback及repository双权威会让局部资产在重启/恢复/多入口下产生不同事实。
4. **证明缺口不是实现符合**：fixture-only tree/join、synthetic ref、empty tool projection、generic JSON安全、旧CLI兼容与migration绿色均只证明各自旧契约。

### A3. 互证、冲突与尚未核实

- **互证**：S1/S2共同证明projection结构稳定但类型失真；S1/S4共同证明tools空shape不是registry；S1/S3/S5共同证明真实hash/identity存在但定义内容与运行行为未被pin；S2/S6共同证明generic JSON入口不是source-schema admission；S3/S5共同证明node ref连续仅是归因；S3/S4共同证明host identity与gate引用未接；S5/S6共同证明fallback/restart重读放大定义漂移。
- **互补**：S3负责“运行节点只持ref及fixture/production边界”，S5负责“ref背后没有内容/resolver”；S6负责入口默认/fallback，S1负责loader cache/materialize。
- **表面冲突**：S1称daemon成功cache冻结旧model，S5称restart/resume重读当前源；边界不同——同进程冻结、重启后漂移，不冲突。S3称runtime tree/status identity连续，S5称执行不同源；前者是归因连续，后者是行为解析源，不冲突。
- **真实冲突**：六报告之间未发现结论互相否定的真实冲突。
- **尚未核实**：外部 schema/bindings producer、hook/GUI/C6消费者、外部 typed chain boundary、D10完整artifact owner、冻结 SHA跨系统E2E，均保持未知/未来证明缺口，不能在R5闭合。

---

## B. 证据附录

## B1. 规范化总账

### B1.1 可保留资产（A）

| ID | 规范化资产 | 来源边界 |
|---|---|---|
| A-01 | TOML→canonical compiler主干、封闭 compiled/rejected result、non-empty diagnostics | S1 |
| A-02 | 唯一仓内projection函数、schemaVersion boundary、JSON round-trip与root/phase/task identity | S1 |
| A-03 | 真实全source SHA-256及direct/materialized语义等价资产 | S1、S5 |
| A-04 | plan目录/注册/命令已退役且没有fragment jump DSL | S1 |
| A-05 | binding source tagged union、known-root/runtime ownership及doc product/归一化 | S2 |
| A-06 | doc renderer生产实现声明驱动，prefix迁移真实；外部入口先unknown再parse | S2 |
| A-07 | generic JSON安全、batch/create事务、remainder/migration保真 | S2、S6 |
| A-08 | runtime leaf/seq/par与join封闭ADT、strict boundary、SQLite FK/unique/check/trigger、递归round-trip | S3 |
| A-09 | production run→closure→runtime node→tagged definition ref/node identity链；status/recovery连续 | S3、S5 |
| A-10 | closure branch/worktree、reachability、consumption intent、reconcile/回收/采样及局部run-start事务 | S3、S6 |
| A-11 | hook observer/gate declaration carrier、分层持久化/effective view、写入授权和malformed拒绝 | S4 |
| A-12 | opaque item存储/wire主体、per-item preset互斥、WAL/busy/IMMEDIATE/migration框架、baseBranch真实消费 | S6 |

### B1.2 部分/不符合与无供给（D）

| ID | 分类 | 规范化事实、原因与触发条件 | 来源 |
|---|---|---|---|
| D-01 | 部分符合 | canonical model存在，但warnings与model并列，daemon callback另投影；调用者可拆错finding集合 | S1 |
| D-02 | 不符合 | daemon以path-only成功promise缓存；同进程源变化时CLI/direct读新、scheduler读旧；失败cache却重试 | S1 |
| D-03 | 不符合 | materialize先写marker/rename/prune再parse；非法源可留完成artifact并删旧副本 | S1 |
| D-04 | 无供给 | 可分发JSON Schema/独立类型派生通道不存在；源码内arktype boundary不等于artifact | S1 |
| D-05 | 无供给/待裁决 | doctor未吸收compile findings；关系本身仍待裁决 | S1 |
| D-06 | 无供给 | dead-fragment checker不存在；plan退役只有半边，bundled无warn可真空成立 | S1 |
| D-07 | 不符合 | source schema不权威：item四词type无人消费、chain开放remainder、runtime string-only | S2 |
| D-08 | 不符合 | missing item/chain `null|undefined`静默变`""`；结构值到render才throw | S2 |
| D-09 | 不符合 | chain/item create/update不按preset required/type/default执法，验证阶段错位 | S2、S6 |
| D-10 | 不符合 | public variable projection固定string并丢source path/doc/default/required/owner | S2 |
| D-11 | 无供给 | recursive ValueType、exit.* source/owner/typed payload/pending均不存在 | S2 |
| D-12 | 部分符合 | doc parse/render精确，但variables outer boundary宽、手写binding、bundled测试按ISSUE选取 | S2 |
| D-13 | 无供给 | compiled递归seq/par树、稳定显式node id、非退化projection与装载结构检查不存在 | S3 |
| D-14 | 部分符合 | runtime seq/par/join/pin/epoch SQL完整但生产无constructor/scheduler消费，主要fixture可写 | S3 |
| D-15 | 不符合 | scheduler按preset.phases数组、item.phase/status与runs推进；runtime cursor不参与且正常完成不更新 | S3 |
| D-16 | 无供给 | typed TransitionPath/exit schema/唯一transition commit不存在；run close跨多事务/异步事件 | S3 |
| D-17 | 部分符合 | §2.5 fresh base/branch/回收采样真实；seq语义旧、par pin无生产供给 | S3、S6 |
| D-18 | 无供给 | tool registry四轴、phase requirements、真实projection/prompt doc/runtime finalize不存在 | S4 |
| D-19 | 不符合 | doctor硬编码gh，§2 H工具名原语仍在 | S4 |
| D-20 | 无供给 | typed preset gates、host identity、point全集、projection、unsupported握手与脚本执行不存在 | S4 |
| D-21 | 部分/不符合 | tagged ref/FK真实，但definition表无内容，chain/item创建不pin，root取首item preset | S3、S5 |
| D-22 | 不符合 | spawn/resume/restart按当前路径重载；ref不参与resolver；同daemon偶然cache、重启漂移 | S1、S5 |
| D-23 | 不符合 | D7/D9未退役：repository物理权威、forge admission、`--issue`/GitHub解析、双默认preset闭环 | S6 |
| D-24 | 部分/无供给 | item-first preset真实但legacy null回退chain/default；单一外部typed chain boundary不存在 | S6 |

### B1.3 未知与运行证明缺口（U）

| ID | 类型 | 保持未知的事实与确定方法 | 来源 |
|---|---|---|---|
| U-01 | 静态未知 | 外部schema、typed bindings.json、GUI/hook消费者是否存在；需对应外树producer/consumer路径 | S1、S2 |
| U-02 | 静态未知 | external C6 tool/gate enforcement、hook脚本执行、host capability；需同声明identity的真实消费证据 | S4 |
| U-03 | 静态未知 | execution definition artifact owner、内容resolver、缺失hold、resume pin；需S5/外树完整生产链 | S3、S5 |
| U-04 | 静态未知 | 外部typed chain declaration boundary与future repository/closure identity；需实际owner/schema/path | S6 |
| U-05 | 运行证明缺口 | 冻结SHA H1/H2、全consumer identity/ref、schema independent consumer、non-degenerate tree、tool/gate、repository/presetless E2E均未运行 | 全片 |

### B1.4 测试同错与盲区（T）

| ID | 规范化同错/盲区 | 来源 |
|---|---|---|
| T-01 | projection/boundary绿测只守shape、sourceKind、固定string、空tools或手传findings，不证明真实声明/同源/schema | S1、S2、S4 |
| T-02 | 缺少dead-fragment、cache edit、materialize rollback、doctor finding测试；bundled脏warnings/只断言无error会掩盖缺rule | S1 |
| T-03 | number/boolean→string、default `""`、missing不throw、ISSUE selector、generic JSON tests主动固化旧binding语义 | S2 |
| T-04 | nested tree/join/pin/createTaskTree与synthetic refs主要fixture-only；单leaf identity test不证明production tree/transition | S3、S5 |
| T-05 | run-start atomic、resume argv、phase restart、migration/current-source测试不证明run-complete atomic、H1 pin、hold或exactly-once recovery | S3、S5 |
| T-06 | hook tests明确never execute、手传placeholder、status隐藏hooks、doctor固定gh；只证明carrier不是gate/tool | S4 |
| T-07 | `--issue`、GitHub normalize、repository fixture、current schema列、store preset:null测试固化/绕过D7/D9 operator入口 | S6 |

### B1.5 接缝（J）

| ID | 接缝核算 | 双方是否对上 |
|---|---|---|
| J-01 | S1↔S2：同一projector/boundary存在；S2证明变量固定string及声明细节丢失 | **对上，互证** |
| J-02 | S1↔S3/S5：S1提供真实hash/compiled ids；S3仅把leaf id写ref；S5证明无内容/resolver | **对上，互补** |
| J-03 | S1↔S4：S1记录tools/requirements常量空；S4证明canonical无registry/gate来源 | **对上，互证** |
| J-04 | S2↔S6：S2发现create admission仅generic JSON；S6确认wire/remainder/migration入口与双binding读面 | **对上，互证** |
| J-05 | S3↔S4/S5：S3交付runtime host identity/ref；S4无gate引用，S5无behavior resolver | **对上，互补** |
| J-06 | S3↔S6：baseBranch/closure输入真实；item/chain create不实例化tree，repository不因closure存在而获准保留 | **对上，边界明确** |
| J-07 | S5↔S6：legacy null item→chain/default fallback，restart重读当前源；共同放大隐式definition rebind | **对上，互证** |

## B2. 接缝矩阵与冲突账

| 接缝 | 报告A | 报告B | 关系 | 保留边界 |
|---|---|---|---|---|
| S1–S2 | projection唯一且round-trip | type固定string、细节丢失 | 互补 | “唯一”不等于“真实完整” |
| S1–S3 | compiled identity/hash真实 | runtime只复制被运行leaf，tree不实例化 | 互补 | identity关联不等于结构消费 |
| S1–S5 | 同进程cache冻结 | restart重载当前路径 | 表面冲突已解 | 时间边界：进程内旧、重启后新 |
| S1–S4 | tools空shape存在 | registry/canonical来源不存在 | 互证 | shape不可升级为供给 |
| S2–S6 | generic JSON入口/存储 | 无preset-driven admission | 互证 | JSON安全不可升级为source typing |
| S3–S4 | runtime identity存在 | gate host identity缺失 | 互补 | S4不能借S3自动补引用 |
| S3–S5 | ref/identity连续 | 行为仍读当前源 | 表面冲突已解 | 归因连续≠执行同源 |
| S3–S6 | baseBranch是closure输入 | repository仍是一等权威 | 边界核对 | 前者允许不授权后者 |
| S5–S6 | fallback/restart路径 | null/default/recovery闭环 | 互证 | definition漂移放大条件 |

**真实冲突：0。**  
**需R7/后续外树调查：** U-01—U-04；它们没有被“无仓内供给”擅自改写为“全系统不存在”。

## B3. 完整资产账

| 资产族 | 明细 | 总账 |
|---|---|---|
| compiler | result ADT、diagnostics、projection、identity、hash、boundary | A-01—A-03 |
| D8 | plan实体退役、无jump DSL | A-04 |
| binding/doc | source union、doc product、renderer、prefix、unknown入口卫生 | A-05—A-06 |
| generic persistence | JSON安全、batch事务、remainder/migration保真 | A-07 |
| runtime tree | ADT、SQL约束、recursive IO、run identity/status/recovery | A-08—A-09 |
| closure | branch/worktree、reachability、intent、sampling、cleanup | A-10 |
| hook | declaration carrier、层级存储、effective view、authorization | A-11 |
| engine primitives | opaque item主体、per-item preset、transaction/migration、baseBranch | A-12 |

终态不符合没有删除以上任一资产；相反，D-01—D-24明确限定了每项资产不能证明什么。

## B4. 测试与未知账

### B4.1 共同同错模式

1. **shape代语义**：projection round-trip、空数组、FK row存在。
2. **fixture代production**：`createTaskTree`、synthetic refs、手传hook placeholder、store-level preset:null。
3. **局部事务代业务事务**：run-start原子被误推广到transition/run-close。
4. **兼容性代退役**：`--issue`、GitHub normalize、default seed、repository列绿测。
5. **当前源可读代immutable pin**：resume/restart/migration只证明此刻能加载。

### B4.2 未知保持

- “仓内无producer/consumer”仅记无现存供给；对外树一律归U-01—U-04。
- “测试未跑”归U-05，不据此判实现不存在。
- P-D1-2 doctor/findings关系保持待裁决，不并入补齐需求。

## B5. 覆盖算法

### B5.1 原子定义

只计正式报告中以下可审计单位：

1. A/B判定表每行；
2. 显式编号的因果项；
3. “可保留资产”每个bullet/表行；
4. “未知”每个独立bullet或明确分号项；
5. 接缝表每行；
6. 测试同错、正向范围、盲区每个bullet。

正文重复证据、命令、path:line、实验文件登记、证据索引不另计原子；它们随所属原条目保留在源报告。相同事实跨报告不去掉源原子，只在ledger层many-to-one。

### B5.2 分类规则

- 原判定不变；“部分符合”不得拆掉其资产半边或缺口半边，分别映射A与D。
- “无仓内供给但外树未知”同时映射D与U。
- 正向测试只映射对应A，范围限制映射T。
- 接缝双方均须出现；单方描述不得标“互证”。

## B6. 原条目→总账 ID 全覆盖附录

为保持可审计性，原条目ID格式为 `S片-类别-序号`；序号按原报告出现顺序。括号内为源章节。

### B6.1 S1 / `05`（40/40）

- `S1-C01..C12`（A1判定12行）→ `D-01,D-02,D-04,D-05,D-06,A-01,A-02,A-04`
- `S1-F01..F06`（A2因果6项）→ `D-01,D-04,D-02,D-03,D-06,T-02`
- `S1-A01..A08`（A3/B5.2资产8项）→ `A-01,A-02,A-03,A-04,A-05,A-07,A-09,A-10`
- `S1-U01..U02`（A3未知2项）→ `U-01,U-05`
- `S1-J01..J05`（A3接缝5项）→ `J-01,J-02,J-03,J-06,U-05`
- `S1-T01..T07`（B5.3盲区7项）→ `T-01,T-02`

### B6.2 S2 / `06`（49/49）

- `S2-C01..C14`（B1判定14行）→ `D-07,D-08,D-09,D-10,D-11,A-05,A-06,D-12`
- `S2-F01..F06`（A3因果6项）→ `D-07,D-08,D-09,D-10,D-12`
- `S2-A01..A05`（A5资产5项）→ `A-05,A-06,A-07`
- `S2-U01..U02`（A6未知2项）→ `U-01,U-05`
- `S2-J01..J06`（B8接缝6行）→ `J-01,J-02,J-03,J-04,U-01,U-05`
- `S2-T01..T05`（B7.1同错5项）→ `T-01,T-03`
- `S2-P01..P03`（B7.2正向范围3项）→ `A-06,A-07,T-03`
- `S2-M01..M08`（B7.3缺失8项）→ `T-03,U-05,D-11`

### B6.3 S3 / `07`（42/42）

- `S3-C01..C13`（A1判定13行）→ `D-13,D-14,D-15,D-16,D-17,D-21,A-08,A-09,A-10`
- `S3-F01..F06`（A2因果6项）→ `D-13,D-15,D-16,D-14,D-17`
- `S3-A01..A07`（A3资产7项）→ `A-08,A-09,A-10`
- `S3-U01..U03`（A3未知3项）→ `U-02,U-03,U-05`
- `S3-J01..J04`（B8接缝4项）→ `J-02,J-05,J-06`
- `S3-T01..T09`（B7.3盲区9项）→ `T-04,T-05,U-05`

### B6.4 S4 / `08`（46/46）

- `S4-C01..C10`（B1/B2判定10行）→ `D-18,D-19,D-20`
- `S4-F01..F06`（A3因果6项）→ `D-18,D-19,D-20,A-11`
- `S4-A01..A05`（A5/B4资产5项）→ `A-11`
- `S4-U01..U02`（A6未知2项）→ `U-02,U-05`
- `S4-J01..J06`（B9接缝6行）→ `J-03,J-04,J-05,U-02,U-05`
- `S4-T01..T05`（B8.1同错5项）→ `T-01,T-06`
- `S4-P01..P03`（B8.2正向资产3项）→ `A-11,T-06`
- `S4-M01..M09`（B8.3缺失9项）→ `T-06,U-02,U-05`

### B6.5 S5 / `09`（37/37）

- `S5-C01..C07`（A1判定7行）→ `D-21,D-22,D-14,U-05`
- `S5-F01..F06`（B3因果6项）→ `D-21,D-22,A-09,T-05`
- `S5-A01..A06`（B8资产6行）→ `A-03,A-08,A-09`
- `S5-U01..U03`（A2未知/边界3项）→ `U-03,U-05`
- `S5-J01..J05`（B9接缝5行）→ `J-02,J-05,J-07,U-05`
- `S5-T01..T05`（B8同错5项）→ `T-04,T-05`
- `S5-M01..M05`（B8盲区5项）→ `T-05,U-03,U-05`

### B6.6 S6 / `10`（36/36）

- `S6-C01..C09`（A1判定9行）→ `D-23,D-24,D-17,A-12,U-05`
- `S6-F01..F03`（A2三条生产链）→ `D-23,D-24`
- `S6-A01..A07`（A2资产7项）→ `A-07,A-10,A-12`
- `S6-U01..U02`（A2未知2项）→ `U-04,U-05`
- `S6-J01..J04`（A3接缝4项）→ `J-04,J-06,J-07,U-05`
- `S6-T01..T05`（B5同错5项）→ `T-07`
- `S6-M01..M06`（B5盲区6项）→ `T-07,U-04,U-05`

### B6.7 覆盖校验

```text
S1 40 + S2 49 + S3 42 + S4 46 + S5 37 + S6 36 = 250
mapped = 250
unmapped = 0
duplicate source IDs = 0
ledger IDs = 55 (A12 + D24 + U5 + T7 + J7)
```

未映射列表：**空**。

## B7. R3 六片与D11 owner核对

| R3片 | R5入账 | owner空洞 |
|---|---|---|
| S1 compile/artifact/finding | A-01—04；D-01—06 | 无 |
| S2 binding/doc | A-05—07；D-07—12 | 无 |
| S3 runtime tree/identity | A-08—10；D-13—17、21 | 无 |
| S4 capability/gate | A-11；D-18—20 | 无 |
| S5 definition pin | A-03/09；D-21—22 | 无 |
| S6 primitives | A-07/10/12；D-23—24 | 无 |
| D11冻结SHA | U-05、T-01—07 | 无；仍是未来证明，不在R5执行 |

## B8. 尾部结论

六份R4报告的 **250/250 个可核算原条目已映射，未映射为0**。总账保留了全部38个源资产条目，并把它们规范化为12个资产族；同时把98个判定/因果、14个未知、30个接缝和70个测试条目收敛为可反查的D/U/J/T账。报告间没有真实结论冲突：cache与restart、identity连续与行为漂移均是边界不同的表面冲突；主要接缝全部互证或互补。尚未核实的外部schema/bindings、C6、GUI/hook、definition artifact与typed chain boundary继续保持未知。R5只证明账目完整，不把任何缺口转成方案，也不把局部绿色测试升级为符合。
