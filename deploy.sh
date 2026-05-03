#!/bin/bash
set -e

cd /home/www/app-anime/backend-api

echo "Syncing backend with GitHub..."
git remote set-url origin https://github.com/xiaoycailin/anime-backend.git
git fetch origin
git reset --hard origin/main
git clean -fd

echo "Installing backend dependencies..."
if [ -f package-lock.json ]; then
	npm ci --include=dev || npm install --include=dev
else
	npm install --include=dev
fi

echo "Generating prisma client..."
npx prisma generate

echo "DB Push prisma client..."
npx prisma db push

echo "Building backend..."
npm run build

echo "Building Go video proxy..."
(cd video-proxy-go && go build -o video-proxy)

echo "Starting backend and Go video proxy with PM2..."
if ! command -v pm2 >/dev/null 2>&1; then
	npm install -g pm2
fi

APP_NAME="anime-api"
APP_PORT="3301"
GO_PROXY_NAME="video-proxy-go"
GO_PROXY_PORT="8091"

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
	PORT="$APP_PORT" pm2 restart "$APP_NAME" --update-env
else
	PORT="$APP_PORT" pm2 start npm --name "$APP_NAME" -- run start
fi

if pm2 describe "$GO_PROXY_NAME" >/dev/null 2>&1; then
	PORT="$GO_PROXY_PORT" pm2 restart "$GO_PROXY_NAME" --update-env
else
	PORT="$GO_PROXY_PORT" pm2 start ./video-proxy-go/video-proxy --name "$GO_PROXY_NAME"
fi

pm2 save
echo "Backend service '$APP_NAME' is running on port $APP_PORT."
echo "Go video proxy service '$GO_PROXY_NAME' is running on port $GO_PROXY_PORT."
