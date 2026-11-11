# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# proxy_ca is optional for ordinary Docker Desktop builds. Managed environments
# can supply their CA as a BuildKit secret without putting it in an image layer.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    QQ_SERVICE_CONTAINER=1 \
    QQ_SERVICE_HOST=0.0.0.0 \
    QQ_DASHBOARD_PORT=3210 \
    QQ_DASHBOARD_DATA_DIR=/data
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY src ./src
COPY public ./public
COPY examples/plugins ./examples/plugins
COPY examples/mcp ./examples/mcp
COPY docs/MCP.md ./docs/MCP.md
COPY docs/assets/mcp-services.png ./docs/assets/mcp-services.png
COPY scripts/docker-healthcheck.mjs ./scripts/docker-healthcheck.mjs
RUN chmod -R a+rX /app && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "scripts/docker-healthcheck.mjs"]
CMD ["node", "src/server.mjs"]
