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
服务端无需挂载存档目录。清除浏览器数据或更换域名/端口会改变浏览器存储空间。

## 更新

    docker compose pull
    docker compose up -d

需要固定版本时，将 latest 改为 Actions 输出的 sha-完整提交号或 sha256 digest。

## 本地构建

    docker build -t open-terraria:local .

Docker 构建使用已提交的语言包、图集和 WASM，重建 ZIP 包后运行上游资源审计、
资源新鲜度检查、src TypeScript 检查以及 Vite 构建。仓库外的语言包原始分片不存在时，
只跳过其自动再生成，语言键完整性和形状审计继续执行。
完整站点资源保留在镜像中，没有执行上游依赖 Service Worker 的散件裁剪。
GitHub Actions 对两个架构均执行容器 HTTP 冒烟检查，ARM64 使用 QEMU。
镜像发布使用 GitHub 自动生成的 GITHUB_TOKEN，个人访问令牌不会提交到仓库。

## 资源许可

工程代码与 Terraria 游戏资产的许可范围不同，见 LICENSE、ASSETS.md；
镜像内 /licenses/ 保留了这两份声明。
