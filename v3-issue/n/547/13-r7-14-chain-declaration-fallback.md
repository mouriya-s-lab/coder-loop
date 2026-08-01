# R7-14 · Typed chain declaration boundary 与 preset fallback/recovery

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 唯一设计锚点：`AGGREGATE-547.md` D9 P-D9-1…3、D10 chain definition接缝。  
> 总账输入：`D-24,U-04,A-12,J-04,J-07,T-07`。  
> 前置只读事实：`13-r7-04-schema-external-consumers.md`、`13-r7-13-repository-authority-migration.md`。  
> 范围：chain/item preset声明、全部resolver/fallback、无item判定、status/recovery/chain-complete前置与外部owner；不设计typed boundary，不裁决。

## A. 主 agent 摘要

### A1. 问题

稳定设计要求：chain create不再隐式seed默认preset；chain声明经单一外部typed boundary；新item必须显式声明自己的preset，历史item恢复也应使用per-item事实而非隐式chain/default。R7-14要查清所有null/non-null组合、fallback调用者、存量组合、无item chain所需字段与外部owner接口。

### A2. 结论与置信边界

**D-24仍为部分/无供给；P-D9-1不符合、P-D9-2无现存供给、P-D9-3部分符合。preset authority不是一条fallback链，而是按入口分裂的多套resolver。**

1. 新item public admission严格要求`preset XOR presetPath`；per-item name/path是spawn、rights、exits、status vocabulary的主要来源。这是可保留的真实资产。
2. store/schema仍允许item两者皆null或皆非null。daemon loader对“皆非null”静默选`item.presetPath`；loop target resolver会对config name+path同时存在报错，但status item resolver同样先选path。内部持久态没有统一互斥约束。
3. legacy item两者皆null时，daemon回退：`chain.metadata(.bindings).presetPath` → `chain.preset` → `invalid_request`。因此历史item不满足P-D9-3的“恢复使用per-item事实”。
4. chain create省略preset时，daemon仍seed bundled `gh-issue-pr-iteration`；只有显式wire `preset:null`才得到null。operator CLI省略`--preset`时不发送字段，因而走seed，而不是null。
5. target-side `resolvePresetDir`在name/path皆null时又独立默认`gh-issue-pr-iteration`；daemon chain resolver在相同null/null下则点名失败。相同disk state在socket chain.status、scheduler、target status之间具有不同语义。
6. chain path与chain name同时存在时，daemon/chainResolved均静默选metadata presetPath；无冲突错误。item path与name同时存在时也静默选path。实验以不存在的name+有效path证明path优先。
7. `chain.status`无任何source时返回成功但用空status集合；即使存在一个legacy null/null item，也不加载、不报错，仍把item原样显示。这个“可读”不等于可调度或可恢复。
8. scheduler在active chain进入循环时有更早gate：`items.length===0 && chain.preset===null`直接skip。它没有考虑有效的chain metadata presetPath。因此无item的path-only chain在socket status可成功load，却被scheduler当“nothing to drive”跳过；无item语义内部不一致。
9. 有items时，scheduler/status选“第一个带per-item source的representative item”作为chain-wide vocabulary/phase-plan；其余items可来自不同preset。无item时只能读chain path/name；没有独立chain definition ref/tree声明作为权威。
10. daemon startup recovery主要核对run/tree/closure并在随后tick重新调用当前resolver；definition ref不解析内容。legacy fallback叠加restart current-source reload，放大R7/S5已确认的隐式definition rebind。
11. 隔离DB/daemon覆盖null/name/path/both组合：path-only chain、chain name+path、item name、item name+path均可status；bad item path即便item/chain name有效也失败；无source chain与legacy null item均status成功但没有可用vocabulary。
12. R7-04与R7-13的跨仓/本机事实未找到外部typed chain declaration producer。现存接口只有private app内CLI flat config→socket JSON→store；installed app版本甚至没有compile projection命令。`U-04`保持未知，不可改写为全系统不存在。

