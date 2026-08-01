# RFC #547 R7-03：Preset materialize 的发布、失败与旧版本保留

> 基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。设计锚点仅为 `AGGREGATE-547.md` 的 D1、§2.3、D10稳定条款，R5总账 `D-03/A-03/T-02`，以及S1报告。本文只建立文件事务事实；不裁决、不估规模、不写实施方案。

## A. 主 agent 摘要（最多一页）

### A1. 问题、结论与置信

**问题。** materialize从source收集到发布、校验、旧版本清理的文件副作用，是否形成可失败、可并发、可恢复的发布事务？

**结论：不符合稳定条款（高置信）。** 当前顺序是：收集与hash source → 删除同hash无marker target → 写staging全部文件 → 在staging写“完成”marker → rename为公开target → 删除同basename其他hash版本 → 返回target → **之后**才读/parse/compile。marker只证明复制流程走完，不证明preset可装载。syntax/structure/prompt/fragment/DAG任一拒绝都发生在发布与prune之后；失败不会回滚非法target或恢复旧版本。

隔离实验直接观察到：H1合法artifact存在；把source改成非法TOML后，H2带marker成为唯一版本，H1被删，load随后拒绝；缺`preset.toml`同样发布带marker的不完整artifact并删除H2；相同basename、不同hash的并发materialize均返回成功，却互相prune到两个返回路径最终都不存在。损坏一个带marker的target后，下次同source load命中marker并重复读取损坏artifact，不自愈。

### A2. 因果、影响、历史原因与根因集合

**历史动机可从代码确认：** agent在随机worktree运行，需要把`{{PRESET_ROOT}}`物理替换成稳定绝对路径；content hash复用未变source；旧sibling清理为限制磁盘增长；并发处理只针对“另一进程完成同hash rename”；注释假设每个loop-data-root只有单daemon。这些动机解释机制，不使发布语义符合RFC。

**根因集合（候选非完备）：**

1. 发布点定义在“复制完成”，而稳定条款要求的可消费完成还包括parse/type/DAG/prompt/fragment校验。
2. `.materialized-complete`同时承担cache命中与发布完成，却不编码校验结果、schema或source完整性证明。
3. prune以basename前缀为所有权，以“新target已rename”为触发，不以新版本已编译成功或旧消费者可达性为条件。
4. target目录本身是consumer持有的绝对路径；prune直接删除目录，没有indirection、lease或ref。
5. 不同hash发布者无锁：各自rename成功后可删除对方；同hash仅在rename异常后看marker，staging名只有pid+毫秒，单进程同毫秒调用存在碰撞窗口。
6. target命中只stat marker，不核对artifact文件；损坏被永久当作完成。
7. sibling/global prune逐项吞掉rm错误，调用成功不等于旧目录集合达到声明状态。
8. daemon注释提到启动期keep-set prune，但生产daemon没有导入或调用该函数；恢复责任与注释不一致。

**确定后果：** 拒绝会留下不可消费的“完成artifact”；最后一个合法旧版本可在拒绝前消失；已有消费者持有的`presetDir`可异步变成ENOENT；并发调用的成功返回值不保证返回路径存活；下次load可能反复命中损坏target；磁盘清理失败静默保留旧目录。D10 immutable definition缺口会放大旧版本删除，但本报告不裁决definition store。

### A3. 资产、未知、接缝与下一步

**可保留资产：** 全source排序bytes hash；staging内逐文件构造；单目录rename发布；同hash rename-race后marker复用；finally清理staging；不同preset basename隔离；direct/materialized编译投影等价测试。

**未知：** macOS本机rename/目录语义已实测，但其他部署文件系统的atomicity与rename-over-existing行为未由代码约束；source在hash与copy之间并发修改能否产生hash/bytes不一致需要受控FS注入确定；外部consumer持有materialized绝对路径的完整生命周期需R7其他报告给出。确定办法分别是目标文件系统故障注入、在read边界暂停并修改source、从所有`presetDir`输出向下追踪open/read。

**接缝：** R7-02负责进程内Promise cache时间一致性，本片只负责文件发布；S1的A-03 hash真实，但hash不能证明发布有效；S5/D10负责历史定义内容可达性，本片证明旧materialized目录没有保留保证。

**下一步仅为汇总：** 主agent将D-03保持“不符合”，把本片异常/并发形态加入问题树与未来D11证据缺口；不得从本文直接选择文件事务形态。

---

## B. 证据附录

## B1. 设计与总账对照

