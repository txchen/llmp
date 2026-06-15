FROM oven/bun:latest
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
RUN bun install --frozen-lockfile
EXPOSE 33000
CMD ["bun", "run", "src/server.ts"]
