// config.js — 서버/채널/유저/이모지 ID 등 배포 환경에 종속된 상수를 한곳에 모은 파일.
// 토큰·API 키 같은 비밀값이 아니라 "이 봇이 어느 서버의 어느 채널에서 도는가"를 나타내는
// 식별자이므로 env가 아니라 코드 상수로 둔다. 다른 서버에 배포할 때는 이 파일만 고치면 된다.
//
// 주의: 이 파일은 다른 모듈을 require 하지 않는다(순수 상수만) — 순환참조 방지.

// 놀이터 채널. 끝말잇기/틱택토/룰렛/레벨/랭킹 사용 제한, 레벨업 축하 메시지, 일일 퀴즈 출제,
// /패널의 놀이터 바로가기 버튼이 모두 이 한 채널을 가리킨다.
const PLAYGROUND_CHANNEL_ID = '1522174367075663872';

// ─── 테스트 서버 ──────────────────────────────────────────────
// 여기 적힌 길드에서는 채널 제한을 걸지 않는다(아무 채널에서나 기능을 확인할 수 있게).
// 비워두면([]) 테스트 서버가 없는 것으로 본다(=모든 서버에 평소 제한이 그대로 적용됨).
const TEST_GUILD_IDS = ['1282694117255548960'];

// 레벨/XP 시스템(레벨.js·룰렛·퀴즈·끝말잇기·틱택토)을 적용하지 않을 길드. 현재는 TEST_GUILD_IDS와
// 값이 같지만 "테스트용이라 채널 제한을 푼다"(isTestGuild)와 "레벨 시스템을 끈다"(isExcludedGuild)는
// 목적이 달라 별도 키로 둔다.
const EXCLUDED_GUILD_IDS = ['1282694117255548960'];

function isTestGuild(guildId) {
  return !!guildId && TEST_GUILD_IDS.includes(guildId);
}

// 여러 파일에서 EXCLUDED_GUILD_IDS.includes(...)로 흩어져 있던 판정을 이 헬퍼로 통일한다.
function isExcludedGuild(guildId) {
  return !!guildId && EXCLUDED_GUILD_IDS.includes(guildId);
}


module.exports = {
  PLAYGROUND_CHANNEL_ID,
  TEST_GUILD_IDS,
  isTestGuild,
  isExcludedGuild,

  // ─── 내전/모집/팀 명령을 허용할 채널 목록 ──────────────────────
  // 비우면([]) 채널 제한 없음. (/패널, /퀴즈와 놀이터·불러오기 전용 상호작용은 이 목록과 무관)
  ALLOWED_CHANNEL_IDS: ['1535971639660122262', '1282694117255548963'],

  // ─── 길드 ID ───────────────────────────────────────────────
  // 임시 음성채널(handlers/음성채널.js)의 대상 길드이자, deploy-commands.js/
  // clear-guild-commands.js가 슬래시 커맨드를 등록/삭제할 길드. 콤마로 여러 개 적으면
  // 그 길드 전부에 커맨드가 등록된다(음성채널 기능은 첫 번째 길드만 사용).
  GUILD_ID: '1339928155359543306',
  HUB_CHANNEL_ID: '1340526081794637864',
  TEMP_CATEGORY_ID: '1339928155359543308',

  // ─── 레벨/XP (handlers/레벨.js) ───────────────────────────────
  // 테스트 서버 등 레벨 시스템을 적용하지 않을 길드 (판정은 isExcludedGuild 헬퍼 사용 권장)
  EXCLUDED_GUILD_IDS,
  // XP 지급을 감지할 채널 (이 채널의 메시지만 XP로 인정)
  XP_CHANNEL_ID: '1340523443413844048',
  // 레벨업 축하 메시지를 보낼 채널
  LEVEL_UP_ANNOUNCE_CHANNEL_ID: PLAYGROUND_CHANNEL_ID,
  // 기본 배율(1배)이 아닌 XP 배율을 적용할 채널 (TTS 채널)
  XP_CHANNEL_MULTIPLIERS: {
    '1374679502394884178': 0.06,
    '1522575222589620254': 0.06,
  },
  // 내전/모집 완료 보너스 XP를 적용할 채널(= 인증 채널)
  MATCH_BONUS_CHANNEL_ID: '1535971639660122262',

  // ─── 퀴즈 (handlers/퀴즈.js) ──────────────────────────────────
  QUIZ_CHANNEL_ID: PLAYGROUND_CHANNEL_ID,

  // ─── 끝말잇기/틱택토/룰렛/레벨/랭킹 사용 허용 채널 (index.js) ──
  WORDCHAIN_RANKING_CHANNEL_ID: PLAYGROUND_CHANNEL_ID,

  // ─── 관리자 유저 ID (handlers/공용.js) ────────────────────────
  ADMIN_IDS: ['457437911869161472', '1043750483522752512', '685917435601092643'],

  // ─── 커스텀 이모지 ────────────────────────────────────────────
  // /내전, /모집의 게임 선택 메뉴에서 공유하는 게임별 이모지
  GAME_EMOJIS: {
    lol: '1510933684750913626',
    valorant: '1510933698349109268',
    overwatch: '1510933569554612324',
    pubg: '1510933567646203964',
  },
  // 직접 입력 게임의 Steam 역할 멘션 토글 버튼 이모지 (handlers/공용.js)
  STEAM_EMOJI_ID: '1510954746012242021',
};
