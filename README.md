# dsh-open-workspace

ws-workbench 点「打开方式 → DeepSeek」时用的小插件：读取 `$DSH_HOME/open-workspace.json`
里的目录，把它交给 DSH 的 workspace 服务——左侧没有就新增，有就选中，并打开该工作区的空白新会话。

- 不联网、零外部依赖；host 半只注册两个 GET 路由（`/dsh-open-workspace/poll`、`/dsh-open-workspace/status`）。
- 请求文件 10 分钟内有效；过期、坏 JSON、目录不存在都会被直接丢弃。
- 装好后需要**重启一次** DeepSeek Harness 才会加载。

## 安装

ws-workbench 安装包里带这个插件：缺插件时点「打开方式 → DeepSeek」会弹窗确认后自动安装
（复制到 `$DSH_HOME/profiles/desktop/node_modules/` 和 `$DSH_HOME/plugins/`，并改 desktop
profile 的 `dsh.profile.bundles`；首次安装备份 `package.json`）。

也可以手动装：

```bash
scripts/dsh-plugin-install.sh            # 安装 / 更新（DSH 关掉后执行更稳）
scripts/dsh-plugin-install.sh --uninstall
```

## 调试

重启 DSH 后，在页面里打开 `/dsh-open-workspace/status` 看插件版本和最近一次请求；
没有反应时先看 `$DSH_HOME/open-workspace.json` 是否还在、`$DSH_HOME/profiles/desktop/package.json`
里有没有 `dsh-open-workspace`。

## 版本与发布

- 版本号就是 `package.json` 的 `version`；tag 必须写成 `v<version>`（如 `v0.1.0`）。
- 发布：`git tag -a v0.2.0 -m "v0.2.0" && git push origin main --tags`。
- GitHub Actions 在 tag push 后自动：
  1. 校验 tag 与 `package.json.version` 一致；
  2. 打 `dsh-open-workspace-<version>.zip`（根目录含 `package.json`、`cordis.patch.yml`、`lib/`、`README.md`）；
  3. 创建 Release 并上传 zip。
- ws-workbench 的「设置 → 资源」从 GitHub Release `latest` 读取版本并下载该 zip 安装。
- 本地打包：`scripts/build-zip.sh`（产物不入库，`.gitignore` 已忽略 `*.zip`）。
