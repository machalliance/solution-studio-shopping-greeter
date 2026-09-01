# ── Build stage ────────────────────────────────────────────────────────────────
# Full dependency tree, used only to produce dist/. None of it reaches the runtime
# image, so vite/vitest/typescript and their transitive CVEs stay out of what ships.
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
# Deliberately does NOT upgrade the bundled npm CLI. That was previously done here to
# shed CVEs from npm's own vendored deps (tar, pacote, sigstore), but npm@latest ships
# a Go toolchain that added 46 findings of its own — 2 critical, 20 high — strictly
# worse than the npm the base image already carries. With --omit=dev below, npm's
# vendored tree is barely present in the final image anyway.
FROM node:22-alpine

# Pull the current apk package set. The base image lags on openssl, which is where
# essentially every remaining CVE in this image lives.
RUN apk upgrade --no-cache

WORKDIR /app
ENV NODE_ENV=production

# Production deps only. tsx is a genuine runtime dependency here: the server is run
# through it rather than as a precompiled bundle.
#
# npm itself is then deleted. Every npm-ecosystem CVE in this image came from npm's own
# bundled tree (tar, pacote, sigstore, ip-address, picomatch, brace-expansion) under
# /usr/local/lib/node_modules/npm — not one from /app/node_modules. Nothing at runtime
# needs the npm CLI once the install is done, so removing it in the same layer drops
# those findings to zero. The trade-off: no `npm` inside a running container to debug with.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Runtime reads dist/panel.html, src/style.css, host/*.html and catalog/ — see the
# join(ROOT, ...) paths in src/server.ts.
COPY --from=builder /app/dist ./dist
COPY src ./src
COPY host ./host
COPY catalog ./catalog

# Drop root. Nothing writes inside /app at runtime; the category store goes to /tmp.
USER node

ENV PORT=3003
EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3003)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Invoked directly rather than via `npm start` — npm is gone by this point. Kept in sync
# with the "start" script in package.json.
CMD ["node_modules/.bin/tsx", "--env-file-if-exists=.env", "src/server.ts"]
