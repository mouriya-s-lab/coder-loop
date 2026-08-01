# RFC #545 R10：读取能力的原子地基需求

本文只从 `aggregate.md` 的 D2/D3/D7/D8/D9/D10/D14/D15、S14–S22，以及已经独立复核通过的 `r9-expected-foundation.md` 推导读取能力需要消费或自行建立的保证。它不选择实现形态，不固定尚不存在的 CLI subcommand、flag、cursor 编码或数据库机制。

## A. 一页摘要

稳定读取不是“把现有 list 暴露出去”，而是一条完整的、可恢复的授权查询边界。它至少需要同时成立：

1. **读原语与事务观察**：一次合法请求得到一个完整 typed page；entries、续页状态与本页观察结论来自同一原子观察，不能把部分响应或不同观察时点拼成成功页。
2. **身份与隔离**：daemon 从 credential 恢复 agent 的 chain 身份；caller 自报 selector 不得扩权。operator 的无凭证路径与 agent 路径是封闭主体变体。entry、scope key、author、排序键和 cursor 所引用的身份在 chain 生命周期内稳定。
3. **过滤闭集**：首版只允许 scope variant + stable key、author subject/phase、`after` cursor 和显式正整数 `pageSize`；每个维度有确定的交集语义，边界外字段被拒绝。
4. **稳定分页集合**：顺序、边界和并发 append 可见性必须形成一个公开定义。最低保证是：第一页目标集合中已存在的 entry 在续页时不漏不重；新写入是否纳入必须被明确规定，不能依赖时序偶然。cursor 必须跨请求及 daemon restart 恢复，并最终到达 `exhausted`。
5. **boundary 与大内容**：request、success response 和 failure 都经过精确边界；body 逐字返回，不截断。真实 transport 极限只能由实测和文档确认，并以显式 boundary error 暴露，不能静默缩页或伪造 exhausted。
6. **恢复**：断连、提前 end/close、不完整 response、daemon restart 后，caller 不得把残片当成功；用最后一个已确认 cursor 重试不得改变已经承诺的集合/边界语义。这里不新增 exactly-once 或 operation identity。
7. **授权与命令分类**：read 是 agent 可用的 A 域命令，但 engine event stream 仍拒绝 agent；新命令必须进入编译期穷尽分类。raw socket 伪造 chain、失活 credential、跨 chain credential 都不能突破 confinement。
8. **消费契约与证明**：socket read 的 arktype success boundary 即 GUI/hook 的只读消费契约；shape 变化必须显式列 diff。类型检查、fixture 或单页 smoke 均不足，必须用真实 CLI/socket、并发 append、restart、多页大 body 与对抗授权做等宽 runtime proof。

R9 的预期地基已经为读取能力提供了若干**修补完成后可消费**的底座：append-only chain-lifetime storage、合法 envelope exactness、权威 credential identity、合法 scope identity、socket/ADT 惯例以及真实 boundary 显式失败原则。但公开 read、分页集合定义、cursor/response boundary、read auth class 和真实读取恢复路径本身尚不存在，必须由读取能力建立。若存储不能保证合法 row exactness/不可变身份、授权不能恢复权威 chain、group 上游不能提供合法身份归属，或 transport 不能区分完整响应与残片，则不是读取实现可以在本地兜底的问题，而是对应地基尚未闭合。

## B. 原子需求

### N-R01：唯一公开读原语

- **稳定来源：** D7、D14、D15；S16、S20、S21。
- **为什么必要：** 无状态 agent、operator 与未来 GUI/hook 必须消费同一条有边界、有授权、有类型的事实面；内部全量 list 或直接读存储不能承担公开合同。
- **消费方式：** agent 经 credential socket 路径读取；operator 经无凭证 operator 路径读取；GUI/hook 只消费相同返回 boundary，不另定义读取语义。
- **保证：** 一个请求只产生“完整 typed success page”或“明确 typed failure”，不存在半页成功、文件系统旁路或第二套隐式读取合同。

### N-R02：单页原子观察

