#!/bin/sh
# 无头 Chrome 启动包装：本机的文件沙箱不允许 Chrome 自己初始化沙箱，
# 因此这里统一加上 --no-sandbox（只用于离线截图与录屏）。
# 用法：CHROME_PATH="$PWD/scripts/chrome-headless.sh" node scripts/capture.mjs ...
exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --no-sandbox --disable-crashpad --disable-breakpad --disable-dev-shm-usage "$@"
