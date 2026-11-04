FROM node:24-bookworm-slim

# pnpm version matching the workspace packageManager
RUN npm install -g pnpm@10.32.1

WORKDIR /app

# Port exposed by the proxy
EXPOSE 4141

# Copy workspace manifests + sources so pnpm sees every package's package.json
# before installing (node_modules is excluded by .dockerignore).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY scripts ./scripts

# Install dependencies (better layer caching when only sources change)
RUN pnpm install --frozen-lockfile

# Build all packages (generates dist/ and .output/)
RUN pnpm build

# Environment variables with production defaults (overridable at runtime)
ENV PORT=4141
ENV M365_CACHE_FILE=/root/.config/opencode-m365/msal-cache.json
ENV M365_SECRETS_FILE=/root/.config/opencode-m365/secrets.json
ENV M365_BROWSER_PROVIDER=selenium
ENV M365_SELENIUM_URL=http://192.168.2.251:4444
ENV M365_SELENIUM_BROWSER=chrome
ENV M365_ENABLE_INTERACTIVE_APPROVAL=1

# Default command: start the proxy on port 4141
CMD ["pnpm", "run", "proxy", "4141"]