- **稳定来源：** D7、D10、D14；S18、S20；F-04 的稳定集合要求。
- **为什么必要：** page entries、续页边界和 `nextCursor | exhausted` 若来自不同观察时点，会在并发 append 下产生漏读、重复或伪 exhausted。
- **消费方式：** caller 把一个成功 page 当作不可拆分的确认单位；只有完整确认后才推进 cursor。
- **保证：** 同一 success page 的 entries、排序边界与续页状态来自同一原子观察。这里要求事务语义结果，不预裁数据库 transaction、snapshot 或锁的实现形态。

### N-R03：权威调用者身份

- **稳定来源：** D3、D7、D14；S15、S16、S21。
- **为什么必要：** chain 是隔离边界；若 chain 身份来自 request selector 或 CLI 自觉，raw socket caller 可越权。
- **消费方式：** daemon 从 agent credential 得出 caller chain/run identity；operator 走独立封闭 variant。显式 selector只能被核验、忽略或拒绝，不能扩权。
- **保证：** agent 结果恒限 credential chain；operator 可明确选择任意 chain；失活、跨 chain 或伪造 credential 不产生数据。

### N-R04：稳定 entry 与排序身份

- **稳定来源：** D2、D10、D14；S14、S18、S20；F-01/F-03。
- **为什么必要：** keyset cursor 只有在 entry 身份和排序位置跨请求、迁移与 restart 不变时才能恢复。
- **消费方式：** filter、ordering 与 cursor 都引用持久且精确解析的 identity；caller 不需要理解其具体编码。
- **保证：** 合法 entry 的身份、归属和排序所需字段在其生命周期内不可变且无歧义；同一排序位置必须有稳定破平局依据。具体字段组合不是本报告的要求。

### N-R05：scope 过滤身份

- **稳定来源：** D2、D3、D14；S14；F-01/F-06。
- **为什么必要：** item、chain、group 是不同查询含义；虚空、跨 chain 或非成员 group key 不能通过读面变成有效身份。
- **消费方式：** caller 选择封闭 scope variant，并在该 variant 需要时提交合法 stable key；daemon 在权威 chain 内解析。
- **保证：** item 命中同一 item 谱系跨 run/phase entries；chain 命中同 chain 跨 item entries；group 仅按并行结构层给出的权威容器身份/归属过滤；跨 chain 零可见。读取能力不得从 ancestry 自造 group membership。

### N-R06：author 过滤身份

- **稳定来源：** D3、D10、D14；S17、S20；F-03。
- **为什么必要：** author subject/phase 是稳定闭集过滤维度，必须基于 credential-derived persisted author，而非 caller 自报或 body 解析。
- **消费方式：** caller 可按合同组合 author subject/phase filter；daemon 对合法 persisted author 精确匹配。
- **保证：** author filter 命中/不命中确定；缺省与显式 filter 的含义明确；不引入自由字符串身份或内容搜索。

### N-R07：查询闭集与组合语义

- **稳定来源：** D10、D14、D15；S17、S20、S22。
- **为什么必要：** 隐藏 filter、自由查询串或松散 JSON 会让不同消费者得到不同集合，并使接口无法穷尽演进。
- **消费方式：** request 仅使用 scope、author subject/phase、`after` 和显式正整数 `pageSize`；合法过滤组合以确定的交集语义作用于同一目标集合。
- **保证：** boundary 外字段、非法 variant、非正 `pageSize` 和不合法组合在解析入口拒绝；无 topic/tag、offset、默认 magic limit或隐藏参数。

### N-R08：公开顺序与 cursor 边界

- **稳定来源：** D10、D14；S17、S18、S20；F-04。
- **为什么必要：** `after`、下一页和 exhausted 只有相对于一个稳定全序及排他/包含边界才有意义。
- **消费方式：** caller 把 cursor 当 opaque continuation token，只复用 boundary 返回值，不自行构造或解释。
- **保证：** 合同定义稳定全序、`after` 边界和 cursor 与 filter/chain 的有效关系；篡改、跨 chain、与请求不相容或格式非法的 cursor 明确失败。具体 token representation 不在需求内。

### N-R09：并发 append 下的集合定义

- **稳定来源：** D10；S18；F-04 明确留下的 concurrent append 可见性定义。
- **为什么必要：** 仅说“keyset”不能回答页间新 entry 是否属于本次遍历；未定义会使相同调用因时序偶然漏读、重复或永不 exhausted。
- **消费方式：** caller 可按公开合同遍历一个稳定目标集合，并知道遍历开始后 append 的 entry 属于本次还是下次读取。
- **保证：** 第一页目标集合中已有 entry 在续页时不漏不重；页间新写入的纳入/排除规则必须明确且可测；持续 append 不能破坏有限目标集合到达 exhausted。读取能力负责建立此合同，不把某种 snapshot 实现写成需求。

