# Build stage runs on the native BUILDPLATFORM (not the target arch): `vp pack`
# emits a portable JS bundle (ws stays external), so it never needs to run under
# emulation. Building once on the native arch is faster (no QEMU for the arm64
# image) and sidesteps Vite+'s native bundler binaries (Rolldown/Oxc) entirely.
FROM --platform=$BUILDPLATFORM node:24 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
# --ignore-scripts: skip the `prepare` (husky) lifecycle script — husky is a
# dev dependency and isn't installed here, and git hooks are irrelevant at runtime.
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
USER node
EXPOSE 9000
CMD ["node", "--enable-source-maps", "dist/index.cjs"]