- D1：装载即编译，装载结果应由compiler拒绝/接受决定，而不是复制marker决定。
- §2.3：当前阶段只核实生产路径与失败边界，不以绿测代替未来冻结SHA验收。
- D10：定义内容在运行前可完整计算；materialized副本是当前loader的文件输入，但不是持久definition store。
- R5 `D-03`：materialize在parse前发布/prune；本报告证实并展开异常、并发、恢复。
- `A-03`：source hash真实；不推出artifact有效。
- `T-02`：缺rollback/失败测试；现有测试反而固定“编辑后只留新目录”。

## B2. 完整文件副作用顺序

生产函数 `materializePreset`：`src/loop.ts:4417-4486`。

1. `resolve(sourceDir)`并取`basename`作为版本族名（4418-4419）。
2. 递归`readdir`收集所有普通文件，跳过自身marker，排序（4420；4507-4535）。此时无materialized root副作用。
3. 对排序文件再次逐个read，hash `(relpath,NUL,bytes,NUL)`；取SHA-256前16 hex（4421-4428）。source可在collect/hash/copy各次read间变化，没有snapshot或锁。
4. 计算公开`rootDir/name-hash`及marker路径（4429-4432）。
5. marker存在且为file：立即返回，不校验target其余内容（4433-4437）。
6. marker缺失：递归删除同hash target（4441）。这会清除上次partial target，也会删除无marker但可能仍被外部读取的目录。
7. staging名为`.staging-${name}-${hash}-${pid}-${Date.now(base36)}`；mkdir（4442-4443）。无random UUID；同进程同毫秒同source调用可能同名。
8. 对每个文件mkdir parent；`.md`读text、替换target绝对路径、write；其他文件按bytes复制（4444-4456）。
9. 在staging写空marker（4457）。此时尚未parse preset。
10. `rename(staging,target)`为公开点（4458-4459）。若失败且target marker存在，删除本staging并按成功返回；否则抛错（4460-4471）。
11. finally best-effort删除staging，错误吞掉（4473-4476）。
12. rename成功后枚举root；删除所有以`${name}-`开头且不等于当前dir的entry，每项rm错误吞掉（4478-4502）。
13. 返回materialize result（4486）。
14. `compilePresetOrThrow`收到公开target后才读`preset.toml`、TOML parse、shape parse、DAG、phase prompt/template、fragment readable、source hash（4608-4696）。任一拒绝不回调materialize rollback。

**发布事实：** marker写在staging中，随rename一起公开，故读者不会看到“公开target但marker尚未写”的正常顺序；但会看到“marker存在而compile非法”。

## B3. 异常矩阵与目录结果

| 异常时点 | 已发生副作用 | 函数结果 | 恢复/下次load |
|---|---|---|---|
| source根不存在/readdir失败 | 无target/staging | typed source failure | 旧目录不受本次影响 |
| hash阶段file read失败 | 通常无root副作用 | 抛错 | 旧目录保留；source race需注入确认 |
| 删除partial target失败 | `rm(force)`可抛 | 抛错 | partial状态依赖FS |
| staging mkdir/write/read失败 | staging可能部分写 | 抛错；finally尝试清理 | cleanup错误吞掉，残留可能到global prune |
| rename失败、target marker存在 | 本staging删除 | **成功返回** | 信任竞争者artifact，不核对内容 |
| rename失败、marker缺失/stat失败 | staging finally删除 | 抛原rename错 | target可能partial/第三方状态 |
| sibling readdir失败（非ENOENT） | 新target已公开 | 抛错 | 新target留存；旧版本状态未变 |
| sibling rm失败 | 新target已公开 | **成功返回** | 旧版本静默留存 |
| TOML/shape/DAG/prompt/fragment拒绝 | 新target+marker已公开；旧siblings已尝试删除 | compile rejected/throw | 非法target留存并可marker命中 |
| target带marker但内容后来损坏 | 无写；直接命中 | 后续compile/read失败 | 重试仍命中损坏target，不重建 |

缺`preset.toml`不是materialize阶段异常：source中其他文件仍被完整复制、marker/rename/prune完成，随后compile读target TOML才失败。

## B4. 并发发布者

### B4.1 同hash

设计只处理rename竞争：loser rename失败后若winner marker可见则复用（`src/loop.ts:4460-4467`）。但staging basename由相同name/hash/pid/millisecond构成；同进程同毫秒调用可共享一个staging目录，超出该处理模型。一次组合实验观察到后续同hash并发在marker write处ENOENT；独立12调用复现实验全部成功，说明窗口为时序相关、非每次必现。静态命名足以证明碰撞可能，频率未知；确定频率需注入固定clock或导出staging-name seam。

