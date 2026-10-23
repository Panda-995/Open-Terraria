# Docker 部署

提供 linux/amd64 和 linux/arm64 镜像，Docker 会自动选择宿主机架构。
这是网页版游戏的静态站点部署。上游多人服务端尚未包含在此镜像中。

## 启动

镜像地址：ghcr.io/panda-995/open-terraria:latest

GHCR 新包默认可能为私有。若拉取提示 denied，请先登录，不需要将令牌写入 Compose：

    export GITHUB_TOKEN='具有 read:packages 权限的 GitHub 令牌'
    printf '%s' "$GITHUB_TOKEN" | docker login ghcr.io -u Panda-995 --password-stdin
    unset GITHUB_TOKEN
    docker compose up -d

访问 http://服务器IP:8080 。修改 compose.yaml 左侧端口即可更换宿主端口。
使用域名访问时，项目会自动跳转 HTTPS，请通过反向代理配置有效 HTTPS。
镜像保留完整散件资源，因此未启用 Service Worker 的局域网 HTTP 也能读取素材。

游戏世界和角色保存在访问者浏览器中，建议定期在游戏内导出存档。
清除浏览器数据或更换域名/端口会改变浏览器存储空间。
启用下述云存档中继后，存档会自动同步到服务端，换浏览器/换电脑自动跟随。

## 云存档中继（fork 增强）

上游为纯静态站，存档只存在于访问者浏览器（IndexedDB）。此 fork 附带一个
轻量同步服务（ghcr.io/panda-995/open-terraria-sync），compose 默认已配好：

    services:
      open-terraria-sync:
        image: ghcr.io/panda-995/open-terraria-sync:latest
        volumes:
          - ./data:/data     # 存档文件落在这里——这就是可备份/迁移的存档目录

    docker compose up -d

工作机制：

- 游戏页面注入 public/save-sync.js：开机（游戏主模块加载前）与云端清单做
  三方合并写回浏览器，运行中每 10 秒把有变化的键推送上云。同步链任何失败
  都不阻断游戏本体（服务不可达时本地存档照常）。
- 同步面：世界/角色/快存档/界面偏好（IndexedDB 'sandboxworld' 库的
  `sandboxworld.*` 与 `sbw.*` string 键）。素材包/mod 包/重制素材不同步。
- 冲突策略：键级「云端优先 + 本地留底」——双端同改时本地版先上传
  `__conflict.<时间戳>.<键名>` 留底（可在 ./data 里找到），再落云端版，不丢数据。
- 服务端整体清空而浏览器仍有存档时，视为重置：不做删除，全量重新播种。

多人同机不同浏览器各玩各的：给每人一个独立 slot。部署方创建 ./sync-config.js
（compose 中已留注释行）并在浏览器端配合：

    window.SAVE_SYNC_CONFIG = { token: '与 SYNC_TOKEN 一致', slot: 'default' };

挂载后取消 compose 中 open-terraria 服务的 volumes 注释。slot 也可按浏览器
在控制台临时设置：`__saveSync.setSlot('名字')` 后执行 `__saveSync.resync()`。

公网暴露部署时强烈建议启用令牌：sync 服务设 `SYNC_TOKEN` 环境变量，并在
save-sync-config.js 里配同一值。仅局域网使用可不设。

web 镜像单独运行（不启动 sync 服务）完全兼容：nginx 对 /sync/* 只是 502，
游戏与本地存档零影响。

### 迁移/备份存档

直接备份 ./data 目录即可（纯 JSON 文件 + manifest.json）。换服务器时把
./data 整目录带走，所有浏览器下次打开游戏即自动合并回来。

## 更新

    docker compose pull
    docker compose up -d

需要固定版本时，将 latest 改为 Actions 输出的 sha-完整提交号或 sha256 digest。

## 本地构建

    docker build -t open-terraria:local .
    docker build -t open-terraria-sync:local docker/save-sync

Docker 构建使用已提交的语言包、图集和 WASM，重建 ZIP 包后运行上游资源审计、
资源新鲜度检查、src TypeScript 检查以及 Vite 构建。仓库外的语言包原始分片不存在时，
只跳过其自动再生成，语言键完整性和形状审计继续执行。
完整站点资源保留在镜像中，没有执行上游依赖 Service Worker 的散件裁剪。
GitHub Actions 对两个架构均执行容器 HTTP 冒烟检查，ARM64 使用 QEMU。
镜像发布使用 GitHub 自动生成的 GITHUB_TOKEN，个人访问令牌不会提交到仓库。

## 资源许可

工程代码与 Terraria 游戏资产的许可范围不同，见 LICENSE、ASSETS.md；
镜像内 /licenses/ 保留了这两份声明。
