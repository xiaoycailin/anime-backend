#!/bin/bash
set -e

ROOT_DIR="${GO_PROXY_ROOT_DIR:-/home/www/app-anime/backend-api}"
APP_NAME="${GO_PROXY_NAME:-video-proxy-go}"
APP_PORT="${GO_PROXY_PORT:-8091}"

cd "$ROOT_DIR"

echo "Syncing backend repo for Go proxy..."
git remote set-url origin https://github.com/xiaoycailin/anime-backend.git
git fetch origin
git reset --hard origin/main
grep -qxF "tmp/" .git/info/exclude || printf "\ntmp/\n" >> .git/info/exclude
grep -qxF "data/youtube-cookies.txt" .git/info/exclude || printf "data/youtube-cookies.txt\n" >> .git/info/exclude
git clean -fd

echo "Building Go video proxy..."
cd video-proxy-go
go build -o video-proxy

echo "Restarting Go video proxy with PM2..."
if ! command -v pm2 >/dev/null 2>&1; then
	npm install -g pm2
fi

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
	pm2 delete "$APP_NAME"
fi

PORT="$APP_PORT" pm2 start ./video-proxy --name "$APP_NAME"
pm2 save

echo "Go video proxy service '$APP_NAME' is running on port $APP_PORT."