### B4.2 不同hash、同basename

两个发布者各自target不同，所以rename均可成功。之后A prune B，B prune A；无锁、无generation比较。隔离实验一次观察到两个Promise都fulfilled而root最终为空，两个返回`promptRoot`均不存在。这一结果不依赖daemon多实例；同进程并发调用即可发生。

### B4.3 不同basename

prune只匹配`${name}-`，正常不同preset族互不删除（`4480-4485,4497-4501`）。basename碰撞的两个不同source路径会被视为同一族；实验正利用这一公开规则，不是伪造内部状态。

## B5. 消费者与可见性

| 入口/消费者 | 是否materialize | 何时看到路径 | 失败表现 |
|---|---|---|---|
| `compilePreset/loadPreset` direct | 否（除非option） | source路径 | 无本片文件副作用 |
| daemon scheduler/create/rights/status gates | 是，经`loadSchedulerPresetFromDirMaterialized` | materialize返回后；daemon再cache compiled Promise | 记录finding/load failure；非法artifact仍留盘 |
| migration definition helper | 是 | 子进程load时 | stderr/exit失败；artifact副作用已发生 |
| scheduler prompt/fragment | 间接持有compiled preset内materialized绝对路径 | spawn/read时 | sibling prune后可能ENOENT |
| agent authorization/runtime `presetDir` | 间接持绝对路径 | runner plan/spawn | 旧目录删除影响正在消费的路径 |
| target status/普通CLI/compiler CLI | 默认不materialize | source路径 | 可与daemon文件视图不同（cache属R7-02） |

调用证据：`src/daemon.ts:4448-4497,5485-5492`；`src/preset-migration-definition.ts:21-22`；`src/scheduler.ts:1658-1681,3179-3180`；direct入口见S1表 `05-r4-compile-artifact.md:188-193`。

## B6. 旧版本可达性、恢复与cleanup

1. 新hash rename后、compile前，旧同basename目录失去路径可达性（prune 4478-4485）。没有“最后已知合法”标记。
2. compiled `Preset`对象保存旧materialized绝对路径；prune不查询活跃Promise、chain/item/run、execution definition或runner。目录删除与consumer生命周期无事务。
3. `.materialized-complete`是唯一cache命中条件；没有manifest、文件count/hash复核或compile verdict。
4. `prunePresetMaterializedRoot(root,keep)`可删除任意不在keep的entry，包括staging；每项rm错误吞掉（4554-4569）。
5. 代码注释称daemon启动tracker驱动global prune（`src/daemon.ts:5479-5484`），但daemon imports无该函数，production源码无调用；仅单元测试直接调用。因此“daemon启动恢复/清理”无现存生产供给。
6. materialize自身每次新hash做family sibling prune，才是当前实际旧版本cleanup。
7. crash窗口：staging阶段crash留`.staging-*`；无生产启动cleanup时可永久残留。rename后/prune前crash会保留新旧；prune后/compile前crash会只留未经校验新版本。下次同hash只看marker并复用。

## B7. 注入实验与目录快照

所有实验纯本地、未启动daemon、未碰`~/.coder-loop`。

### B7.1 登记

- `/tmp/rfc547-r7-03-experiment.ts`、`.out`
- `/tmp/rfc547-r7-03-4be7df89-9c8f-4b84-970b-7a3dc0bee645/`
- `/tmp/rfc547-r7-03-identical.ts`、`.out`
- `/tmp/rfc547-r7-03-identical-f8c4e951-8bfc-4b52-96d4-d87fa009131e/`
- `/tmp/rfc547-r7-03-marker-reuse.ts`、`.out`
- `/tmp/rfc547-r7-03-marker-7e536fa6-bafa-4656-857d-b439bf423e10/`

### B7.2 关键快照

```text
valid-old:
  same-691096009424ec40/{.materialized-complete,p.md,preset.toml}

after syntax reject:
  same-c67c059cb7a89a33/{.materialized-complete,p.md,preset.toml}
  oldExists=false

after missing preset.toml reject:
  same-b94e438908e7c1b6/{.materialized-complete,p.md}

after concurrent different hash:
  []
  both calls fulfilled; both returned paths exists=false
```

不存在的source root调用在collect阶段失败，前后materialized目录列表字节相同。marker-reuse实验删除已发布target的`preset.toml`但保留marker；下一次相同source load未重建，直接在同target报ENOENT，目录仍为`{.materialized-complete,p.md}`。

