# Arcade_BOT

디스코드 게임 내전/모집, 팀 배정, 끝말잇기, XP/레벨 시스템을 제공하는 Discord 봇입니다. [discord.js](https://discord.js.org/) v14 기반으로 작성되었습니다.

## 주요 기능

- **내전(`/내전`)** — 게임별 내전 모집 글 생성, 참가/마감/자동 삭제, 팀 자동/수동 배정, 참가자 관리
- **모집(`/모집`)** — 내전보다 가벼운 일반 게임 모집 (팀 배정 없음)
- **불러오기(`/불러오기`)** — 채팅에 묻힌 내전/모집 게시글을 새 메시지로 다시 게시
- **배치(`/배치`)** — 관리자 전용, 현재 채널에 버튼(⚔️ 내전 생성 / 📋 모집 생성 / 🔎 불러오기 / 🛠️ 팀 관리 / 📖 명령어 보기)이 달린 안내 패널을 게시해 명령어 없이도 이용 가능
- **관리(`/관리`)** — 관리자 전용, 내전/모집 강제 종료·삭제, 봇 메시지 삭제
- **팀 배정(`/팀`)** — 내전 참가자를 팀으로 수동/자동(랜덤) 배정
- **끝말잇기(`/끝말잇기`)** — 두음법칙을 반영한 한국어 끝말잇기 게임, 국립국어원 API로 단어 검증, 봇 참가 가능 (지정된 채널 전용)
- **레벨/XP(`/레벨`, `/랭킹`)** — 채팅·통화방 체류·내전 참여 기반 XP/레벨 시스템, MEE6 방식 레벨업 공식 (`/랭킹`은 지정된 채널 전용)
- **임시 음성채널** — 허브 채널 입장 시 개인 음성채널 자동 생성/이동, 빈 방 자동 삭제

## 기술 스택

- [Node.js](https://nodejs.org/)
- [discord.js](https://discord.js.org/) ^14.16.3
- [dotenv](https://www.npmjs.com/package/dotenv) ^16.4.7
- 데이터 저장: 별도 DB 엔진 없이 `fs` 기반 JSON 파일 저장 (`data.json`, `levels.json`)

## 폴더 구조

```
Arcade_BOT/
├─ index.js                 # 엔트리 포인트: 클라이언트 초기화, 이벤트 라우팅, 자동 저장
├─ db.js                    # 내전/모집 매치 데이터를 JSON 파일로 저장/복원
├─ deploy-commands.js       # 슬래시 커맨드 등록 (전역 / 길드 단위)
├─ clear-guild-commands.js  # 길드 단위로 등록된 커맨드 전체 삭제
├─ commands/                # 슬래시 커맨드 정의 (얇은 진입점, 실제 로직은 handlers/)
│  ├─ 내전.js                # /내전
│  ├─ 모집.js                # /모집
│  ├─ 불러오기.js             # /불러오기
│  ├─ 배치.js                # /배치
│  ├─ 관리.js                # /관리
│  ├─ 팀.js                 # /팀
│  ├─ 끝말잇기.js             # /끝말잇기
│  ├─ 레벨.js                # /레벨
│  └─ 랭킹.js                # /랭킹
├─ handlers/                # 실제 비즈니스 로직 (버튼/모달/셀렉트 메뉴 처리 포함)
│  ├─ 내전.js
│  ├─ 모집.js
│  ├─ 불러오기.js
│  ├─ 팀.js
│  ├─ 끝말잇기.js
│  ├─ 레벨.js
│  ├─ 명령어로그.js           # 슬래시 커맨드 사용 로그 기록
│  ├─ 음성채널.js             # 허브 채널 입장 시 임시 음성채널 자동 생성/삭제
│  └─ 공용.js                # 내전/모집/팀 공용 유틸 (관리자 목록, 임베드 빌더, 자동 종료 타이머 등)
├─ data.json                # 진행 중인 내전/모집 매치 (자동 생성, gitignore)
├─ levels.json               # 유저별 XP (자동 생성, gitignore)
├─ command-log.json          # 슬래시 커맨드 사용 이력 (자동 생성, gitignore)
├─ voiceRooms.json           # 봇이 생성한 임시 음성채널 ID 목록 (자동 생성, gitignore)
└─ env                       # 환경변수 파일 (gitignore, 아래 참고)
```

## 설치 및 실행

```bash
npm install
```

프로젝트 루트에 `env` 파일을 만들고 아래 값을 채웁니다. (`.env`가 아니라 `env`라는 이름의 파일을 사용합니다)

```env
TOKEN=디스코드_봇_토큰
CLIENT_ID=디스코드_애플리케이션(클라이언트) ID
GUILD_ID=길드_ID_1,길드_ID_2        # 커맨드를 길드 단위로 배포/삭제할 때 사용, 콤마로 여러 개 가능
ALLOWED_CHANNEL_ID=채널_ID_1,채널_ID_2   # 내전/모집/팀 명령을 허용할 채널 목록, 콤마로 여러 개 가능(불러오기는 아래 MATCH_BONUS_CHANNEL_ID 채널 전용으로 별도 고정)
KRDICT_API_KEY=국립국어원_한국어기초사전_오픈API_키   # 끝말잇기 단어 검증용, 없으면 검증을 통과시킴(fail-open)
```

> `/끝말잇기`, `/랭킹`과 관련 버튼(`wc:*`, `ranking:*`)이 허용되는 채널 ID, 임시 음성채널 허브/카테고리 채널 ID, 레벨업 축하 채널 ID 등 일부 채널 ID는 `ALLOWED_CHANNEL_ID`가 아니라 코드에 상수로 하드코딩되어 있습니다(`index.js`의 `WORDCHAIN_RANKING_CHANNEL_ID`, `handlers/음성채널.js`의 `HUB_CHANNEL_ID`/`TEMP_CATEGORY_ID`, `handlers/레벨.js`의 `LEVEL_UP_ANNOUNCE_CHANNEL_ID`). 다른 서버에 배포할 때는 이 값들도 함께 수정해야 합니다.

> `/랭킹`이 `guild.members.fetch({ user: [...] })`로 멤버 정보를 대량 조회하기 때문에 `GuildMembers` 특권 인텐트(privileged intent)가 필요합니다(`index.js`). [Discord Developer Portal](https://discord.com/developers/applications) → 해당 애플리케이션 → Bot → Privileged Gateway Intents에서 **Server Members Intent**를 켜야 합니다 — 안 켜면 봇 로그인 자체가 "Used disallowed intents" 에러로 실패합니다.

슬래시 커맨드 등록 (GUILD_ID의 각 길드에 즉시 반영):

```bash
node deploy-commands.js
```

봇 실행:

```bash
npm start
```

## 명령어 목록

| 명령어 | 설명 | 옵션 |
|---|---|---|
| `/내전` | 게임 내전을 생성합니다 | - |
| `/모집` | 게임 모집을 생성합니다 | - |
| `/불러오기` | 진행 중인 내전/모집 게시글을 새 메시지로 다시 불러옵니다 | - |
| `/배치` | [관리자 전용] 현재 채널에 내전/모집/불러오기/팀 관리/명령어 보기 안내 패널(버튼)과 놀이터 채널(끝말잇기/레벨/랭킹) 바로가기 버튼을 게시합니다 | - |
| `/관리` | [관리자 전용] 내전/모집 관리, 봇 메시지 삭제 | `메시지삭제`(선택) |
| `/팀` | 내전 참가자를 팀으로 배정합니다 | - |
| `/끝말잇기` | 끝말잇기 게임을 시작합니다 | - |
| `/레벨` | 나 또는 다른 유저의 레벨과 XP를 확인합니다 | `유저`(선택) |
| `/랭킹` | 서버 XP 랭킹을 확인합니다 | - |

## 기능 상세

### 내전 (`/내전`, `handlers/내전.js`)

1. `/내전` 실행 → 게임 선택 메뉴(롤/발로란트/오버워치/배틀그라운드/직접 입력)
2. 게임 선택 → 모달로 제목/일시/인원/설명 입력
3. 제출 → 미리보기 임베드 + `📢 채널에 공개 게시` / `✏️ 수정` / `❌ 취소` 버튼, ⏰ 자동 마감 토글, (직접 입력 게임의 경우) Steam 역할 멘션 토글
4. 공개 게시 시 게임에 해당하는 역할(롤→`롤`, 발로란트→`발로란트`, 오버워치→`오버워치`, 배그→`배그`)을 멘션하며 게시
5. 참가/취소 버튼으로 인원 모집, 정원이 차면 자동 마감(`markClosed`) — 마감 시 8시간 후 자동 삭제 타이머가 걸리고(타이머 만료 시 참가자에게 완료 보너스 XP가 지급된 뒤 메시지가 삭제됨), 정원이 자동으로 차서 마감된 경우 주최자에게 마감 안내 DM이 발송됨(주최자가 직접 "마감하기" 버튼으로 수동 마감한 경우는 본인이 이미 알고 있으므로 DM 미발송, DM 차단 시에도 무시)
6. 주최자(또는 관리자) 전용 관리 메뉴: 마감/마감 해제, 수정, 취소, 팀 만들기(수동/자동 배정), 참가자 멘션(1회성), 🔔 알림 예약, 참가자 강제 추가/제거, ⏰ 자동 삭제 ON/OFF 토글(마감 전/후 상관없이 항상 현재 설정에 맞춰 표시) — 게시 전 미리보기에서 정한 설정을 마감 후에도 바꿀 수 있으며, 원래 마감 시각 기준 남은 시간으로 다시 예약됨(`toggleAutoCloseWhileClosed`); 이미 그 8시간이 지나 다음 클릭 시 즉시 삭제될 상황이면 버튼이 `🗑️ (내전/모집) 삭제`로 바뀜
7. 주최자가 취소하면 🔴 취소됨 임베드로 교체되고(`autoClose` 토글과 무관하게 항상) 8시간 후 자동 삭제됨(`scheduleCancelledDelete`) — 재시작해도 `data.json`에 삭제 예정 시각이 저장돼 있어 남은 시간만큼 다시 예약됨. 참가자 멘션을 이미 보낸 상태였다면 그 멘션 메시지도 즉시 함께 삭제됨(`deleteMentionMessage`) — 자동 삭제/관리 메뉴 즉시삭제/⌛ 종료 등 매치가 끝나는 모든 경로에서 공통
8. **🔔 알림 예약**: 자유 형식인 "일시"와 별개로, "M/D HH:mm"(KST, 24시간제) 형식만 받는 전용 모달(`buildNotifyModal`)로 알림 시각을 설정. 그 시각이 됐을 때 **매치가 마감(closed) 상태인 경우에만** 주최자+참가자 전원에게 DM으로 시작 알림을 보냄(마감 전이면 보류) — 마감 전에 시각이 지나도 유실되지 않고, 이후 수동("🔒 마감하기")이든 자동(정원 마감)이든 **마감되는 즉시** 밀려있던 알림이 발송됨(`markClosed`가 `trySendNotify`로 catch-up). 다만 매치가 취소/종료(⌛)/자동 삭제 등으로 관리 목록(matchesMap)에서 이미 빠진 상태라면 보내지 않음(`clearNotifyTimer`로 타이머를 명시적으로 취소하거나, 타이머가 이미 걸린 채 빠졌더라도 발동 시점에 매치 조회 실패로 조용히 건너뜀). 형식이 안 맞으면 제출이 거부되고, 연도 입력이 없으므로 올해 기준으로 계산하되 이미 지난 시각이면 내년으로 자동 보정. 빈 값으로 제출하면 예약 취소. `data.notifyAt`(epoch ms)이 매치 데이터에 함께 저장되므로 재시작 후에도 `armNotifyReminder`로 다시 예약됨, 재게시(`/불러오기`)로 메시지 ID가 바뀌어도 새 ID로 다시 걸림
   - 예약이 걸려있는 동안에는 공개 임베드의 "📊 상태" 줄 아래에 `🔔 **알림**　　M/D ...` 줄이 추가로 표시되어 주최자/참가자 모두 확인 가능(취소하면 즉시 사라짐, `match.message.edit`로 실시간 반영)
   - 표시 형식은 주최자가 **입력했던 형식 그대로** 따라감 — 24시간제("6/5 20:00")로 입력했으면 임베드/버튼/확인 메시지 모두 24시간제로, 오전/오후("6/5 오후 8:00")로 입력했으면 그대로 오전/오후로 표시(`data.notify12h`에 입력 형식을 기록해두고 `formatNotifyTimeSmart`로 그에 맞춰 렌더링, 재수정 시 입력창 프리필도 동일 형식 유지)
   - 이미 예약된 상태에서 "🔔 알림 예약" 버튼을 다시 누르면 바로 모달을 열지 않고 "이미 알림이 예약되어 있습니다. 수정하시겠습니까?" 확인 메시지(✏️ 수정하기 / ↩️ 돌아가기)를 먼저 보여줌 — 실수로 기존 예약을 덮어쓰는 것을 방지
   - "🔔 알림 예약" 버튼은 마감 여부와 무관하게 계속 눌러서 확인/수정할 수 있고, **DM이 실제로 발송된 뒤에만**(`notifySent`) 비활성화됨(`buildNotifyButton`)

### 모집 (`/모집`, `handlers/모집.js`)

내전과 동일한 생성/게시/참가/관리 흐름을 갖되 **팀 배정 기능이 없는** 더 가벼운 버전입니다. 기본 인원수도 더 적게 설정되어 있습니다(롤/발로란트/오버워치 5명, 배그 4명 vs 내전 10명/8명).

### 팀 배정 (`/팀`, `handlers/팀.js`)

- 참가자 2명 이상인 진행 중 내전만 선택 가능
- `🛠️ 팀 만들기`(팀1을 수동으로 선택, 나머지는 자동으로 팀2) 또는 `🎲 자동 배정`(Fisher–Yates 셔플 후 절반씩 분할) 선택
- 배정 결과는 원본 내전 게시글과 팀 결과 임베드에 반영됨

### 불러오기 (`/불러오기`, `handlers/불러오기.js`)

- 현재 서버에서 진행 중인 내전/모집 목록을 셀렉트 메뉴로 표시(상태: 🔒 마감됨 / 🟢 모집중)
- 선택 시 기존 메시지를 삭제하고 동일한 내용으로 새 메시지를 게시, 내부적으로 매치 데이터의 메시지 ID를 갱신
- 자동 삭제가 걸려 있던 매치는 남은 시간을 그대로 유지해 새 메시지에 재설정
- `/불러오기` 명령어, `불러오기:select` 선택 메뉴, `/배치` 패널의 "🔎 불러오기" 버튼(`recruit:불러오기`) 모두 완료 보너스 채널(`MATCH_BONUS_CHANNEL_ID`)에서만 사용 가능(`index.js`) — 다른 채널에서 재게시하면 `match.message.channelId`가 바뀌어 XP 보너스 자격이 어긋나는 것을 방지

### 배치 (`/배치`, `commands/배치.js`, 관리자 전용)

- 실행한 채널에 안내 임베드(1회성 게시, 별도 저장/복원 없음)와 "⚔️ 내전 생성" / "📋 모집 생성" / "🔎 불러오기" / "🛠️ 팀 관리" / "📖 명령어 보기" 버튼을 게시
- 버튼 클릭 시 각각 `/내전`, `/모집`, `/불러오기`, `/팀` 실행과 동일한 메뉴, "명령어 보기"는 전체 명령어 목록 임베드가 클릭한 유저에게만(ephemeral) 표시되어, 이후 흐름은 슬래시 커맨드와 완전히 동일(내부적으로 각 커맨드 파일이 내보내는 `buildGameSelectPayload`/`buildReloadListPayload`/`buildTeamMatchListPayload`/`buildCommandListPayload`를 그대로 재사용)
- 끝말잇기/레벨/랭킹은 놀이터 채널(`PLAYGROUND_CHANNEL_ID`)에서만 이용 가능하다는 안내 임베드와 해당 채널로 바로 이동하는 링크 버튼을 함께 게시
- "🔄 새로고침" 버튼을 누르면 패널 메시지를 최신 상태로 그 자리에서 갱신(`interaction.update`)
- 버튼 자체는 관리자 권한 없이 아무나 클릭 가능(안내 패널의 목적이 명령어 없이도 접근 가능하게 하는 것이므로) — 패널을 게시하는 `/배치` 실행만 관리자 전용
- 패널을 게시한 채널이 `ALLOWED_CHANNEL_ID`에 포함되어 있어야 버튼 클릭 이후의 게임 선택/모달 등 후속 상호작용이 정상 동작함

### 관리 (`/관리`, `commands/관리.js`, 관리자 전용)

- `메시지삭제` 옵션에 메시지 ID/링크를 입력하면 해당 봇 메시지를 즉시 삭제
- 옵션 없이 실행하면 내전/모집 관리 메뉴 표시 → 선택한 매치를 `⌛ 종료`(그레이아웃 처리 후 목록에서 제거) 또는 `🗑️ 삭제`
- 목록은 명령어를 실행한 서버의 내전/모집만 표시(다른 서버 것과 섞이지 않음)
- 관리자 판별은 `handlers/공용.js`의 `ADMIN_IDS`(하드코딩된 유저 ID 목록)로 처리됩니다

### 끝말잇기 (`/끝말잇기`, `handlers/끝말잇기.js`)

- `index.js`의 `WORDCHAIN_RANKING_CHANNEL_ID`로 지정된 채널에서만 사용 가능
- 참가 버튼으로 대기열에 합류(최대 90초), 2명 이상이면 시작 가능, 사람이 1명뿐이면 봇과 대결 가능
- 순서가 된 사람이 채팅으로 답을 입력하면 검증: 한글 여부, 최소 길이, 이전 단어 끝 글자와 일치(두음법칙 변환 반영), 중복 사용 여부, 국립국어원 한국어기초사전 API를 통한 실존 단어 여부
- 20초 제한시간 초과, 규칙 위반, 사전에 없는 단어 등으로 게임 종료 시 사유와 함께 결과 임베드 표시, `🔁 재대결` 버튼으로 5분 내 동일 참가자로 재시작 가능
- 봇 참가 시 두음법칙을 반영해 가능한 시작 글자들로 한국어기초사전 API에서 단어를 조회해 자동 응답

### 임시 음성채널 (`handlers/음성채널.js`)

- 지정된 허브 채널(`HUB_CHANNEL_ID`)에 입장하면 지정된 카테고리(`TEMP_CATEGORY_ID`)에 `🔊 {닉네임}의 방` 음성채널을 새로 만들어 그리로 이동시킴
- 방을 만든 사람에게는 해당 채널의 "채널 관리" 권한을 부여(이름/인원제한 등을 스스로 수정 가능)
- 채널에 아무도 남지 않으면 자동으로 삭제(허브로 바로 재입장해 새 방을 만드는 경우에도 이전 방 정리가 먼저 처리됨)
- 봇 재시작 시 그동안 만들어졌던 임시 채널 중 빈 방을 정리(`voiceRooms.json`으로 추적 ID 영속화)

### XP / 레벨 시스템 (`/레벨`, `/랭킹`, `handlers/레벨.js`)

레벨 `L → L+1` 필요 XP 공식(MEE6 방식): `5×L² + 50×L + 100`

| 경로 | 배율 | 쿨다운 | 비고 |
|---|---|---|---|
| 메인 텍스트 채널 | 1배 (15~25 XP) | 60초 | 지정된 채널에서만 인정 |
| TTS 채널(통화 연동 전용 채팅방) | 0.06배 | 3분 | 통화방 체류 XP와 시간당 수익을 동일하게 맞춤(시간당 평균 약 24XP), 이미 음성 XP를 받는 유저는 중복 지급 안 함 |
| 통화방(음성) 체류 | 0.02배 | 1분마다 자동 지급 | 음소거/헤드셋오프 시 제외, 소수점은 다음 틱으로 이월해 손실 없이 누적 |
| 내전/모집 완료 보너스 | 주최자 1.5배 / 참가자 1.3배 | 1회성 | 지정된 채널의 매치가 마감될 때 지급, 유저당 중복 지급 없음 |

- 레벨업 시 지정된 채널에 축하 메시지 게시
- 특정 서버(테스트 서버)는 시스템 자체가 비활성화됨
- 내전/모집 완료 보너스 채널(`MATCH_BONUS_CHANNEL_ID`)에 올라온 일반 유저 메시지는 8시간 후 자동 삭제됨(`scheduleMessageDelete`, 봇 메시지는 제외) — 재시작해도 `data.json`에 삭제 예정 시각이 저장돼 있어 남은 시간만큼 다시 예약됨. 다만 이 예약은 `messageCreate` 이벤트에서만 걸리므로, 봇이 꺼져있던 동안 올라온 메시지는 예약 자체가 안 걸린 채로 남을 수 있음 — 봇 시작 시(`index.js`의 `reconcileMatchBonusMessages`) 이 채널의 최근 메시지(최대 500개 또는 24시간치)를 훑어 예약이 빠진 메시지를 찾아 다시 걸어줌
- `/레벨`로 진행바 임베드 확인, `/랭킹`으로 서버 XP 순위 확인(`/레벨`, `/랭킹` 모두 `index.js`의 `WORDCHAIN_RANKING_CHANNEL_ID` 채널에서만 사용 가능)
- `/랭킹`은 서버를 나갔거나 멤버 조회가 안 되는(알 수 없는 사용자) 유저를 목록에서 완전히 제외함 — 페이지 단위가 아니라 전체 랭킹을 먼저 걸러낸 뒤 페이지를 나눠서, 나간 유저가 있어도 한 페이지가 5명 미만으로 비지 않음

## 주요 함수

각 파일에서 내보내는(export) 함수와 핵심 내부 함수를 정리했습니다. `handlers/내전.js`/`handlers/모집.js`는 버튼/셀렉트/모달 커스텀ID 하나하나를 처리하는 대형 `if/else` 분기 함수(`handleNaejeonButton`, `handleMojipButton`)가 실질적인 로직 대부분을 담고 있어, 그 내부 동작은 위 "기능 상세" 절에서 흐름 위주로 설명했습니다.

### `handlers/레벨.js` — XP/레벨

| 함수 | 설명 |
|---|---|
| `loadLevels()` / `saveLevels()` | `levels.json`에서 XP 데이터를 불러오거나 저장 |
| `xpNeededForLevel(level)` | 레벨 `L→L+1`에 필요한 XP 계산 (`5L²+50L+100`) |
| `levelFromXp(xp)` | 누적 XP → 현재 레벨/레벨 내 XP/다음 레벨 필요 XP |
| `getXp(guildId, userId)` | 특정 유저의 누적 XP 조회 |
| `applyXp(guildId, userId, amount)` | XP를 더하고 레벨업 여부 반환 (내부 공통 로직) |
| `handleMessageXp(message)` | 메시지 1건에 대해 채널/쿨다운/배율을 판정해 XP 지급 |
| `awardMatchCompletionXp(match)` | 내전/모집 마감 시 주최자·참가자에게 1회성 보너스 XP 지급 |
| `trackVoiceStateUpdate(oldState, newState)` | 음성 상태 변화(입장/퇴장/음소거)를 추적해 활성 유저 집합 갱신 |
| `initVoiceStates(client)` | 봇 재시작 시 이미 통화 중이던 유저를 추적 대상으로 재등록 |
| `startVoiceXpTicker(client)` | 1분마다 통화 중인 유저에게 체류 XP를 자동 지급하는 타이머 시작 |
| `getLeaderboard(guildId, limit, offset)` / `getLeaderboardSize(guildId)` | `/랭킹`용 정렬된 리더보드 조회 |
| `buildProgressBar(current, needed, length)` | `/레벨` 임베드용 진행바(■□) 문자열 생성 |

### `handlers/공용.js` — 내전/모집/팀 공용 유틸

| 함수 | 설명 |
|---|---|
| `getNaejeonMatches(client)` | `client.naejeonMatches` Map 획득(없으면 생성) |
| `shuffleIntoTeams(participants)` | Fisher–Yates 셔플 후 절반씩 팀1/팀2로 분할 |
| `armAutoEnd(matchesMap, msgId, match, label, delayMs)` | 마감된 매치에 8시간 자동 삭제 타이머 설정 — 만료 시 XP 지급 후 메시지를 바로 삭제(`endMatch` 미사용) |
| `disarmAutoEnd(match)` | 자동 삭제 타이머 해제 |
| `scheduleCancelledDelete(client, msgId, channelId, deleteAt)` | 취소된 매치를 `deleteAt`(기본 8시간 후) 시점에 자동 삭제 예약 — `client.cancelledDeletions` Map에 기록해 재시작 후에도 복원 가능 |
| `scheduleMessageDelete(client, msgId, channelId, deleteAt)` | 매치 상태와 무관하게 일반 메시지를 `deleteAt`(기본 8시간 후) 시점에 자동 삭제 예약 — `client.pendingMessageDeletions` Map에 기록해 재시작 후에도 복원 가능 (내전/모집 인증 채널의 유저 메시지 정리에 사용) |
| `markClosed(matchesMap, msgId, match, label, notify = true)` / `markReopened(match)` | 매치 마감/마감 해제 처리 (자동 삭제 타이머 연동). `notify=false`를 넘기면 주최자 DM을 생략(주최자 본인이 직접 마감한 경우에 사용) |
| `toggleAutoCloseWhileClosed(matchesMap, msgId, match, label, enabled)` | 이미 마감된 매치의 자동 삭제 ON/OFF를 관리 메뉴에서 토글 — 원래 마감 시각 기준 남은 시간으로 재예약(다 지났으면 즉시 삭제), OFF 시 타이머만 취소 |
| `notifyOrganizerOnClose(match, label)` *(내부)* | 정원 자동 마감 시 주최자에게 게시글 제목과 링크를 DM으로 전송 (DM 차단 등 실패는 무시) |
| `endMatch(matchesMap, msgId, match, label)` | 매치를 종료 상태로 전환(임베드를 회색으로 교체, 참가자 멘션 메시지 삭제, Map에서 제거) — `/관리`의 수동 "⌛ 종료" 버튼 전용 |
| `announceMatchCompletionXp(match)` | 마감된 매치에 보너스 XP 지급 + 레벨업 유저 축하 메시지 게시 |
| `buildModal` / `buildPreviewEmbed` / `buildPreviewComponents` / `buildCancelComponents` / `buildLeaveButton` | 내전/모집이 공유하는 모달·임베드·버튼 빌더 (`type` 파라미터로 분기) |

### `handlers/내전.js` — 내전

| 함수 | 설명 |
|---|---|
| `handleGameSelect(interaction)` | 게임 선택 메뉴 → 모달 오픈 |
| `handleNaejeonModal(interaction)` | 생성 모달 제출 → 미리보기 임베드 표시 |
| `handleNaejeonEditModal(interaction)` | 게시 전 미리보기 상태에서 수정 모달 제출 처리 |
| `handleNaejeonButton(interaction)` | 게시/참가/탈퇴/마감/취소/팀 관리 등 내전 관련 모든 버튼 처리 (커스텀ID 분기) |
| `handleNaejeonMatchEditModal(interaction)` | 게시된 내전의 정보 수정 모달 제출 처리 |
| `handleTeamAssign(interaction)` | 주최자 관리 메뉴에서 트리거되는 팀 배정 셀렉트 처리 |
| `handleNaejeonMemberAdd(interaction)` / `handleNaejeonMemberRemove(interaction)` | 관리자/주최자의 참가자 강제 추가/제거 |
| `buildPublicMessagePayload(match)` | 공개 게시 메시지(임베드+버튼) 페이로드 생성 — `/불러오기`에서 재게시할 때도 사용 |

### `handlers/모집.js` — 모집

내전과 동일한 구조로 `handleMojipGameSelect`, `handleMojipModal`, `handleMojipEditModal`, `handleMojipButton`, `handleMojipMatchEditModal`, `handleMojipMemberAdd`, `handleMojipMemberRemove`, `buildMojipMessagePayload`를 내보내며 역할도 각각 내전 쪽 대응 함수와 동일합니다(팀 배정 관련 함수만 없음).

### `handlers/팀.js` — 팀 배정

| 함수 | 설명 |
|---|---|
| `buildMatchSelectMenu(matches)` | `/팀` 실행 시 보여줄 내전 선택 메뉴 생성 |
| `handleTeamMatchSelect(interaction)` | 내전 선택 → 권한 확인 후 팀 관리 UI 표시 |
| `handleTeamButton(interaction)` | 팀 만들기/자동 배정/재배정 버튼 처리 |
| `handleTeamAssignSelect(interaction)` | 팀1 수동 선택 셀렉트 제출 → `match.teams`에 반영, 공개 메시지·결과 임베드 갱신 |

### `handlers/불러오기.js` — 불러오기

| 함수 | 설명 |
|---|---|
| `handleRMatchSelect(interaction)` | 선택된 내전/모집을 새 메시지로 재게시하고 기존 메시지를 삭제, 매치의 메시지 ID를 갱신 |

### `handlers/끝말잇기.js` — 끝말잇기

| 함수 | 설명 |
|---|---|
| `startWcCommand(interaction)` | `/끝말잇기` 실행 → 대기 로비 생성 |
| `handleWcButton(interaction)` | 참가/시작/봇대결/취소/재대결 버튼 처리 |
| `handleWcMessage(message)` | 채팅 메시지를 현재 차례의 답으로 검증하고 게임 진행 |
| `dueumConvert(char)` *(내부)* | 한글 음절을 초성/중성/종성으로 분해해 두음법칙(ㄹ·ㄴ→ㄴ·ㅇ) 변환 |
| `getAcceptableStarts(lastChar)` *(내부)* | 두음법칙을 반영해 다음 단어로 허용되는 시작 글자 목록 계산 |
| `checkWordExists(word)` *(내부)* | 국립국어원 한국어기초사전 API로 실존 단어 여부 확인 (실패 시 fail-open) |
| `findBotWord(game)` / `botPlay(game, games)` *(내부)* | 봇 참가 시 사전 API에서 후보 단어를 조회해 자동으로 응답 |
| `endGame(game, games, loserId, reason, failWord)` *(내부)* | 게임 종료 처리 및 결과 임베드로 전환, 재대결 만료 타이머 설정 |

### `handlers/명령어로그.js` — 명령어 사용 로그

| 함수 | 설명 |
|---|---|
| `logCommandUsage(interaction)` | 슬래시 커맨드 실행 정보(유저/시각/명령어/옵션)를 `command-log.json`에 append |

### `handlers/음성채널.js` — 임시 음성채널

| 함수 | 설명 |
|---|---|
| `handleTempVoiceState(oldState, newState)` | `voiceStateUpdate` 이벤트 처리: 허브 채널 입장 시 임시 채널 생성, 빈 채널 자동 삭제 |
| `reconcileTempChannels(client)` | 봇 재시작 시 이전에 만든 임시 채널 중 빈 방을 정리 |
| `createTempChannel(newState)` *(내부)* | 임시 음성채널 생성 + 이동 + 채널 관리 권한 부여 |
| `cleanupIfEmpty(oldState, newState)` *(내부)* | 추적 중인 임시 채널이 비면 삭제 |

### `commands/배치.js` — 안내 패널

| 함수 | 설명 |
|---|---|
| `buildCommandListPayload()` | "📖 명령어 보기" 버튼용 전체 명령어 목록 임베드 페이로드 생성 (index.js에서도 재사용) |
| `buildSetupPanelPayload(interaction)` | 안내 패널 임베드/버튼 페이로드 생성 (`/배치` 최초 게시, "🔄 새로고침" 버튼에서 공용) |

### `index.js` — 엔트리 포인트

| 함수 | 설명 |
|---|---|
| `restoreMatches(client)` | 재시작 시 `data.json`으로부터 내전/모집 매치를 복원하고 메시지를 최신 코드로 다시 렌더링 |
| `onReady(client)` | `startedAt` 기록, 매치/레벨 데이터 로드, 음성 상태 초기화, XP 타이커 시작 |

### `db.js` — 영속화

| 함수 | 설명 |
|---|---|
| `matchToJSON(match)` | 직렬화 불가능한 필드(메시지 참조, 타이머 등)를 제외하고 매치를 JSON 변환 |
| `saveAll(client)` | 모든 내전/모집 매치를 `data.json`에 저장 |
| `loadRows()` | `data.json`을 읽어 매치 배열로 반환 (없거나 오류 시 빈 배열) |

## 명령어 사용 로그 (`handlers/명령어로그.js`)

- 슬래시 커맨드가 실행될 때마다(`index.js`의 `interactionCreate` 핸들러) 사용자·시각·명령어·옵션을 `command-log.json`에 기록합니다.
- 각 항목: `timestamp`(KST 기준 `YYYY-MM-DD HH:mm:ss`), `userId`, `username`, `guildId`, `channelId`, `command`, `options`(입력된 옵션 이름/값 배열)
- 매 호출마다 파일 전체를 읽어 배열에 append 후 다시 씁니다(별도 로테이션/용량 제한 없음).

## 데이터 저장 (`db.js`)

- SQLite 등 별도 DB 엔진 없이, `fs`로 `data.json`에 내전/모집 매치를 직렬화해 저장합니다(Discord 메시지 참조·타이머 등 직렬화 불가능한 필드는 저장 전 제외).
- `levels.json`에는 길드별 유저 XP가 저장됩니다.
- 두 파일 모두 30초마다 자동 저장되며, `SIGTERM`/`SIGINT` 종료 시에도 마지막으로 한 번 저장됩니다.
- 봇 재시작 시 `data.json`을 읽어 매치를 복원하고, 실제 채널/메시지를 다시 조회해 최신 코드 기준으로 임베드를 다시 렌더링하며, 남은 자동 종료 시간도 재계산해 타이머를 다시 겁니다.

## 권한

- 관리자 기능(내전/모집 강제 관리, 봇 메시지 삭제, `/배치` 등)은 `handlers/공용.js`의 `ADMIN_IDS`에 등록된 유저만 사용할 수 있습니다.
- 내전/모집의 일반 관리 메뉴(마감/수정/취소 등)는 해당 매치의 주최자 또는 `ADMIN_IDS`만 사용할 수 있습니다.
- `ALLOWED_CHANNEL_ID`에 등록되지 않은 채널에서는 내전/모집/팀 관련 상호작용이 차단됩니다.
- `/끝말잇기`, `/레벨`, `/랭킹`과 관련 버튼은 `ALLOWED_CHANNEL_ID`와 무관하게 `index.js`의 `WORDCHAIN_RANKING_CHANNEL_ID` 채널에서만 사용할 수 있습니다.
- `/불러오기`(및 `불러오기:select`, `recruit:불러오기` 버튼)는 `ALLOWED_CHANNEL_ID`와 무관하게 완료 보너스 채널(`MATCH_BONUS_CHANNEL_ID`)에서만 사용할 수 있습니다 — 다른 채널에서 재게시하면 XP 보너스 자격 판정이 어긋나기 때문입니다.
