@echo off
cd /d "%~dp0"
echo Elysium LP -^> http://127.0.0.1:8097/elysium-lp/
python server.py --port 8097
pause