独立同hash12并发实验：12 fulfilled、单一target存活；组合实验曾出现marker write ENOENT。两者共同限定事实为“存在碰撞窗口但非必现”，不能夸大为必然失败。

## B8. 测试同错与盲区

### B8.1 同错/不足

- `tests/unit/preset/materialize.test.ts:103-131`明确期望source编辑后只剩新hash目录；它固化eager prune，但新内容始终合法，未覆盖reject rollback。
- `:72-99`只验证marker代表copy完成/token替换，不验证compile verdict。
- `:134-177`验证成功路径materialized消费。
- `:205-223`只直接测试global prune keep-set；未证明daemon实际调用。
- `tests/unit/preset/compile.test.ts:216-233`证明direct/materialized成功投影等价，不覆盖失败目录状态。

### B8.2 盲区

- 无syntax/structure/DAG/prompt/fragment各拒绝后的目录/旧版本断言。
- 无不同hash同basename并发返回路径存活断言。
- 无同进程固定毫秒同hashstaging碰撞测试。
- 无source在collect/hash/copy之间变化的snapshot一致性测试。
- 无marker target损坏自愈测试。
- 无crash注入覆盖staging、post-rename、post-prune/pre-compile。
- 无生产daemon启动global prune调用测试，因为调用本身不存在。
- 无活跃runner/compiled object持旧绝对路径时的prune测试。

## B9. 事实支持的文件事务形态全集（候选非完备，不作推荐）

以下只按已证实判定点分类，**不选择、不排序、不转写为实施方案**：

| 形态 | 发布判定点 | 旧版本结果 | 已确定后果 |
|---|---|---|---|
| 当前copy-complete发布 | marker+rename在compile前 | 新hash立即family prune | reject可替代最后合法版本；并发互删 |
| source先完整compile、后materialize | source compile成功后才产生副本 | materialize失败时旧版仍在 | source与copy之间仍可能变化；物理替换后的路径语义需再核对 |
| staging内materialize并以staging内容compile，成功后rename | compile verdict先于公开target | reject仅清staging | `{{PRESET_ROOT}}`当前替换目标是最终target，staging读取/最终路径一致性需要明确实验 |
| 新target发布但延迟family prune | publish与retire分离 | 多版本暂时并存 | reject是否可见取决于发布前是否compile；磁盘上限不再由单次调用立即保证 |
| immutable多版本 + consumer reachability cleanup | hash目录不被同族新发布立即删 | ref仍活跃则保留 | 需要可识别consumer/ref事实；当前系统没有该账 |
| generation/pointer式发布 | consumer先读稳定选择器，再进入版本目录 | 旧版本可独立retire | 当前consumer直接持绝对hash路径，无pointer读面；属不同边界形态 |
| basename族串行化 | 同族发布互斥 | 仍取决于串行事务内prune时点 | 消除本片并发互删，但不自动解决reject-before-prune |
| marker携带manifest/verdict并命中复核 | marker不再仅为空文件 | 损坏可被识别 | 是否重建/hold仍是独立恢复语义 |

这些形态均由本片事实暴露的判定轴组合而来；集合非完备，也不表示RFC选择。

## B10. 证据索引

| 事实 | 证据 |
|---|---|
| hash/copy/marker/rename/prune顺序 | `src/loop.ts:4417-4503` |
| collect全集与排序 | `src/loop.ts:4507-4535` |
| compile在materialize返回后 | `src/loop.ts:4590-4696` |
| marker命中不复核 | `src/loop.ts:4432-4437`；marker-reuse实验 |
| daemon materialize consumer | `src/daemon.ts:4448-4497,5485-5492` |
| global prune无production调用 | `src/loop.ts:4554-4569`; daemon import/rg结果 |
| syntax/missing file旧版丢失 | `/tmp/rfc547-r7-03-experiment.out` |
| different-hash并发互删 | 同上 |
| 同hash碰撞窗口 | staging命名 `src/loop.ts:4442`; 两组实验 |
| 测试只覆盖成功/eager prune | `tests/unit/preset/materialize.test.ts:72-223` |

## B11. 尾部结论

**R7-03尾部结论：materialize当前不是“编译成功后发布”的文件事务，而是“复制完成即发布并删除旧版，随后才编译”。空marker、eager basename prune、直接绝对路径消费者与无锁并发共同导致：非法/缺文件source可留下完成artifact并删除最后合法版本；不同hash并发可全部成功却全部失去返回路径；损坏marker target可持续命中而不自愈；启动期global cleanup仅有未接线函数。A-03真实hash与rename资产可保留，但不能证明D-03符合。**