### N-R10：显式分页完成态

- **稳定来源：** D10、D14；S18、S20。
- **为什么必要：** 空页、最后一页和被 transport 缩减的页若不能区分，caller 无法证明已读尽。
- **消费方式：** caller 持续提交 boundary 返回的 cursor，直到收到封闭的 `nextCursor | exhausted` 之一。
- **保证：** 每个 success page 恰有一种续页状态；无总结果截断、无静默缩页、无默认页长；合法有限目标集合最终 exhausted。

### N-R11：request/success/failure 精确 boundary

- **稳定来源：** D9、D14、D15；S16、S17、S20、S22；F-02/F-03/F-04。
- **为什么必要：** GUI/hook 与 CLI 需要同一个可解析合同；匿名 shape 或字符串错误会掩盖 boundary、授权和 persisted-data failure 的差异。
- **消费方式：** 外部输入在入口解析为精确 ADT，内部穷尽流转；success JSON 经过 arktype boundary，failure 以调用方可识别的明确类别返回。
- **保证：** malformed request、unauthorized、invalid cursor/filter、persisted boundary failure、真实 transport boundary 与不完整响应不冒充空结果或 exhausted。本文不预造具体错误码或 JSON 字段。

### N-R12：大 body 与真实 transport boundary

- **稳定来源：** D9、D10、D14；S18、S20；F-02/F-04。
- **为什么必要：** entry body 不透明且可能很大；读取若截断 body、暗缩 page 或用任意 cap，会破坏逐字共享和分页完成性。
- **消费方式：** caller 得到完整 body，或得到点名真实外部限制的显式 boundary failure，并可用最后确认 cursor 恢复。
- **保证：** body 逐字返回、不截断；不存在 context 自造 cap；真实单响应限制须经实测和文档确认，越界不返回部分 success、不伪造 next/exhausted。

### N-R13：断连与不完整响应恢复

- **稳定来源：** D7、D10、D14；F-02/F-04/F-10。
- **为什么必要：** socket 提前 end/close、daemon restart 或 response 未齐时，caller 必须知道本页未确认，否则会推进 cursor 并漏数据。
- **消费方式：** caller 只在完整 boundary success 后保存新 cursor；失败后使用最后一个已确认 cursor 重发。
- **保证：** 残片明确失败且不挂起；cursor 和目标集合语义跨 daemon restart 可恢复；重发不会因为失败残片造成对已承诺集合的漏读或重复确认。本条不要求 exactly-once、operation identity 或 durable read session。

### N-R14：命令域与授权分类穷尽

- **稳定来源：** D7、D14；S21；F-05。
- **为什么必要：** 当前 agent 可读的 A 域与 agent 禁止的 event stream B 域必须保持分离；命令清单漂移不能把 agent 请求降级成 operator。
- **消费方式：** 每个 read command variant 在编译期进入唯一、穷尽的 auth class，并由 daemon 执行对应身份解析。
- **保证：** agent read 可用；agent event stream 仍硬拒绝；新增或变更命令若未分类由类型/守卫暴露，而不是落入 permissive default。

### N-R15：prompt 零内容与可执行读取寻址

- **稳定来源：** D8、D14；S19；F-08。
- **为什么必要：** pull 模型要求无状态 agent 知道如何发起真实读取，但不能把现有 entry body 偷渡进 prompt。
- **消费方式：** 声明 capability 的 phase 获得与最终真实 boundary 一致的 read 用法；自动推导参数明确无需填写，显式 stable key 提供当前合法值，无合法 scope 明确不可用。
- **保证：** agent 不猜 key、不合成不存在的 scope、不 fallback；任何 entry sentinel 在所有 phase prompt 中零命中；prompt handle 不产生授权。

### N-R16：消费契约演进

- **稳定来源：** D14、D15；S16、S20、S22。
- **为什么必要：** read success boundary 是未来 GUI/hook 的直接依赖，shape 暗变会制造跨 RFC 破坏。
- **消费方式：** CLI、GUI、hook 与测试共同消费一个命名 typed boundary；新增真实场景通过 ADT 字段/variant演进。
- **保证：** 首版不预埋 topic/tag 或松散扩展袋；shape 变化在 PR body 明列 diff，并同步 parser、穷尽消费者与 runtime proof。

