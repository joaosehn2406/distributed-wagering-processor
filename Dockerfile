FROM oven/bun:1.4.0-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
CMD ["bun", "dist/main.js"]
