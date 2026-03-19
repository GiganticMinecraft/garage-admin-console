FROM node:25-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.29-alpine-otel
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
