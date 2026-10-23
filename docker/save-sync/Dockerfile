# syntax=docker/dockerfile:1
FROM node:24-alpine
WORKDIR /app
COPY server.mjs entrypoint.sh ./
RUN chmod +x entrypoint.sh
ENV DATA_DIR=/data PORT=8787
VOLUME /data
EXPOSE 8787
# 绑定卷可能 root 属主（首次 up 的目录/named volume），entrypoint 以 root 收权后降 node 运行
USER root
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8787/healthz || exit 1
ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "server.mjs"]
