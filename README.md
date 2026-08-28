# Tampermonkey

## 微博关注列表定律 Pro

当前版本：`v0.5.1`

Tampermonkey 用户脚本。进入微博用户主页时，在后台静默扫描该用户的关注列表，并根据本地“种子黑名单”计算 Risk Score；达到阈值后自动拉黑。同时在用户主页、微博评论区和关注列表页注入一键拉黑按钮。

### 功能

- 后台静默扫描关注列表，不遮挡页面、不影响正常阅读
- Risk Score 自动判定与自动拉黑
- 自动拉黑结果不会递归污染种子库
- 用户主页注入一键拉黑按钮，并避免重复注入
- 微博评论区注入一键拉黑按钮，并支持动态加载评论
- `/u/page/follow/<uid>` 关注列表页为每个用户注入一键拉黑按钮
- 手动拉黑会加入持久种子库
- 官方微博黑名单可同步为种子
- 种子黑名单支持 JSON 导入/导出，便于账号迁移
- 支持重点种子权重、白名单、安全缓存、扫描页数配置
- 所有提示使用自定义 Toast / Modal，不使用原生 alert / prompt / confirm

### 安装

打开下面的 Raw 地址，Tampermonkey 会识别并安装：

`https://raw.githubusercontent.com/HeLingQi/Tampermonkey/main/weibo_follow_law_pro.user.js`

安装后登录微博，通过 Tampermonkey 菜单执行：

`同步微博官方黑名单 → 种子库`

### 判定逻辑

```text
Risk(user) = sum(weight(seed))
             for seed in Following(user) ∩ SeedBlacklist

Risk(user) >= threshold => block(user)
```

默认普通种子权重为 `1`，默认拉黑阈值为 `1`。

### 防止递归扩散

插件自动拉黑的人只记录为“自动拉黑结果”，不会自动成为新的种子。以下账号会成为判定依据：

- 原有/同步的人工黑名单种子
- 导入的持久种子
- 用户手动设为重点种子的账号
- 用户在主页、评论区或关注列表页手动点击插件“拉黑”按钮的账号

### 种子迁移

油猴菜单提供：

- `导出种子黑名单（迁移备份）`
- `导入种子黑名单（迁移恢复）`

导出的 JSON 会保留 UID、权重、来源和账号名称。导入采用合并模式，并将导入项目作为持久种子保存。

### 自动更新

脚本内置 `@updateURL` / `@downloadURL`，安装后由 Tampermonkey 从 GitHub `main` 分支检查更新。

### 注意

脚本使用微博 Web 页面当前使用的内部接口。这些接口不是稳定的公开 API，微博调整页面或接口后可能需要同步更新脚本。
