# ---------------------------------------------------------------------------
# Stage 1: Build the component package
# The component source is provided via the 'component' additional_context
# defined in docker-compose.yml.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS component-builder

WORKDIR /build/component
COPY --from=component . .

# Install all deps (including devDeps for TypeScript compilation)
RUN npm install

# Compile TypeScript → lib/
RUN npm run compile

# Pack into a self-contained tarball so the server can install it without
# needing a symlink back to the source directory.
RUN npm pack && mv *.tgz /tmp/arc.tgz

# ---------------------------------------------------------------------------
# Stage 2: Build the server
# ---------------------------------------------------------------------------
FROM node:24-alpine AS server-builder

WORKDIR /build/server

# Copy package manifest first for better layer caching
COPY package.json ./

# Copy the component tarball from the previous stage
COPY --from=component-builder /tmp/arc.tgz /tmp/arc.tgz

# Patch the file: dependency to point at the local tarball.
# This avoids symlink issues while keeping the host package.json unchanged.
RUN node -e " \
  const p = require('./package.json'); \
  p.dependencies['@gemeentenijmegen/attestatie-registratie-component'] = 'file:/tmp/arc.tgz'; \
  require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2)); \
"

# Install all dependencies (component is copied into node_modules, not symlinked)
RUN npm install

# Copy source and compile
COPY src ./src
COPY tsconfig.json ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: Runtime image
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

WORKDIR /app

COPY --from=server-builder /build/server/dist ./dist
COPY --from=server-builder /build/server/node_modules ./node_modules

EXPOSE 3000

CMD ["node", "dist/server.js"]