### A3. 因果、影响与资产

历史迁移把preset从chain移到item，却为旧item保留chain seed和fallback；同时target status保留更老的global default，metadata presetPath又作为override叠加。各consumer分别修补兼容，未共享一个typed declaration/definition authority，于是“缺省”“无item”“legacy null”“both-set”在不同入口含义不同。

**当前影响**：operator不传preset仍得到GitHub默认；path-only empty chain可被status识别但scheduler跳过；legacy null item可在status中看似健康却无可执行定义；both-set状态静默选path；restart可把同一历史item重新绑定当前chain/default源。

**未来放大**：外部producer若假定null即无定义，会被daemon seed改变；typed chain declaration若只写metadata/tree，现有scheduler empty-chain gate仍只看`chain.preset`；mixed-preset chain的representative选择会让chain-wide判定依赖row order。

**可保留资产**：new item XOR admission；per-item path/name validation；loader error choke point与`daemon.preset_load_failed`；item-first scheduler/status resolver；migration给多数历史item回填preset；generic SQLite事务；socket chain.status区分“配置source损坏”与“完全无source”。

### A4. 未知与下一步

- future chain declaration应包含哪些定义字段、由哪个repo/进程生产、如何版本化，仍无实存owner；本报告不从RFC文字反推。
- mixed-preset chain的chain-wide vocabulary最终语义、legacy null存量处置、both-set冲突策略、无item chain应否执行chain-complete，均需R8裁决。
- 本次scheduler disabled，没有触发runner或真实chain-complete side effect；前置gate/consumer结论来自生产控制流。没有真实runner缺口不影响resolver判定。

事实已足够进入R8；B13形态非完备且不推荐。

---

## B. 证据附录

### B1. 设计对照

| 条款/总账 | 判定 | 事实 |
|---|---|---|
| P-D9-1 | 不符合 | daemon omitted preset seed默认；target resolver null/null再默认。 |
| P-D9-2 | 无供给 | 无单一外部typed chain declaration boundary/owner/schema。 |
| P-D9-3 | 部分符合 | 新item显式per-item真实；legacy null item回退chain/default。 |
| D10 chain definition接缝 | 无内容权威 | chain无创建时definition ref；无item只能取path/name兼容字段。 |
| D-24 | 部分/无供给 | item-first存在，fallback与boundary终态不存在。 |
| U-04 | 仍未知 | 已知本地owner无实现；未checkout/未来owner不可判。 |
| A-12 | 可保留 | per-item XOR、wire/store/migration骨架。 |
| J-04 | 互证 | generic chain metadata不是typed chain admission。 |
| J-07 | 互证 | legacy fallback + restart current-source重载导致隐式rebind。 |
| T-07 | 同错 | store null fixtures与default-seed tests分别绕过/固化不同入口。 |

### B2. 持久字段与可形成组合

#### Chain sources

- `chains.preset: string|null`；
- `chain.metadata.presetPath`或`metadata.bindings.presetPath`；
- daemon create omitted字段会先变成默认name；显式null才持久null。

#### Item sources

- `items.preset: string|null`；
- `items.preset_path: string|null`；
- schema没有`CHECK exactly one`；store API可以写null/null或name/path同时非null。

v9 migration新增item两列，并在新增时从`chains.preset`回填null item（`src/sqlite-state.ts:1034-1049`）。它减少了legacy null/null数量，但：

- chain.preset本来为null的行仍null/null；
- store/旧旁路仍可写null/null；
- schema允许both-set；
- migration不把metadata presetPath回填到item。

### B3. public create语义

#### Chain create

`src/daemon.ts:2166-2188`：

| wire `preset` | 持久chain.preset |
|---|---|
| omitted | `DEFAULT_PRESET_NAME`（`gh-issue-pr-iteration`） |
| valid bundled name | 该name |
| explicit null | null |
| invalid name | request拒绝 |

