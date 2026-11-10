#!/usr/bin/env bash
# 本地按当前 package.json.version 打 zip；CI 的 release.yml 用同样规则。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
OUT="dsh-open-workspace-${VERSION}.zip"
rm -f "$OUT"
zip -r "$OUT" package.json cordis.patch.yml lib README.md
echo "built $OUT"
unzip -l "$OUT"
