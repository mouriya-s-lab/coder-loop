# code 与 app 目录的读写边界

操作员维护两份 coder-loop：

| 路径 | 角色 | 默认权限 |
|---|---|---|
| `/Users/mouriya/Ext/code/coder-loop` | 迭代开发用（本仓库） | 可读写 |
| `/Users/mouriya/Ext/app/coder-loop` | 运行用 | 只读 |

## 规则

- 所有开发、调试、测试工作在 `code/coder-loop` 完成。
- `app/coder-loop` 禁止修改，除非用户在当轮对话中明确授权（"去 app 下更新"、"同步到 app" 等）。
- 授权仅对当次操作有效，不可延伸到后续操作。
- 迭代完成后需要同步到 app 时，由用户主动发起，不要主动提议或自动执行。

## 本规则禁止

- 未经授权向 `app/coder-loop` 写文件、改文件、删文件。
- 把 `app/coder-loop` 当作测试环境运行任何会产生副作用的命令。
- 在用户说"更新 app"时，超出同步范围做额外修改。

## 读取 app 目录

读取 `app/coder-loop` 是允许的——用于对比版本差异、确认运行状态、排查故障。只要不产生写入副作用即可。