CLI `chain create`不传`--preset`时省略wire字段（`src/loop.ts:2185-2218`），所以operator默认无法自然得到null；需直接wire显式null。

#### Item add/batch

CLI `parseItemPresetSpec`与daemon `requireItemPresetForRequest`都要求exactly one（`src/loop.ts:2117-2127`; `src/daemon.ts:3060-3084`）：

- null/null → `invalid_request: preset is required`；
- name/path both → mutually exclusive error；
- name → bundled validation；
- path → absolute、目录、preset.toml loadability validation。

新item成功前会加载该source取得entry status与idField。因此public new item没有silent chain inheritance。

### B4. resolver全集

#### B4.1 daemon chain resolver

`presetDirForChain`（`src/daemon.ts:4557-4584`）：

1. chain metadata/bindings `presetPath`；
2. `chain.preset` bundled name；
3. `invalid_request`，点名“no preset and no items to derive one from”。

path与name并存时path胜出，无冲突检查。

#### B4.2 daemon item resolver

`presetDirForItem`（`:4586-4603`）：

1. `item.presetPath`；
2. `item.preset`；
3. chain resolver。

both-set时path胜出；null/null进入legacy fallback。`loadedPresetForItem`被spawn、rights、item exits/exit-action、update field rights、scheduler等调用。

#### B4.3 scheduler resolver

production daemon注入两函数（`src/daemon.ts:3685-3726`）：

- `presetForChain`→daemon chain loader；
- `presetForItem`→daemon item loader。

scheduler helper（`src/scheduler.ts:3225-3249`）：

- selected item总是尝试per-item resolver；
- chain-wide status/phase plan从items中找第一个preset或path非null的representative；
- 找不到才调用chain resolver。

测试可不注入`presetForItem`，此时所有item退化为`presetForChain`（`:3229-3233`）；这是fixture compatibility surface，不是production per-item语义。

#### B4.4 socket chain.status resolver

`src/daemon.ts:2453-2503`：

- 有任一item source→第一项；
- 否则chain metadata path；
- 否则chain name；
- 全无→不load，status集合为空并返回成功。

注意：存在legacy null/null item不会令其成为representative；如果chain也无source，它仍走“全无”成功路径。

#### B4.5 target status resolver

`chainResolvedFromChain`先取metadata/binding presetPath；path存在则把preset置null，否则保留chain.preset（`src/loop.ts:4306-4327`）。`resolvePresetDir`（`:5561-5577`）：

- name+path both → error；
- path → path；
- name → bundled；
- null/null → `DEFAULT_PRESET_NAME`。

因为上游先把name/path互斥化，disk上chain both-set在target path语义下不会报错，而是path胜出。target status item resolver（`:3180-3218`）对item path/name/null的顺序与daemon相同，但null/null回落已加载的`options.preset`；该chain preset可能来自global default。

#### B4.6 legacy migration resolver

`src/preset-migration-definition.ts:9-31`调用`resolvePresetDir({item.preset,item.presetPath})`。因此：

- item both-set → migration helper报mutually exclusive；
- item null/null → global default，而不是daemon chain resolver；
- helper输入不含chain.preset/metadata path。

这与runtime daemon legacy fallback又不同。S5已证明它读取升级时当前source，无法恢复历史H1。

### B5. null/non-null组合矩阵

#### B5.1 chain组合（无item上下文）

| metadata path | chain name | daemon chain/status | scheduler empty-chain gate | target status |
|---|---|---|---|---|
| null | null | resolver报错；但socket chain.status特判为空集合成功 | 直接skip | global default |
| null | name | name | 继续处理 | name |
| path | null | path | **直接skip**（只看chain.preset null） | path |
| path | name | path，无冲突 | 继续处理 | path（上游抹name） |

#### B5.2 item组合

| item path | item name | daemon item | target status item | migration helper | public create |
|---|---|---|---|---|---|
| null | null | chain fallback | chain-loaded preset fallback | global default | 拒绝 |
| null | name | name | name | name | 接受 |
| path | null | path | path | path | 接受 |
| path | name | path，无冲突 | path，无冲突 | **互斥错误** | 拒绝 |

