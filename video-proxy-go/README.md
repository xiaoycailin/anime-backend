# Weebin Video Proxy

Go sidecar untuk memindahkan traffic segment video dari Node/Fastify.

Target awal:

- `/api/video-stream/*/segment?t=<hex>`
- `/api/video-stream/*/mp4-segment/:quality?t=<hex>`

Node tetap menangani endpoint resolver seperti `/playlist`, karena bagian itu masih banyak logic provider, metadata, dan fallback.

## Local Run

```bash
go run .
```

Default port: `8091`.

```bash
PORT=8091 go run .
```

## Build

```bash
go build -o video-proxy
```

## Nginx Routing Idea

Route segment-heavy request ke service ini, route lain tetap ke backend Node.

```nginx
location ~ ^/api/video-stream/.*/(segment|mp4-segment)/? {
    proxy_pass http://127.0.0.1:8091;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Range $http_range;
    proxy_set_header If-Range $http_if_range;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
}
```

Untuk cache segment via Nginx, aktifkan `proxy_cache` setelah smoke test stabil.
