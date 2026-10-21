FROM golang:1.27-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG GIT_SHA=dev
RUN CGO_ENABLED=0 go build -ldflags "-s -X main.version=${GIT_SHA}" -o /garage-admin-console .

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=builder /garage-admin-console /garage-admin-console
EXPOSE 8080
ENTRYPOINT ["/garage-admin-console"]