同一durable both-set/null-null item在daemon、target status和migration具有不同结果。

### B6. 无item chain与chain-complete前置

无item时没有per-item source、item repoCwd或item definition ref。现有chain-wide判定只能依赖：

- chain.preset；
- metadata presetPath；
- chain status/metadata；
- current task tree/run（若历史存在）。

`chain.status`明确允许全无source并返回empty vocabulary。scheduler tick却在任何load之前执行：

```ts
if (items.length === 0 && chain.preset === null) continue
```

（`src/scheduler.ts:512-529`）。它忽略metadata presetPath。因此path-only empty chain不会进入status vocabulary、phase plan或`completeChainIfReady`。name-seeded empty chain会继续并可能运行chain-complete trigger path。

这说明无item判定事实源不是统一resolver：gate直接读物理chain.preset，后续才可能读metadata path/name。现状没有chain definition ref/tree declaration能替代这两个兼容字段。

### B7. recovery/restart与definition接缝

1. daemon startup恢复run/tree/closure、reconcile Git资源；它不会用task node definitionRef解析preset内容。
2. 后续scheduler tick重新调用daemon preset resolver；同daemon cache可能冻结旧source，restart清cache并读取当前path。
3. legacy item null/null因此在每次restart重新经chain path/name选择；target status甚至可能走global default。
4. execution_definitions只存identity/hash占位，无内容；chain/item create不pin。R7/S5已证明resume session不选择definitionRef。
5. v13→v16 migration对每item调用独立helper；null/null走global default、both-set失败，与生产daemon chain fallback不一致。

**确定后果**：fallback不仅决定“显示哪个preset”，还决定migration物化的definition identity、chain-wide vocabulary、phase plan、prompt/rights与chain-complete trigger。restart源变化会放大为行为漂移。

### B8. 隔离实验

#### B8.1 环境

- `/tmp/rfc547-r7-14-experiment.ts`
- `/tmp/rfc547-r7-14-experiment.out`
- loop-data：`/tmp/rfc547-r7-14-c2237e73-20d7-4337-a5fa-126a1fdbd11a`
- custom preset A/B置于同root；store预置组合；`startCoderLoopDaemon({scheduler:{enabled:false}})`只做socket status与startup recovery；无runner、无worktree、无生产DB。

startup recovery因item.repoCwd=`/tmp`执行只读Git contract/reconcile并记录isolated `repository-scan-failed`事件；未修改repo。daemon已stop。

#### B8.2 观察

| fixture | 组合 | chain.status |
|---|---|---|
| none | chain null/null，无item | success，empty items/waits |
| path-only | chain path/null，无item | success，证明status识别path |
| chain-both | valid path + nonexistent name | success，证明path胜出 |
| legacy-no-source | legacy item null/null + chain null/null | success，不报unresolved，item原样显示 |
| legacy-path | legacy item null/null + chain path | success，chain fallback可load |
| item-name | item bundled name + chain null | success |
| item-path | item valid path + nonexistent name | success，证明item path胜出 |
| item-bad-path | item bad path + valid item/chain name | `invalid_request` + `daemon.preset_load_failed`，证明path失败不回退name |

所有row close/reopen后组合不变。

#### B8.3 direct resolver探针

- `/tmp/rfc547-r7-14-resolve.ts`
- `/tmp/rfc547-r7-14-resolve.out`

`resolvePresetDir`观察：null/null→`presets/gh-issue-pr-iteration`；name→bundled；relative path→targetCwd相对绝对化；both→互斥error。这直接证实target/migration helper的global default，与daemon resolver不同。

### B9. 存量分布边界

本次只能在复制/合成隔离DB构造组合，未读取生产DB。可确定“schema允许/迁移可产生”的分布：

