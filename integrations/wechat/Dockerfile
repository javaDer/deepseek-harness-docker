# syntax=docker/dockerfile:1.7
# WeChat Bridge: the only container that talks to the WeChat account, and it talks to DSH only over HTTP.
# It has no npm dependencies, so there is no install step and no lock to keep in sync.
ARG NODE_IMAGE=docker.io/library/node:24-trixie
FROM ${NODE_IMAGE}
USER root
ENV NODE_ENV=production \
    WECHAT_BRIDGE_PORT=8787 \
    WECHAT_BRIDGE_DATA=/data \
    WECHAT_BRIDGE_TOKEN_FILE=/run/secrets/wechat-bridge-token
RUN mkdir -p /app /data && chown node:node /app /data
WORKDIR /app
COPY --chown=node:node integrations/wechat/package.json ./
COPY --chown=node:node integrations/wechat/src ./src
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WECHAT_BRIDGE_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/src/main.js"]
