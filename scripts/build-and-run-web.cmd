@echo off
cd /d "D:\deepseek-harness"
pnpm run build
pnpm dsh web