- chain name非null：旧链与当前CLI默认广泛产生；
- chain null：显式wire/store可产生；
- chain metadata path：CLI config bindings可产生；
- item exactly-one：当前public add产生；
- item null/null：v9时chain preset null未被回填、旧旁路/store可产生；
- item both-set：store/schema可产生，public API拒绝；
- mixed item presets：明确允许，scheduler选first representative。

实际生产DB各类行数未知；规则禁止触碰真实DB，因此报告不虚构分布计数。若R8需要迁移量，需另行授权复制数据库后离线统计。

### B10. 外部typed chain owner与接口/错误

前置R7-04确认：

- code checkout有compile projection instance但无schema artifact；
- installed app wrapper指向旧app SHA，连`preset compile`命令都不存在；
- GUI/hook/hapi-remote-session尚无可识别consumer；
- github-hapi-agent-router使用自有Zod config并推HAPI，不连接coder-loop chain.create。

R7-13对本机`/Users/mouriya/Ext/code`排除当前repo检索`coder-loop chain create|chain.create`，命中仅coder-loop worktree README副本。

所以现存实际chain owner/interface只有：

| owner | interface | error shape |
|---|---|---|
| coder-loop CLI | flat `--config-json` + optional `--preset` | CLI fail或daemon result；不是schema-derived typed declaration |
| daemon socket | JSON `{name,preset?,repository,baseBranch,metadata}` | `invalid_request`等DaemonError |
| SQLite store | TS `CreateChainInput` | SQL/runtime-data error；可绕过daemon defaults/validation |

没有外部owner可提供稳定schema/version或与socket等价性证明。未checkout/未来repo仍未知。

### B11. 调用者/消费者总表

| consumer | item优先 | chain fallback | global default | 无source行为 |
|---|---:|---:|---:|---|
| daemon spawn/rights/exits | 是 | 是 | 否 | error |
| scheduler chain-wide plan | first sourced item | 是 | 否 | empty+null chain早skip；有legacy item则error/backoff路径 |
| socket chain.status | first sourced item | 是 | 否 | empty vocabulary success |
| target `status` snapshot | 是 | loaded chain config | 是 | default |
| migration definition helper | 自身name/path | 不读chain | 是 | default |
| new item admission | exactly-one | 禁止 | 禁止 | reject |
| chain-complete trigger | 无item时无item source | chain source | 间接受create seed | null chain early skip |

### B12. 测试同错与盲区

#### 同错

- daemon create tests期望omitted preset seed `gh-issue-pr-iteration`，固化P-D9-1旧语义。
- store tests可直接create `preset:null` chain/item，绕过CLI/daemon，不能证明operator入口。
- per-item tests证明new item XOR，但常把legacy fallback当兼容成功，不验证P-D9-3终态。
- scheduler fixtures若不注入`presetForItem`会退化为chain resolver，不能证明production mixed-item行为。
- status tests分别覆盖target/sock面，却缺同一disk null/null的交叉比较。
- migration tests使用current source并可默认，不能证明历史definition pin。

#### 盲区

- 无所有8种chain/item组合的统一contract test；
- 无path-only empty chain status vs scheduler差异测试；
- 无legacy null item在daemon/target/migration三面一致性测试；
- 无both-set存量冲突测试；
- 无外部typed boundary producer/consumer E2E；
- 无真实production DB组合计数；
- 无restart H1→H2+legacy fallback行为验证（归R7-11/冻结SHA）。

### B13. 根因集合、放大条件与修补边界

#### 根因集合

1. chain default seed仍在daemon create；
2. target resolver另有独立global default；
3. v9迁移保留chain fallback，schema未约束item XOR；
4. metadata path override叠加在legacy name之上；
5. status、scheduler、migration各自实现不同resolver/前置gate；
6. mixed-preset chain需chain-wide判定，现状用first representative row；
7. chain definition内容/ref在create时不存在；
8. 外部typed declaration owner尚未建立。

#### 放大条件

