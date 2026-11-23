#!/bin/sh
# 더블클릭(맥) 또는 ./시뮬레이터\ 켜기.command 로 실행하면 시뮬레이터를 켜고 브라우저를 엽니다.
cd "$(dirname "$0")/../.." || exit 1
[ -d node_modules ] || npm install --ignore-scripts
node tools/디스코드시뮬/실행.js
