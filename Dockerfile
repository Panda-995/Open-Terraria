# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=6144
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Use tracked language packs, atlases and WASM without the author's external assets.
RUN node scripts/stamp-build.mjs \
    && node scripts/pack-assets.mjs \
    && npm run test:audit \
    && npm run test:assets-guard \
    && npx tsc --project docker/tsconfig.build.json \
    && npx vite build \
    && node scripts/gen-sw-twa.mjs

FROM nginx:stable-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY LICENSE ASSETS.md /usr/share/nginx/html/licenses/
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