### N-R17：等宽 runtime proof

- **稳定来源：** S14–S22；F-04/F-05/F-08/F-10。
- **为什么必要：** unit、typecheck、fixture 和内部 list 不能证明真实 socket 身份、并发、恢复、大 response 或 prompt 不泄漏。
- **消费方式：** 冻结 SHA 上运行可重放的真实 CLI/socket 场景并观察 typed response、最终集合和拒绝结果。
- **保证：** 至少覆盖 item 跨 run、chain 跨 item、跨 chain零可见；operator/agent/raw socket/失活 credential；每个 filter 命中与不命中；同排序位置、多页、页间前后边界 append、持续翻页至 exhausted；断连和 restart；多页大 body与真实 boundary failure；all-phase sentinel；编译期分类与 boundary parser。group 读取只有在 F-06 的真实上游身份和 producer闭合后，才能用真实 branch 路径证明。

## C. Foundation F-01～F-10 匹配

状态含义：

- **直接供：** R9 已定义稳定保证；对应修补和 runtime proof 完成后，读取能力直接消费，不在读取面重复建立。
- **修补后供：** foundation 已给出所需合同，但当前实然不成立；地基拥有者必须先修补闭合。
- **消费自建：** foundation 只规定目标，公开 read 能力本身负责建立合同与证明。
- **地基缺：** 读取能力无法本地补偿；上游未闭合前相关需求不能宣称完成。

| Foundation | 状态 | 供给/缺口 | 对应需求 |
|---|---|---|---|
| F-01 Storage authority / lifecycle | 修补后供 | append-only、chain lifetime、合法 item/scope引用与不可绕过 authority 是读取稳定身份的前提。若仍可产生悬空/跨 chain entry，N-R04/N-R05 不能由 reader 清洗兜底。 | N-R04、N-R05、N-R13 |
| F-02 Append / audit / transport | 修补后供 + 消费自建 | 写侧 body/真实 boundary/异常不挂起原则可复用；读侧完整 response、残片失败和从最后确认 cursor 恢复必须自行建立。 | N-R11–N-R13 |
| F-03 Persisted exactness | 修补后供 | 合法 row 精确解析、body保真、malformed 明确失败是 read boundary 的输入前提。生产存量是否清洁不是 reader 可假定事实。 | N-R04、N-R06、N-R11、N-R12 |
| F-04 Read pagination / response | 消费自建 | 公开 read、filter、稳定集合、并发 append定义、cursor、typed response 与 exhausted 全部属于读取能力自身。Foundation 给的是验收合同，不是已存在实现。 | N-R01、N-R02、N-R07–N-R13、N-R16、N-R17 |
| F-05 Read authorization / classification | 消费自建；identity 底座修补后供 | daemon credential authority/typed auth惯例可消费；chain-bound read class、operator/agent路径、对抗与命令穷尽由读取能力建立。若 credential 不能恢复权威 chain，则为地基未闭合。 | N-R03、N-R11、N-R14、N-R17 |
| F-06 Group 合法身份消费 | 地基缺（对 group read） | 并行结构层尚未供给合法 source 数学、权威容器 identity/归属及真实 producer。读取能力只能消费结论，不能从 ancestry推导。item/chain read不被此缺口阻塞。 | N-R05、N-R17 |
| F-07 Finalize / outcome | 直接供但读取不依赖 | required-read 明确范围外；普通 read 不参与 outcome/finalize。读取不得借此发明“已读”证明。 | E 节 |
| F-08 Prompt executable addressing | 消费自建；group 部分受 F-06 阻塞 | 最终 read boundary 存在后，读取能力须提供真实可执行文档并做 sentinel/命令正向证明；无合法 group 时明确不可用。 | N-R15、N-R17 |
| F-09 Docs / `shared.md` coexistence | 直接供 + 消费自建 | 并存边界直接消费；read boundary、help/docs一致性和未来 consumer shape diff由读取能力维护，不改 `shared.md`。 | N-R16、N-R17 |
| F-10 Pure proofs / integrated evidence | 消费自建 | typed filter/cursor纯证明和同 scope runtime路径都由读取能力交付；fixture/typecheck不能替代 socket、并发、restart。 | N-R17及全部需求的证明 |

