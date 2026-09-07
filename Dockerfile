FROM node:22-bookworm-slim

# better-sqlite3のネイティブビルドに必要
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@12.3.4

WORKDIR /app

# 依存関係定義だけ先にコピーしてレイヤーキャッシュを効かせる
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build:web

EXPOSE 3000 3443

CMD ["pnpm", "run", "start"]
