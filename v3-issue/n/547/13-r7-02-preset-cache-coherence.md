# RFC #547 R7-02：Daemon preset cache 的时间一致性与失效面

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 设计锚点：`AGGREGATE-547.md` §2.3、D1（按需计算）、D10（源变化边界）；总账 `D-02,D-22,A-03,T-02,J-07`。  
> 调查边界：只建立 cache、consumer、并发、失败与 restart 的地面事实；不裁决、不推荐、不设计、不估算。R7-03 的文件发布事务与 R7-11 的不可变执行定义 pin 不在本报告内合并处理。

## A. 主 agent 摘要（最多一页）

### A1. 问题与结论

**问题。** daemon 的 preset cache 以什么为 key、何时创建/命中/失效；文件编辑、materialize、item/chain 操作、resume 与 restart 分别消费哪份定义；并发冷加载与失败重试是否形成一致的时间语义？

**结论（高置信）。** 现存 daemon cache 是“绝对化目录路径 → 成功装载 promise”的进程寿命缓存，而不是按需重算、源版本 cache 或实例定义 pin。首次冷加载同步把 promise 放入 Map；同一路径的并发请求共享该 promise。装载失败会删 key，下一次请求重新读取当时源；装载成功后没有 source hash/stat 复核，也没有 TTL、显式 invalidation、chain/item 删除 eviction 或其他成功淘汰。daemon restart 通过新实例的新空 Map 重新读取当前源。

隔离 H1/H2 实验直接观察到四种时间结果：

| 时间面 | 观察结果 |
|---|---|
| 同进程、首次成功后编辑同一路径 | direct loader 已见 H2；daemon 后续 item 与 scheduler-loaded 对象仍见 H1 |
| 同进程、首次失败后修复同一路径 | 失败 key 被删除；下一次请求成功读取修复后内容 |
| 两个并发冷请求 | 两请求均成功，Map 只有一个 key；代码顺序证明二者共享首次存入的 promise |
| daemon 实例重建后 | 新 Map 为空；旧 item 后续解析与新 item 均可从当前路径读到 H2 |

这不是 D10 所要求的“源变化只影响新实例”：同一绝对路径下的所有 chain/item 在一个 daemon 生命周期偶然共享首次成功版本，restart 后又整体失去这种冻结；cache 没有实例 identity。它也不是 materialized artifact 的发布/回滚保证：cache 命中后根本不会再次进入 content-hash materialization。

### A2. 复杂因果、影响与边界

1. **直接机制。** `loadedPresetCache` 的 key 只含 resolve 后目录路径，value 是 `Promise<SchedulerLoadedPreset>`。冷请求先创建 materializing load，再在第一次 `await` 前写 Map；成功路径保留，失败 catch 删除。
2. **时间放大。** 成功与失败具有不对称生命周期：成功版本冻结至 daemon 退出，失败版本则允许下一次读取新 bytes。编辑、重新 materialize、创建/删除 chain 或 item、resume 均不是 invalidation event。
3. **消费者扩散。** 该对象不仅供 scheduler phase/prompt，还供 status vocabulary、default status、id field、item add/update rights、terminal/status gates、queue unblock、exits/exit-action 与 privileged operation rights；因此 H1/H2 分叉不是单一 model 字段问题。
4. **多事实源。** daemon 外的 compile CLI、target runtime、chain-complete helper和单次 status snapshot cache会直接读取当前源；它们可与 daemon 长寿命 cache 同时给出 H2/H1 两种答案。
5. **restart/recovery。** restart 清空的只是进程 Map，不是按旧 definition ref 恢复内容。恢复后的首次相关 daemon 操作会按 resolver 重新选路径并暖 cache；legacy item fallback 还可能从 chain/default 选出当前路径。
6. **finding 时序。** finding collector 每次调用都新建，但 callback 只在冷加载真正执行时收到 finding；cache hit 不重新编译，也不重新发出 compile findings。

**当前影响。** 同一运行进程中，preset 文件更新对 direct/CLI/status局部读面可见，对 daemon cache consumers 不可见；restart 后旧 chain/item 的行为可以随当前源改变，而其已持久化 identity/ref 不负责解析行为。

**可保留资产。** source tree 的真实 SHA-256、materialized path、统一 loader、promise 去重、失败后可重试、结构化 load failure 均是已存在事实；这些资产不等于已满足时间一致性。

