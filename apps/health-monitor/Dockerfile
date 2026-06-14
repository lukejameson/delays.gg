# Build from monorepo root context
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY packages/database/package*.json ./packages/database/
COPY packages/common/package*.json ./packages/common/
COPY packages/telegram/package*.json ./packages/telegram/
COPY apps/health-monitor/package*.json ./apps/health-monitor/

RUN npm install

COPY packages/database/ ./packages/database/
COPY packages/common/ ./packages/common/
COPY packages/telegram/ ./packages/telegram/
COPY apps/health-monitor/ ./apps/health-monitor/

WORKDIR /app/packages/database
RUN npm run build

WORKDIR /app/packages/common
RUN npm run build

WORKDIR /app/packages/telegram
RUN npm run build

WORKDIR /app/apps/health-monitor
RUN npm run build

WORKDIR /app
RUN npm prune --production

# Production stage
FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/apps/health-monitor/dist ./dist
COPY --from=builder /app/apps/health-monitor/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/database ./packages/database
COPY --from=builder /app/packages/common ./packages/common
COPY --from=builder /app/packages/telegram ./packages/telegram

RUN apk add --no-cache tzdata

ENV NODE_ENV=production \
    TZ=UTC
CMD ["node", "dist/index.js"]
