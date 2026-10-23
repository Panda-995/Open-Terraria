#!/bin/sh
# root 启动时把 /data 收权给 node(uid 1000)再降权运行；非 root(用户已指定 user:)直接运行。
# 与 homeledger 部署同款坑：bind mount 的宿主目录默认 root 属主，node 直跑会 EACCES。
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data 2>/dev/null || true
  exec su -s /bin/sh node -c "exec $*"
fi
exec "$@"