**置信边界。** cache 生命周期、全部 daemon 调用点、失败删除、无成功 eviction 与路径 normalization 由生产代码确定；H1/H2、失败修复、并发冷请求和新 daemon 实例由隔离运行实验确认。未触碰中央 daemon或生产 DB。symlink alias 未运行实验，但 key 不含 `realpath`/inode/content hash 是代码可判定事实。

### A3. 未决与下一阶段资格

本报告已足以进入该细节的 R8 决策档案准备，但**不作裁决**。仍需由 R7-03 独立回答 materialize 文件发布事务，由 R7-11 独立回答实例定义 pin/恢复；三者不得以任一单点修改互相冒充闭合。外部 GUI/hook consumer 未在本片证明，继续保留为总账未知。

---

## B. 证据附录

## B1. 设计与总账逐条对照

| 锚点 | 地面事实 | 本片判定边界 |
|---|---|---|
| §2.3 最早可决定阶段 | daemon 首次路径访问时 load/compile；之后 hit 不再决定 | 已确定现状，不裁决目标归属 |
| D1 按需计算 | daemon success 结果按路径保留至进程结束 | `D-02` 的直接机制已闭合 |
| D10 源变化边界 | 同进程按共享路径冻结；restart 后旧实例重绑当前源 | 与 `D-22/J-07` 互证，但不替代 R7-11 |
| `A-03` | loader 产生真实全源 SHA-256，materialized 目录含 hash | hash 不在 daemon cache key，也不触发 hit 复核 |
| `T-02` | 既有 compiler/materialize 测试没有长寿命 H1→H2 consumer matrix | 运行证据已补本片核心路径，跨外部 consumer 仍未知 |

## B2. Cache 定义、key、创建、命中与失效全集

### B2.1 定义与 key

- daemon 字段：`Map<string, Promise<SchedulerLoadedPreset>>`（`src/daemon.ts:1187`）。
- resolver 将 preset path 解析为目录，再用 `resolve(...)` 形成 cache key（`src/daemon.ts:4586-4608`）。
- key 不含 source hash、mtime、inode、definition ref、chain id、item id 或 materialized artifact path。
- `resolve` 消除相对路径文本差异，但未做 `realpath`：不同 symlink/alias 绝对路径可以形成不同 key；同一 key 下内容变化不能形成新 entry。

### B2.2 冷加载与并发共享

主加载函数位于 `src/daemon.ts:4448-4498`：

1. 为本次调用创建 finding collectors；
2. Map miss 时构造 `loadSchedulerPresetFromDirMaterialized(...)` promise；
3. 在首次 `await` 之前把该 promise 写入 Map（`:4461-4465`）；
4. 并发到达的第二个请求同步命中并 await 同一个 promise；
5. 成功后所有调用者取得同一个 resolved `SchedulerLoadedPreset` 对象。

因此“并发 compile promise sharing”不是基于两次 load 最终 hash 相等，而是同一 promise identity 的请求合并。

### B2.3 命中、失败和成功生命周期

- **hit：** 直接 await 已存 promise；不 stat source、不计算 hash、不重新 materialize、不重新 compile。
- **failure：** catch 删除该 key（`src/daemon.ts:4475-4476`），发出 `daemon.preset_load_failed`；下次请求重新走当前 source。
- **success：** 没有 delete/clear/TTL/LRU/source-check；仓内未发现 chain delete、item delete、resume、source edit 或 materialization 触发成功 entry eviction。
- **restart：** 新 daemon object 的字段初始化为空 Map；进程内旧 promise 不持久化。

### B2.4 Finding 生命周期

finding collectors 是每次 wrapper 调用的新局部对象（`src/daemon.ts:4451-4483`），但 compile/materialize callback 只在冷 promise 内执行。由此：

- 冷加载成功/失败可产生本次 findings；
- hit 不重新执行 compiler，不能观察编辑后的新 warning/error；
- hit 调用者即使提供新 collector，也不会重放首次 findings；
- failure 删除 entry 后的 retry 会生成修复后那次 load 的新 findings。

## B3. Materialization 与 cache 的边界

`loadSchedulerPresetFromDirMaterialized` 位于 `src/daemon.ts:5479-5491`。冷加载进入 content-hash materialization，再从 materialized path 得到 scheduler preset。daemon cache 外层以 source directory path 为 key，因此：

