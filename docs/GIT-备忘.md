# 小卜 · Git 配置备忘

> 记录本仓库的 Git 身份、远端与常用操作。改配置后请同步更新本文件。

## 身份（全局 `~/.gitconfig`）

```
user.name  = liuRan-A
user.email = 334571478+liuRan-A@users.noreply.github.com
```

> 用 GitHub 的 noreply 地址对外隐藏真实邮箱；数字为账号 ID。

## 仓库

| 项 | 值 |
| --- | --- |
| 本地路径 | `c:\Users\LENOVO\WorkBuddy\2026-10-09-15-08-16\xiaobu` |
| 远端 origin | `git@github.com:liuRan-A/-.git`（SSH；改名后为 `git@github.com:liuRan-A/xiaobu.git`） |
| 分支 | `main` ↔ `origin/main`（已建立跟踪） |
| 首次提交 | `f27029b` |
| 认证方式 | SSH Key 已就绪（`ssh -T git@github.com` → `Hi liuRan-A!`），无需 Token |

## 日常命令

```bash
git status            # 查看改动
git add <文件…>        # 暂存（避免 git add -A 误带文件）
git commit -m "说明"   # 提交（身份已配好，无需 -c）
git push              # 推送到 GitHub
git pull              # 拉取远端更新
git remote -v         # 查看远端
```

## 忽略规则要点（`.gitignore`）

```
node_modules/  dist/  export/  server/.env  __pycache__/
android/  ios/  vite.config.ts.timestamp-*.mjs
```

> `server/.env` 存放密钥，永不入库（已确认未被跟踪）。

## 改名后需执行

```bash
git remote set-url origin git@github.com:liuRan-A/xiaobu.git
```
