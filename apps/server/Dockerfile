FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages packages
COPY packages/adapters packages/adapters
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/server apps/server
COPY scripts scripts
COPY data/model-registry data/model-registry
COPY data/prompt-library data/prompt-library
RUN pnpm run build:boojumroute-deps
RUN pnpm --filter @snarkroute/server build
RUN node scripts/fix-esm-imports.mjs apps/server/dist packages/*/dist packages/adapters/*/dist

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV API_PORT=4317
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/packages ./packages
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/data/model-registry ./data/model-registry
COPY --from=build /app/data/prompt-library ./data/prompt-library
EXPOSE 4317
CMD ["node", "apps/server/dist/index.js"]
