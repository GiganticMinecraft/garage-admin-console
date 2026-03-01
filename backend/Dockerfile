FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags '-s' -o /garage-admin-console .

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=builder /garage-admin-console /garage-admin-console
EXPOSE 8080
ENTRYPOINT ["/garage-admin-console"]
