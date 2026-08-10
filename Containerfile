FROM node:26-alpine AS build

RUN apk add --no-cache pnpm

WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests
RUN pnpm typecheck
RUN pnpm test
RUN pnpm build
RUN pnpm prune --prod

FROM node:26-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist

ENTRYPOINT ["node", "dist/main.js"]
