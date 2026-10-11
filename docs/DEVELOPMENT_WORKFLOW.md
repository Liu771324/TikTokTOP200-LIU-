# How to：开发、合并和推送一个工具

按这个流程在隔离分支里开发一个工具，把完成的工具合并进总仓 `main`，并推送到 GitHub。

工具箱第一版先阅读[技术方案](TOOLBOX_V1_PLAN.md)和[接口约定](TOOLBOX_V1_CONTRACTS.md)，再按[实施清单](TOOLBOX_V1_EXECUTION.md)逐阶段执行。阶段完成需写实际验证证据，不能以文档编写、界面占位或打包成功替代业务验收。

## 开始前

- 在 `D:\前端\ai\Script All` 仓库根目录操作。
- 确认本地改动已提交，或已妥善保存；不要切换分支时带着不清楚归属的改动。
- 先阅读目标工具目录中的 README 或使用说明。每个工具的运行依赖和验证方式可能不同。

## 为新工具创建开发分支

先把本地 `main` 快进到远端当前版本，再从 `main` 创建临时分支：

```powershell
$ToolBranch = "codex/search-term" # Replace with the tool's branch name.
git fetch origin
git switch main
git merge --ff-only origin/main
git switch -c $ToolBranch
```

例如，搜索词工具的分支可以命名为 `codex/search-term`。已有开发分支则运行 `git switch $ToolBranch` 继续开发。当前工具箱开发不执行这里的新建分支步骤，继续使用 `codex/ecommerce-tool-library`。

分支包含整个仓库的快照。开发分支用于隔离修改和审查，工具源码仍放在自己的目录里；合并后，工具留在 `main` 的目录中。

## 开发和提交

1. 只修改阶段目标涉及的工具、公共模块和必要的总仓索引、文档或忽略规则。
2. 新工具放进独立目录，并添加 README，写明用途、系统要求、依赖、启动方式和数据位置。
3. 独立工具按自己的说明验证；工具箱迁移同时通过工具自身回归和公共任务、存储、浏览器测试。公共测试命令在实际实现后补入实施清单。
4. 检查变更范围，再明确指定要提交的文件：

   ```powershell
   git status --short
   git add "Search term" README.md docs
   git commit -m "feat(search-term): improve search term tool"
   ```

   示例针对 `Search term`。提交其他工具时，把路径、提交摘要换成实际内容；如果没有修改 README 或 `docs`，从 `git add` 命令中去掉对应路径。不要使用 `git add .` 把用户表格、运行数据或构建产物一并加入。

## 合并到 main 并推送

整个开发目标完成并通过对应验收后，同步主线，再把开发分支合并进 `main`。文档阶段不提前合并或推送。下面的同步过程保留历史，不强推：

```powershell
$ToolBranch = "codex/search-term" # Use the branch being merged.
git fetch origin
git switch $ToolBranch
git merge main
git merge origin/main
# Resolve any conflicts and verify affected behavior before continuing.
git switch main
git merge --ff-only $ToolBranch
git push origin main
```

推送成功后再删除本地开发分支：

```powershell
$ToolBranch = "codex/search-term" # Use the branch that was merged.
git branch -d $ToolBranch
```

先合并、再推送、最后删分支。合并命令逐条执行；出现冲突或失败即停止后续步骤，不能带着未解决状态继续切分支。若推送失败或合并提示不能快进，保留开发分支，先同步并处理主线的新提交，再重新合并；不要用强制推送覆盖远端历史。

## 当前仓库级整理

当前工作分支是 `codex/ecommerce-tool-library`，用于完成电商桌面工具箱第一版。本地 `main` 已包含初始整理基线 `ac7594d`，后续文档和实现继续在当前分支分步提交。四工具及公共能力全部验收完成后，才将后续提交合并到 `main`、推送 `origin main`，推送成功后再删除该分支。

## 完成检查

- 目标工具的源码和使用说明都在自己的目录中。
- 总 README 能找到该工具及其入口说明。
- 变更没有意外包含真实业务表格、运行数据、日志、缓存、依赖目录或本机打包产物。
- 工具专属的构建或验证按工具自己的说明完成。
- 工具箱首批范围完成实施清单的必需验收，未验证项和不支持的可选页面有明确记录。
- 推送成功后，本地 `main` 与 `origin/main` 指向同一提交，开发分支已删除。

## 常见情况

- **`git switch` 提示有未提交改动**：先检查 `git status --short`，提交相关改动或明确保存后再切换。
- **`git merge --ff-only` 无法快进**：开发分支和 `main` 已分叉。先在开发分支同步 `main` 并解决冲突，再重试合并。
- **`git push` 被拒绝**：保留开发分支，重新 `git fetch origin` 并同步主线后再推送；不要强推。
- **推送被自动审批拒绝**：保留本地提交，记录被拒绝的动作及理由，不使用其他通道绕过审批。