- 第一次成功后，source path 的后续访问不会再次计算 content hash；
- 磁盘上出现 H2 materialized artifact，不会替换已缓存的 H1 object；
- 删除或 prune materialized directory不是本 Map 的显式 invalidation；已 resolved object仍持有此前字段/path；
- materialize 的 marker/rename/prune/失败原子性属于 R7-03，本片只界定它位于 cold miss 内部。

## B4. 完整 daemon consumer 图

所有下列入口最终汇入 `loadedPresetFromDirForChain` / `loadedPresetForItem`（`src/daemon.ts:4422-4445,4586-4608`）。

| 操作/消费者 | 主要位置 | 从 cached preset 消费 | 同路径 H1→H2 后同进程结果 |
|---|---|---|---|
| privileged operation rights | `src/daemon.ts:2058` | operation authorization | 继续按 H1 权限 |
| chain status vocabulary | `:2462-2491` | statuses/terminal vocabulary | status 判断仍按 H1 |
| queue unblock | `:2754` | phase/status准入 | unblock 按 H1 |
| item add default status | `:3015,3857-3862` | initial/default status | 新 item 仍写 H1 默认值 |
| item add id field | `:3022` | item identity field | 新 item 仍用 H1 idField |
| item add rights | `:4170-4174` | field/operation rights | add 按 H1 |
| item update terminal check | `:3133` | terminal statuses | terminal 判断按 H1 |
| item update field rights | `:4291-4294` | update authorization | update 按 H1 |
| status/phase gates | `:3838-3908,4402-4404` | vocabulary、phase admission | phase/status变更按 H1 |
| item exits query | `:3305` | phase exit definitions | 返回 H1 exits |
| item exit action | `:3364` | exit/action definition | 执行 H1 action |
| scheduler preset resolver | `:3681-3709` | phases、runner、model、source identity | 新 run 仍以 H1 model/phase/hash |
| prompt resolver | `:4407-4419` | materialized prompt path/content | 继续渲染 H1 materialized prompt |

scheduler 随后使用同一 loaded preset 构建 render context（`src/scheduler.ts:3128-3200`），并以其 source hash 作为 execution content identity（`:3438-3439`）。所以 cache 分叉会同时影响“行为字段”和“本次新 run 记录的 identity”；已有 runtime node ref 仍不成为 resolver。

## B5. Resolver 层级、创建、resume 与 restart

### B5.1 Resolver 层级

- chain resolver：`src/daemon.ts:4422-4424`；
- preset spec resolver：`:4430-4438`；
- item resolver及 legacy chain fallback：`:4441-4445`；
- path/name/chain 的最终解析：`:4586-4603`。

这些层决定“哪个路径 key 被访问”，但均不把实例创建时 definition identity加入 cache key。

### B5.2 生命周期事件矩阵

| 事件 | 是否 invalidation | 后续读取事实 |
|---|---:|---|
| 编辑同一路径 source | 否 | daemon hit 仍 H1；direct loader 可见 H2 |
| 单独 materialize H2 | 否 | 已缓存 source path 不再进入 materializer |
| chain create | 否 | 首次需要 preset 的操作可暖 key；已有 key直接共享 |
| item create | 否 | 读取 cache 决定 default/id/rights；不会创建版本化 key |
| item update / exits / unblock | 否 | 均复用该路径当前 cached object |
| scheduler 首次 spawn | 否 | 若 key 冷则暖 cache；若热则使用既有版本 |
| resume | 否 | runner session resume 不改变 preset resolver；行为仍由 cache/path决定 |
| chain/item delete | 否 | 未发现与 key 关联的 eviction |
| load failure | 是，仅该 key | 下一请求重读当前 bytes |
| daemon restart | 全部，因对象销毁 | 新进程首次相关访问按 resolver从当前路径重新暖 cache |

restart 后“哪个操作先暖 cache”没有独立恢复快照规则：scheduler恢复、operator status/mutation或新 item 操作中最先经过上述 loader 的请求决定首次版本。若源在 restart 前后变化，旧实例不会自动恢复其历史内容。

## B6. Daemon 外的当前源消费者

长寿命 daemon Map 不是进程内唯一 preset 读面：

| 读面 | 位置 | cache 生命周期 | H1→H2 后 |
|---|---|---|---|
| status snapshot local cache | `src/loop.ts:3190-3212` | 单次 snapshot 的 `Map<string,Preset>` | 新 snapshot 读当前 H2 |
| target runtime loader | `src/loop.ts:4154-4173` | 直接 load | 读当前 H2 |
| chain-complete helper | `src/loop.ts:5426-5443` | 未注入时直接 load | 读当前 H2 |
| compile CLI / direct `loadPreset` | compiler入口 | 无 daemon process cache | 读当前 H2 |
| migration definition helper | `src/preset-migration-definition.ts:22` | materialize但无该 daemon Map | 按调用时当前源 |

