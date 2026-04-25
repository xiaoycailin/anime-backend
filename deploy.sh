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

echo "Building backend..."
npm run build

echo "Backend build complete. Service not started."