- chain path+name或item path+name存量出现；
- chain null且path-only、无items；
- legacy null item重启、迁移或源文件改变；
- mixed-preset items顺序变化；
- external producer省略preset并期望null；
- chain-complete trigger在无itemchain运行。

#### 修补边界

- 只删除daemon default不删除target default仍保留分裂；
- 只约束new item不处理legacy/migration仍保留fallback；
- 只修改resolver不改scheduler empty gate，path-only chain仍被跳过；
- 只增加external schema不改变socket/store持久互斥与consumer，不能形成单一boundary；
- 只依赖task node ref不提供definition内容resolver，restart仍读current source；
- 只把first representative改名“canonical”不能解决mixed-preset chain-wide语义。

### B14. 事实支持的候选形态（非完备、不推荐）

以下只列事实可区分形态，**候选非完备且不推荐任何一项**：

1. **chain declaration显式携definition source/ref，item显式override**：确定后果是无item判定有独立source，但需定义mixed override与pin内容。
2. **chain完全无preset，所有行为从item派生**：确定后果是无item chain不能运行preset chain-complete，必须明确empty-chain语义。
3. **保留legacy fallback只用于迁移隔离态**：确定后果是normal runtime与migration需可观察地区分legacy行，不能静默重bind。
4. **统一resolver service供daemon/status/migration/scheduler**：确定后果是组合语义可一致，但external typed boundary与definition pin仍未自动解决。
5. **versioned external declaration先parse成单一domain ADT**：确定后果是CLI/socket/store需消费同一结果；当前无owner/artifact，不能视为已选。

### B15. 证据索引

| 主题 | 证据 |
|---|---|
| 稳定条款 | `AGGREGATE-547.md` D9、D10接缝 |
| chain create seed | `src/daemon.ts:2166-2188`; `src/loop.ts:2185-2218` |
| item XOR admission | `src/loop.ts:2117-2127`; `src/daemon.ts:3060-3084` |
| socket chain status | `src/daemon.ts:2453-2503` |
| daemon chain/item resolver | `src/daemon.ts:4422-4445,4557-4603` |
| scheduler injection/resolver | `src/daemon.ts:3685-3726`; `src/scheduler.ts:3225-3249` |
| empty-chain gate | `src/scheduler.ts:512-529` |
| target status item resolver | `src/loop.ts:3180-3218,3421-3435` |
| chain target resolver/default | `src/loop.ts:4306-4327,5561-5577` |
| v9 migration | `src/sqlite-state.ts:1034-1049` |
| legacy definition migration | `src/preset-migration-definition.ts:9-31`; `09-r4-resume-definition-pin.md` |
| resolver inventory | `/tmp/rfc547-r7-14-resolvers.txt` |
| 组合/status实验 | `/tmp/rfc547-r7-14-experiment.ts`, `/tmp/rfc547-r7-14-experiment.out` |
| direct default探针 | `/tmp/rfc547-r7-14-resolve.ts`, `/tmp/rfc547-r7-14-resolve.out` |
| external owner事实 | `13-r7-04-schema-external-consumers.md`; `13-r7-13-repository-authority-migration.md:B10` |
| R5总账 | `11-r5-supply-ledger.md:97,106,119,131,145` |

## 尾部结论

R7-14确认preset fallback不是统一兼容层：new item的per-item XOR admission真实存在，但schema/store允许null/null与both-set；daemon、socket status、target status、scheduler与legacy migration对这些组合分别采用chain fallback、empty success、global default、early skip或互斥错误。path在daemon持久态中静默压过name；无itempath-only chain能被status加载却被scheduler仅因`chain.preset=null`跳过；legacy null item在restart/migration中会重新选择当前chain/default source，放大definition rebind。外部typed chain declaration owner/schema仍无实存供给。故P-D9-1不符合、P-D9-2无供给、P-D9-3仅部分符合。报告不裁决empty-chain、mixed-preset、legacy处置或boundary载体；候选形态非完备且不推荐。
