@echo off
rem 启动 Transfer Reader 翻译引擎（FastAPI，端口 8765）
cd /d "%~dp0.."
python -m uvicorn engine.main:app --host 127.0.0.1 --port 8765