status snapshot 的局部 Map 只去重一次快照内重复读取，不能与 daemon 的进程寿命 promise cache混为同一问题。

## B7. H1/H2 隔离实验

### B7.1 环境与命令

- 脚本：`/tmp/rfc547-r7-02-experiment.ts`
- stdout：`/tmp/rfc547-r7-02-output.log`
- stderr：`/tmp/rfc547-r7-02-error.log`
- 隔离 loop-data：`/tmp/rfc547-r7-02-state/`
- fixtures：`/tmp/rfc547-r7-02-preset/`、`/tmp/rfc547-r7-02-bad-preset/`、`/tmp/rfc547-r7-02-concurrent-preset/`
- 方式：进程内 daemon，`scheduler.enabled=false`，隔离 DB/socket；未启动中央 daemon。

```sh
bun /tmp/rfc547-r7-02-experiment.ts \
  > /tmp/rfc547-r7-02-output.log \
  2> /tmp/rfc547-r7-02-error.log
```

命令退出码为 0。

### B7.2 观察

1. H1 首次 item：default status=`h1`；cached name=`cache-H1`；model=`model-H1`；hash=`79987c…`；prompt 指向 H1 hash 的 materialized 目录。
2. 同路径改写 H2：direct `loadPreset` 得到 name=`cache-H2`、entry=`h2`、model=`model-H2`、hash=`6d25f7…`；第二个 daemon item 仍为 status=`h1`，cache hash/model/prompt均仍是 H1。
3. malformed preset：返回结构化 `invalid_request`，发出 `daemon.preset_load_failed`，失败路径不在 Map；修复后同路径 retry 成功，status=`fixed`，Map 新增成功 entry。
4. concurrent cold adds：两个请求均成功，目标路径只有一个 Map entry；结合 `set` 早于 `await` 的生产顺序，证明共享同一 cold promise。
5. stop并在同一隔离 root 新建 daemon：第三个 item 得到 status=`h2`；新 Map 只含 H2 hash/model/materialized prompt。

### B7.3 实验能与不能证明什么

能证明成功缓存、失败 retry、restart清空以及跨 direct/daemon 的 H1/H2 分叉。并发实验观察到单 entry，promise identity sharing由代码顺序补强。它不证明 central daemon运维、R7-03发布事务或R7-11 definition artifact恢复。

## B8. 根因集合与放大条件

### B8.1 根因集合

1. **key 只表示解析后路径，不表示内容版本或实例 identity。**
2. **成功 promise 生命周期等于 daemon object 生命周期。**
3. **没有将 source edit/materialize/create/resume/delete 映射为 invalidation event。**
4. **持久化 definition ref 不参与 preset resolver；cache 的偶然冻结替代不了 pin。**
5. **同一系统存在长寿命 cached 与 direct/current-source 多条读取路径。**
6. **legacy fallback 可在 restart 后重新选择当前 chain/default path。**

这些是多因共同形成的时间分叉；只描述“cache stale”会漏掉 restart 后旧实例行为漂移与非 daemon current-source consumers。

### B8.2 放大条件

- 同一路径在 daemon uptime 内被编辑或替换；
- 多个 chain/item共享一个 path；
- H2改变 phase、status、rights、runner/model、prompt 或 exits；
- load 首次失败后文件被修复，与成功后文件被修改形成相反可见性；
- daemon restart/recovery发生在 H1/H2 切换之后；
- relative path工作目录或symlink alias让同一底层目录形成不同 key；
- status/CLI读面与 scheduler/daemon mutation在同一时刻被比较。

## B9. 测试覆盖、盲区与同错风险

### B9.1 已覆盖资产

既有测试覆盖 compiler/load、source hash、direct/materialized projection等价、daemon一般 loader failure与 scheduler基本路径；它们证明局部机制可运行。R4/S1 的相关 31 个测试全绿不构成时间一致性证明。

### B9.2 现存盲区

