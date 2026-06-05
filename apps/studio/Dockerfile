FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/studio/package.json apps/studio/package.json
COPY packages packages
RUN pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
COPY apps/studio apps/studio
COPY docs docs
RUN pnpm --filter @snarkroute/protocol build
RUN pnpm --filter @snarkroute/studio build

FROM nginx:1.27-alpine AS runner
COPY apps/studio/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/studio/dist /usr/share/nginx/html
EXPOSE 80
