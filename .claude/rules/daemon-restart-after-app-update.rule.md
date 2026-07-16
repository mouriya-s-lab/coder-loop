# app 更新后必须重启 coder-loop daemon

中央 daemon 跑的是 `/Users/mouriya/Ext/app/coder-loop`（PATH 上的 `coder-loop` wrapper 固定 exec 该路径；dogfood 架构：app 的 daemon 调度 code 的迭代）。bun 在进程启动瞬间把代码加载进内存，**之后磁盘上的文件再怎么变都不影响运行中的进程**——app pull 完不重启 = 新代码躺在磁盘、旧 daemon 继续跑。

- 每次同步 / pull `app/coder-loop` 之后，立即重启中央 daemon：先杀旧进程（pid 在 `~/.coder-loop/loop-data/daemon.pid`，杀前 `ps -p <pid>` 验证它真在跑），再 `coder-loop daemon up --detach` 起后台进程（fork 后立即返回 pid，PPID=1 已 reparent；不带 `--detach` 是前台阻塞形态，供 launchd / systemd / e2e 用）。CLI 里另有 `coder-loop queue unblock <target> --issue <issue> --start-daemon` 会在 mutation 成功后顺带 spawn detached daemon，agent 侧的常见路径就是这条。
- 活性判断不要信 `coder-loop status --json` 的 `daemon` 字段——daemon 活着它也可能返回 null；可靠判据是 `lsof ~/.coder-loop/loop-data/daemon.sock` 有进程在监听，且 pid 文件与 `ps` 对得上。
- `daemon.sock` / `daemon.pid` 可能是死进程的陈尸文件（进程异常退出不清理），**文件存在 ≠ daemon 在跑**。

Why: 进程的代码快照定格在启动瞬间，「磁盘新、内存旧」的错位会让刚合并的修复（如 #423 的反杀修复）看似已部署、实则没生效，且这种失效完全无报错。
