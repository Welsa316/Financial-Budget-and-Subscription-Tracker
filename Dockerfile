# Deliberately a Dockerfile rather than Nixpacks.
#
# Nixpacks' build died compiling better-sqlite3: npm ran `node-gyp rebuild`
# and the image has no Python. better-sqlite3 sets "gypfile": false precisely
# to stop that, but npm ignores the flag and falls back to its default
# node-gyp behaviour because the package still contains a binding.gyp.
#
# Nothing here needs compiling. Both native dependencies ship prebuilt
# binaries and resolve them at require time:
#   better-sqlite3 -> prebuilds/linux-x64.node
#   argon2         -> prebuilds/linux-x64  (via node-gyp-build)
# So install scripts are skipped, which avoids node-gyp entirely and keeps
# the build to a few seconds with no toolchain in the image.
#
# Verified in this exact base image: with --ignore-scripts, better-sqlite3
# opens a database and runs a query, and argon2 hashes and verifies.
#
# If a future dependency genuinely needs its install script, revisit this:
# add python3/make/g++ to the build stage, compile there, and copy
# node_modules into the runtime stage.
#
# Pinning the image also means Railway passes no build ARGs for service
# variables, so secrets are no longer baked into image layers.

# --- build ----------------------------------------------------------------
FROM node:24-slim AS build

WORKDIR /app

# Dependencies first, so a source-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm run build

# --- runtime --------------------------------------------------------------
FROM node:24-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public
COPY config ./config

# Railway injects PORT; this is only the local default.
EXPOSE 3000

# Run unprivileged. Railway's /data volume is writable by this user.
USER node

CMD ["node", "dist/src/server.js"]
