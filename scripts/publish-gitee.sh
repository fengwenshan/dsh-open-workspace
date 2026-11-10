#!/usr/bin/env bash
# 把某个版本的插件 zip 发布到 Gitee 的 `dist` 分支（ws-workbench 的下载优先源）。
#
# 为什么用 raw 分支而不是 Gitee 发行版：
#   * 只需要 git 推送权限，不用 Gitee API 令牌，本地发版零配置；
#   * raw 直链国内下载快，且不会撞 API 限流。
# 客户端（ws-workbench 设置 → 资源）读的是：
#   https://gitee.com/<repo>/raw/dist/latest.json
#   https://gitee.com/<repo>/raw/dist/<zip>
#
# 用法：
#   scripts/publish-gitee.sh                        # 版本取自 package.json，zip 不存在就先打
#   scripts/publish-gitee.sh --version 0.2.0 --zip dsh-open-workspace-0.2.0.zip
#   GITEE_URL=... scripts/publish-gitee.sh          # 覆盖远端（CI 用带 token 的地址）
#
# 环境变量：
#   GITEE_URL  Gitee 仓库地址，默认 https://gitee.com/feng_wenshan/dsh-open-workspace.git
#              CI 里可传 https://oauth2:<token>@gitee.com/feng_wenshan/dsh-open-workspace.git
#   GITEE_BRANCH 发布分支，默认 dist
set -euo pipefail
cd "$(dirname "$0")/.."

GITEE_URL="${GITEE_URL:-https://gitee.com/feng_wenshan/dsh-open-workspace.git}"
GITEE_BRANCH="${GITEE_BRANCH:-dist}"

VERSION=""
ZIP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:?--version 需要版本号}"; shift 2 ;;
    --zip) ZIP="${2:?--zip 需要路径}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
VERSION="${VERSION#v}"
ZIP="${ZIP:-dsh-open-workspace-${VERSION}.zip}"
if [[ ! -f "$ZIP" ]]; then
  echo "找不到 $ZIP，先本地打包"
  bash scripts/build-zip.sh
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$ZIP" "$TMP/"
printf '{"version":"%s","file":"%s"}\n' "$VERSION" "$(basename "$ZIP")" > "$TMP/latest.json"

git -C "$TMP" init -q
git -C "$TMP" checkout -q -b "$GITEE_BRANCH"
git -C "$TMP" add -A
git -C "$TMP" -c user.name="dsh-open-workspace" -c user.email="noreply@example.com" \
  commit -q -m "dist: v${VERSION}"
echo "推送到 $GITEE_URL ($GITEE_BRANCH)"
git -C "$TMP" push --force "$GITEE_URL" "HEAD:${GITEE_BRANCH}"
echo "完成：https://gitee.com/feng_wenshan/dsh-open-workspace/raw/${GITEE_BRANCH}/latest.json"
