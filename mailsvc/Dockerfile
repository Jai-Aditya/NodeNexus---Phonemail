# Build stage
FROM golang:1.23-alpine AS build
WORKDIR /src
# go.sum pins every dependency by checksum; the build uses exactly those and never
# changes them (-mod=readonly), so the same source always gives the same program.
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY . .
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/mailsvc .

# Run stage: a small image with just the binary
FROM alpine:3.20
RUN adduser -D -u 10001 app && mkdir -p /data/attachments && chown -R app /data
USER app
COPY --from=build /out/mailsvc /usr/local/bin/mailsvc
ENV LISTEN_ADDR=:8081 ATTACHMENT_DIR=/data/attachments
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8081/health || exit 1
ENTRYPOINT ["mailsvc"]