- 无同一 daemon 生命周期 H1→H2 后逐个核对全部 B4 consumer 的表驱动测试；
- 无 success entry 的明确 lifetime/invalidation contract 测试；
- 无“成功永久保留、失败删除重试”的对称性断言；
- 无并发冷加载直接断言 load/compile 只调用一次及所有请求共享同一结果；
- 无 daemon restart 后旧 item/chain 与新实例分别核对 phase/model/prompt/status/rights；
- 无 cache hit 时 findings 不重发、源中新 findings 不出现的测试；
- 无 symlink alias、relative path/current working directory 对 key 的测试；
- 无跨 daemon status、direct compile、target runtime、chain-complete 的同一时刻一致性测试；
- 无 definition ref identity 与实际 resolved source hash不一致时的响亮检测。

### B9.3 同错风险

只断言单一 daemon uptime 内行为稳定，会把偶然 H1 path cache当作 D10 pin；只在 restart 后断言读取 H2，又会把旧实例隐式重绑当作“reload正常”。只测一个 consumer或只测 hash字段也无法证明 status、rights、prompt、runner/model与exits同源。

## B10. 事实支持的 solution-shape 约束及确定后果（不作推荐）

以下不是候选方案或优先级，而是由现状推出、任何后续裁决都不能遗漏的约束：

1. 时间语义必须同时说明**同进程成功、同进程失败、并发冷请求、restart后旧实例、restart后新实例**；只说明“reload”无法覆盖五者。
2. cache identity 与 execution-definition identity 若仍不同，必须明确两者各自保护的对象；否则 path稳定会继续被误读为实例pin。
3. 任何源变化判定都必须覆盖完整 source tree，而非只看 `preset.toml`；现存 `A-03` hash已覆盖目录bytes。
4. finding 的生命周期必须与 model 的 load/cache生命周期同表述；否则 hit可能返回model却丢失或陈旧化diagnostics。
5. materialized artifact发布成败与 daemon entry失效是两个事件；R7-03完成发布不自动改变已resolved promise。
6. 全部 B4 consumers必须从同一已声明时点/版本读取；只调整scheduler仍会留下mutation/status vocabulary分叉。
7. daemon外 direct/current-source读面必须被纳入可观察一致性边界；否则 CLI/status仍能与daemon行为同时矛盾。
8. 并发 cold request 的单次计算与失败后的可重试性是现存确定行为；后续语义变化会直接影响请求合并、finding发射和错误恢复。
9. 路径规范化必须明确 alias 与工作目录后果；仅以字符串绝对化不能证明底层source唯一。
10. restart/recovery 必须有明确版本来源；“新 Map为空”本身只说明重新选择，不说明按当前源或历史定义哪一个符合实例语义。

## B11. 证据索引

| 主题 | 证据 |
|---|---|
| daemon Map声明 | `src/daemon.ts:1187` |
| cache loader/成功/失败 | `src/daemon.ts:4448-4498` |
| chain/spec/item resolver | `src/daemon.ts:4422-4445` |
| path resolution/key | `src/daemon.ts:4586-4608` |
| materialized daemon load | `src/daemon.ts:5479-5491` |
| scheduler consumer/render | `src/scheduler.ts:3128-3200` |
| execution identity | `src/scheduler.ts:3438-3439` |
| status snapshot local cache | `src/loop.ts:3190-3212` |
| target runtime direct load | `src/loop.ts:4154-4173` |
| chain-complete direct load | `src/loop.ts:5426-5443` |
| migration helper | `src/preset-migration-definition.ts:22` |
| prior compile/cache finding | `05-r4-compile-artifact.md` A2/B4/B7 |
| prior definition-pin finding | `09-r4-resume-definition-pin.md` A/B4-B8 |
| normalized ledger | `11-r5-supply-ledger.md` `D-02,D-22,A-03,T-02,J-07` |
| experiment | `/tmp/rfc547-r7-02-experiment.ts`; `/tmp/rfc547-r7-02-output.log`; `/tmp/rfc547-r7-02-error.log` |

## B12. 尾部结论

**R7-02 尾部结论：daemon preset cache 是 path-only、成功至进程寿命、失败即删除的 promise cache。它在同进程把共享路径的所有消费者偶然冻结到首次成功版本，在失败修复时却允许读取新版本；direct/current-source consumers 可同时看到新源，daemon restart 又使旧实例重新绑定当前路径。并发冷请求共享首次 promise，source edit、materialize、chain/item create/delete、resume均不是失效事件。故当前漂移由路径 key、成功寿命、无失效事件、无实例 resolver及多读面共同造成，不能归约为单一 cache 点，也不能用 materialize 原子性或 definition pin 的未来结论互相替代。**