### C1. 读取能力自己必须闭合

- 公开 socket read 原语及精确 request/success/failure boundary；
- filter 闭集与组合语义；
- 稳定全序、cursor 边界、并发 append 集合定义和最终 exhausted；
- 单页原子观察及断连/restart恢复合同；
- chain-bound agent read、operator read、命令穷尽分类；
- prompt 中真实 read 用法但零 entry 内容；
- GUI/hook 可消费的 boundary演进纪律；
- 与上述主张等宽的 runtime proof。

### C2. 未闭合就必须停止外推的地基

- F-01/F-03 未保证合法、不可变、chain-bound persisted identity；
- F-05 所依赖的 credential authority 无法稳定恢复 caller chain或仍有 permissive fallback；
- F-06 未给出真实 group identity/归属与 producer，却试图宣称 group read；
- transport 无法区分完整 response 和残片，或真实极限仍被静默截断；
- cursor依赖仅存于进程内、daemon restart后无法恢复，却宣称稳定分页。

## D. 不得依赖当前缺陷或不存在机制

1. 不得把当前内部 chain 全量 list 当公开 read API、分页合同或 GUI boundary。
2. 不得依赖 `read-no-auth`、CLI 自动附带 selector、caller 自觉不越 chain，或遗漏命令后的 operator fallback。
3. 不得依赖不存在的 read command、context capability doc、group resolver/membership、真实 `par` producer或 GUI consumer。
4. 不得从 runtime tree 可表达 ancestry、fixture 的多个祖先或 stable node shape推导 group membership集合/基数。
5. 不得把 `createdAt,id` 等当前可见字段组合直接升格为 cursor合同；只要求稳定全序和可恢复边界。
6. 不得依赖单响应“目前测过很大”推导无限 transport，亦不得自造保守 cap、静默缩页或截断 body。
7. 不得假设页间新写入天然纳入或天然排除；必须先定义集合。
8. 不得用 prompt handle、chain selector、entry id或 cursor当 capability；daemon 必须独立鉴权。
9. 不得用 malformed row 跳过、自动清洗或 partial tolerance补偿 F-03 未闭合；这不是已授权产品需求。
10. 不得用 unit/typecheck、fixture、静态零引用、单页 smoke或旧 real-e2e证明真实授权、分页、并发、恢复或内容零注入。

## E. 范围外

- required-read、“必须读”outcome、读取次数或读取质量执法；
- exactly-once read、operation identity、durable read session、server-side session TTL/cleanup；
- cursor具体编码、具体数据库 transaction/snapshot/lock 机制、具体 CLI subcommand/flag；
- topic/tag、offset、自由查询串、全文搜索、跨 chain查询、`run` scope；
- nested `par` 数学、membership基数、并行 identity producer；
- GUI展示行为与 hook 专用语义；两者只消费普通 read boundary；
- response 任意自造 cap、malformed persisted row逐行容错或自动清洗；
- `shared.md`、evidence、transition、GitHub持久事实或业务语义改造；
- 将 entry body内容、摘要或 sentinel 注入 prompt。

## F. 证据索引

| 证据 | 本报告使用位置 |
|---|---|
| `aggregate.md:18-31`（D2/D3/D7/D8/D9/D10/D14/D15） | scope/身份、授权、socket、pull模型、大内容、过滤分页、ADT与消费边界 |
| `aggregate.md:66-78`（S14–S22） | 读取面的逐项可观察验收 |
| `aggregate.md:126-145` | 外部 group identity/producer依赖及 GUI/hook read boundary供给 |
| `aggregate.md:186-195` | 不从 ancestry自造 membership、prompt寻址合同、范围外边界 |
| `r9-expected-foundation.md:36-124`（F-01～F-10） | 修补后可消费保证、当前未知、runtime proof与不得依赖项 |
| `r9-expected-foundation.md:126-146` | 输入到 Foundation 的反向覆盖 |
| `r9-independent-review.md` A/B2/B5/D | R9 PASS、R10 可消费性与仍未闭合未知项 |

本报告没有读取旧 issue 或源码，也没有从实现现状生成新的读取需求。
