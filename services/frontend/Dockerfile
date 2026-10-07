# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# `docker build --target test` -> lint + unit tests (used by CI)
FROM deps AS test
COPY . .
CMD ["sh", "-c", "npm run lint && npm test"]

FROM deps AS build
COPY . .
RUN npm run build

# Static files served by an unprivileged nginx (listens on 8080, runs as uid 101)
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=0755 docker-entrypoint.d/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html
EXPOSE 8080
