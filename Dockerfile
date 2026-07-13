FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

# The vault lives outside the image; mount a volume at /data for persistence.
# A seeded welcome doc populates a fresh named volume on first mount.
ENV SHAREMD_VAULT=/data/vault
RUN mkdir -p /data/vault && \
    printf '# Welcome to sharemd\n\nThis vault is empty — start writing, or point an MCP agent here.\n' \
      > /data/vault/welcome.md

EXPOSE 4321
CMD ["bun", "run", "src/server/index.ts"]
