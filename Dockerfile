FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

# The vault lives outside the image; mount a volume at /data for persistence.
# Volumes arrive empty, so the entrypoint seeds a welcome doc only when the
# vault has no documents yet (the server itself creates the directory).
ENV SHAREMD_VAULT=/data/vault
RUN printf '# Welcome to sharemd\n\nThis vault is empty — start writing, or point an MCP agent here.\n' \
      > /app/welcome-seed.md

EXPOSE 4321
CMD ["sh", "-c", "mkdir -p \"$SHAREMD_VAULT\" && [ -n \"$(ls -A \"$SHAREMD_VAULT\")\" ] || cp /app/welcome-seed.md \"$SHAREMD_VAULT/welcome.md\"; exec bun run src/server/index.ts"]
