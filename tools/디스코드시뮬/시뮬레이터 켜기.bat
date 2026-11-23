@echo off
chcp 65001 >nul
rem 더블클릭하면 디스코드 시뮬레이터를 켜고 브라우저를 자동으로 엽니다. (끄려면 이 창을 닫으세요)
cd /d "%~dp0..\.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 가 설치돼 있지 않아요. https://nodejs.org 에서 설치한 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)
if not exist node_modules (
  echo 처음 한 번: 필요한 패키지를 설치합니다...
  call npm install --ignore-scripts
)
node tools\디스코드시뮬\실행.js
echo.
echo 시뮬레이터가 종료됐어요.
pause
