FROM oven/bun:1.1.45
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN bun install --frozen-lockfile || true
EXPOSE 33000
CMD ["bun", "run", "src/server.ts"]
