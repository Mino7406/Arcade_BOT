// 컴포넌트 v2 화면 모음 — 실제 빌더 함수를 불러 모든 화면의 메시지 데이터를 만든다.
//
// 두 가지로 쓴다:
//  1) 테스트(tests/카드테스트.js)가 buildScreens()를 불러 모든 화면이 디스코드 규칙(글자 4000자, 컴포넌트 40개 등)을
//     지키는지 검사한다.
//  2) 그림으로 보고 싶을 때: node tests/카드화면.js <출력 폴더>  → 폴더에 data.js 가 생긴다.
//     같은 폴더에 tests/카드화면.html 을 복사해 두고 브라우저로 열면 디스코드 모양으로 그려진다.
//     (예: python -m http.server --directory <출력 폴더> 로 띄워서 보기)
//
// 화면을 추가하면 아래 add(...) 한 줄만 더하면 테스트와 그림에 같이 들어간다.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const req = p => require(path.join(ROOT, p));

// 소스에서 notice('…')/quick('…') 의 첫 번째 문구를 전부 뽑는다(예시 페이지에 모든 경고·안내가 자동으로 들어가도록).
// ${…} 자리는 〈…〉 로 바꿔 보여 준다. 같은 문구는 한 번만, 파일(기능)별로 묶는다.
function extractNotices() {
  const roots = ['handlers', 'forms', 'commands'];
  const files = ['index.js'];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel); else if (e.name.endsWith('.js')) files.push(rel);
    }
  };
  roots.forEach(walk);
  const re = /\b(?:notice|quick)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  const seen = new Set();
  const out = [];
  for (const rel of files.sort()) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(re)) {
      let t = m[2]
        .replace(/\\n/g, '\n').replace(/\\(['"`\\])/g, '$1')
        .replace(/\$\{[^}]*\}/g, '〈…〉');
      t = t.trim();
      if (!t || t.length < 4 || seen.has(t)) continue;
      seen.add(t);
      out.push({ file: rel.split(path.sep).join('/'), text: t });
    }
  }
  return out;
}

async function buildScreens() {
  // /관리 홈은 실행 중인 패치노트 감시기의 상태를 읽는다 — 그림용으로 가짜 상태를 끼워 넣는다(관리 모듈을 부르기 전에).
  const now = Date.now();
  let patchState = {
    paused: false, today: 2,
    games: [
      { id: 'lol', name: '리그 오브 레전드', kind: 'patch', lastAt: now - 60e3, ok: true },
      { id: 'lol-maint', name: '리그 오브 레전드', kind: 'maintenance', lastAt: now - 60e3, ok: true },
      { id: 'valorant', name: '발로란트', kind: 'patch', lastAt: now - 90e3, ok: true },
      { id: 'overwatch', name: '오버워치', kind: 'patch', lastAt: now - 3 * 60e3, ok: false },
      { id: 'pubg', name: '배틀그라운드', kind: 'patch', lastAt: now - 59e3, ok: true },
    ],
  };
  req('handlers/관리/패치노트.js').getPatchNoteStatus = () => patchState;
  // 랭킹은 레벨링 데이터 대신 가짜 순위를 쓴다(랭킹·레벨 모듈을 부르기 전에 패치).
  const lv = req('handlers/레벨/레벨링.js');
  lv.getLeaderboardSize = () => 12;
  lv.getLeaderboard = (g, limit, offset) => Array.from({ length: 12 }, (_, i) => ({
    userId: 'u' + i, rank: i + 1, level: 14 - i, xp: 9200 - i * 610, currentLevelXp: 120 + i * 37, neededXp: 480,
  })).slice(offset, offset + limit);
  lv.getXp = () => 3120;

  const { buildPublicMessagePayload } = req('handlers/매치/내전.js');
  const { buildMojipMessagePayload } = req('handlers/매치/모집.js');
  const common = req('handlers/매치/공용.js');
  const card = req('handlers/공통/카드.js');
  const team = req('handlers/매치/팀.js');
  const ttt = req('handlers/게임/틱택토.js');
  const omok = req('handlers/게임/오목.js');
  const wc = req('handlers/게임/끝말잇기.js');
  const rl = req('handlers/게임/룰렛.js');
  // 해킹 툴 앱 이모지는 봇이 켜져야 ID가 생기므로, 화면 모음에선 자리표시 ID를 넣고 그림은 로컬 파일로 보여 준다(LOCAL_EMOJI).
  req('handlers/게임/해킹툴.js').setHackToolEmojiId('0');
  req('handlers/게임/블랙월게이트웨이.js').setGatewayEmojiId('0');
  req('handlers/매치/티어.js').usePreviewPositionEmojis(); // 포지션 아이콘도 같은 방식(LOCAL_EMOJI 의 pos_… 그림)
  // 전적 탭 버튼의 앱 이모지(rec_…)도 자리표시 ID 로 "등록된 것처럼" 만들고, 그림은 로컬 파일로 보여 준다
  await req('handlers/전적/이모지.js').ensureRecordEmojis({ application: { emojis: { fetch: async () => [], create: async ({ name }) => ({ id: '0', name }) } } });
  const xp = req('handlers/관리/XP.js').views;
  const panel = req('handlers/관리/패널.js');
  const rank = req('handlers/레벨/랭킹.js');
  const level = req('handlers/레벨/레벨카드.js');
  const quizMod = req('handlers/게임/퀴즈.js');
  const mark = req('forms/마크/index.js');
  const cob = req('forms/코블몬/index.js');
  const naejeonMod = req('handlers/매치/내전.js');
  const quizCmd = req('handlers/관리/퀴즈관리.js');
  const gameSelect = req('handlers/매치/메뉴.js');
  const reload = gameSelect; // 메뉴 화면 빌더(게임 선택·불러오기 목록)는 handlers/매치/메뉴.js 에 모여 있다
  const { ButtonBuilder, ButtonStyle } = require('discord.js');

  const users = n => Array.from({ length: n }, (_, i) => ({ id: String(100 + i), displayName: ['민호', '지수', '하늘', '도윤', '서연', '준호', '예린', '태양', '나래', '현우'][i % 10] }));
  const GAMES = {
    lol: { name: '리그 오브 레전드', emoji: '<:Lol:1510933684750913626>', color: 0xC89B3C },
    val: { name: '발로란트', emoji: '<:Val:1510933698349109268>', color: 0xFF4655 },
    custom: { name: '마인크래프트', emoji: '🎮', color: 0x5865F2 },
  };
  const base = (g, extra = {}) => ({ game: g === 'custom' ? 'custom' : g, gameInfo: GAMES[g], title: `${GAMES[g].name} ${extra.label ?? '내전'}`, datetime: '11월 15일 오후 9시', players: '10', description: '', organizer: { id: '1', displayName: '민호' }, ...extra.data });
  const nowPlus = h => Date.now() + h * 3600e3;
  const png = files => Object.fromEntries((files || []).map(f => [f.name, 'data:image/png;base64,' + Buffer.from(f.attachment).toString('base64')]));

  const screens = [];
  const add = (group, title, note, p, extra = {}) => screens.push({
    group, title, note, ...extra,
    components: p.components.map(c => (c.toJSON ? c.toJSON() : c)),
    ephemeral: !!(p.flags & 64),
    payload: p, // 테스트가 content/embeds/flags 를 확인할 때 쓴다(그림 데이터에는 들어가지 않음)
  });

  // ── 내전 / 모집 ───────────────────────────────
  add('내전 · 모집', '내전 모집 중', '게임 색 띠 + 게임 아이콘 + 진행 막대 + 버튼이 카드 안에 · 알림 예약 중이면 상태 옆에 🔔', buildPublicMessagePayload({
    data: base('lol', { data: { description: '다이아 이하 환영 · 마이크 필수', notifyAt: nowPlus(2) } }), participants: users(6), closed: false, teams: null, roleContent: '<@&1> ',
  }));
  add('내전 · 모집', '내전 정원 차서 자동 마감', '정원이 차면 자동으로 마감됨(초록 띠) — "모집 완료" 상태는 없어졌어요', buildPublicMessagePayload({ data: base('val'), participants: users(10), closed: true, teams: null }));
  add('내전 · 모집', '내전 마감 + 팀 배정', '팀 1 / 팀 2가 위아래로', buildPublicMessagePayload({ data: base('lol'), participants: users(10), closed: true, teams: { team1: users(10).slice(0, 5), team2: users(10).slice(5) } }));
  add('내전 · 모집', '모집 (가벼운 인원 모집)', '', buildMojipMessagePayload({ data: base('custom', { label: '모집', data: { players: '4', description: '렐름 같이 하실 분' } }), participants: users(2), closed: false }));
  add('내전 · 모집', '게시 전 미리보기', '작성자에게만 보이는 임시 메시지', common.buildPreviewPayload('naejeon', base('lol', { data: { description: '메모 예시', notifyAt: nowPlus(3) } }), { ephemeral: true }));
  add('내전 · 모집', '취소된 내전', '', card.payload(common.buildCancelledCard({ label: '내전', data: base('lol'), byOrganizer: true })));
  add('내전 · 모집', '팀 배정 완료 알림', '팀을 나누면 채널에 올라오는 카드', card.payload(common.buildTeamResultCard(base('lol'), { team1: users(10).slice(0, 5), team2: users(10).slice(5) })));
  add('내전 · 모집', '팀 설정 카드(처음)', '내전이 마감되면 내전채팅에 자동으로 올라가는 카드', team.buildBoardPayload({ data: base('lol'), participants: users(10), closed: true }, '1'));
  const boardMsg = { url: 'https://discord.com/channels/1/2/3', channelId: '2' };
  add('내전 · 모집', '팀 설정 바로가기', '내전채팅에 팀 설정 카드가 올라오면 내전 게시글에 답장으로 달려요 · 참가자 멘션처럼 내전이 지워질 때 같이 지워져요', team.buildBoardShortcutPayload({ data: base('lol') }, boardMsg, { style: 'plain' }));
  add('내전 · 모집', '팀 설정 카드(팀 정한 뒤)', '지금 팀은 크게, 이전 팀표는 작게', team.buildBoardPayload({ data: base('lol'), participants: users(10), closed: true, board: { current: { how: 'balance', at: Date.now(), teams: [{ name: null, members: users(10).slice(0, 5).map(u => u.displayName) }, { name: '맵', members: users(10).slice(5).map(u => u.displayName) }] }, history: [1, 2].map(n => ({ at: Date.now() - n * 3600e3, how: 'input', teams: [{ name: null, members: users(10).slice(0, 5).map(u => u.displayName) }, { name: null, members: users(10).slice(5).map(u => u.displayName) }] })) } }, '1'));
  // 포지션: 저장 파일을 건드리지 않게 티어 조회 함수만 잠깐 바꿔 끼워 그린다.
  {
    const tm = req('handlers/매치/티어.js');
    const orig = { getTier: tm.getTier, getPositions: tm.getPositions, getRoleTiers: tm.getRoleTiers, openTier: tm.openTier, hasRoleQueueTier: tm.hasRoleQueueTier };
    const LOL = ['top', 'jungle', 'mid', 'adc', 'support'];
    const VAL = ['duelist', 'initiator', 'controller', 'sentinel'];
    const lolTiers = [['diamond', 2], ['emerald', 1], ['platinum', 3], ['diamond', 4], ['gold', 1], ['emerald', 3], ['diamond', 1], ['platinum', 1], ['emerald', 4], ['gold', 2]];
    const owTiers = { 100: { tank: ['diamond', 2] }, 101: { damage: ['master', 4], support: ['diamond', 1] }, 102: { damage: ['platinum', 2] }, 103: { support: ['emerald', 3] }, 104: { support: ['gold', 1], tank: ['platinum', 5] }, 105: { tank: ['emerald', 2] }, 106: { damage: ['diamond', 3] }, 107: { damage: ['emerald', 1] }, 108: { support: ['diamond', 5] }, 109: { support: ['platinum', 1] } };
    const fake = (uid, gk) => {
      const i = Number(uid) - 100;
      const [game, role] = String(gk).split('.');
      if (game === 'lol' && lolTiers[i]) return { tier: lolTiers[i][0], div: lolTiers[i][1] };
      if (game === 'overwatch') {
        const rt = owTiers[uid] || {};
        if (role) return rt[role] ? { tier: rt[role][0], div: rt[role][1] } : null;
        const best = Object.values(rt).map(([tier, div]) => ({ tier, div })).sort((a, b) => tm.tierScore('overwatch', b) - tm.tierScore('overwatch', a))[0];
        return best || null;
      }
      if (uid === 'me') return orig.getTier(uid, gk);
      return null;
    };
    tm.getTier = fake;
    tm.getRoleTiers = uid => Object.fromEntries(tm.OW_ROLES.map(r => [r.key, fake(uid, `overwatch.${r.key}`)]));
    tm.openTier = uid => tm.getTier(uid, 'overwatch.open') ?? tm.getTier(uid, 'overwatch');
    tm.hasRoleQueueTier = uid => tm.OW_ROLES.some(r => !r.open && tm.getTier(uid, `overwatch.${r.key}`));
    tm.getPositions = (uid, game) => {
      const i = Number(uid) - 100;
      if (uid === 'me') return game === 'lol' ? ['mid', 'jungle'] : [];
      if (game === 'lol' && i >= 0 && i !== 4 && i !== 9) return [LOL[(i * 2) % 5], LOL[(i * 2 + 1) % 5]]; // 두 명은 포지션 없음
      if (game === 'valorant' && i >= 0 && i !== 4 && i !== 9) return i % 3 === 2 ? [VAL[i % 4]] : [VAL[i % 4], VAL[(i + 1) % 4]]; // 역할이 고정이 아니라 가능한 역할 2개(하나만 적은 사람·안 적은 사람도 섞음)
      return [];
    };
    const owInfo = { name: '오버워치', emoji: '🎮', color: 0xF99E1A };
    const halves = us => [{ name: null, members: us.slice(0, 5).map(u => u.displayName) }, { name: null, members: us.slice(5).map(u => u.displayName) }];
    const named = users(10);
    const histBoard = { data: base('lol'), participants: users(10), closed: true, board: { current: { how: 'balance', at: Date.now(), no: 3, teams: halves(users(10)) }, history: [2, 1].map(n => ({ at: Date.now() - n * 3600e3, no: n, how: n === 2 ? 'input' : 'balance', teams: halves(users(10)) })) } };
    add('내전 · 모집', '팀 설정 내전 내역(📜 버튼)', '카드는 짧게 두고 이전 팀표는 두 번째 줄의 📜 내전 내역 버튼으로 나만 보이는 창에 열어요', team.buildHistoryPayload(histBoard, '1'));
    // 🗺️ 맵 추첨: 발로란트·오버워치 카드(결과·연출 중). 첨부는 jpg 라서 jpg 데이터 주소로 넣는다.
    const jpg = p => ({ files: Object.fromEntries((p.files || []).map(f => [f.name, 'data:image/jpeg;base64,' + require('fs').readFileSync(f.attachment).toString('base64')])) });
    const mapBoard = (game, info, title, map) => ({ data: { ...base('lol'), game, gameInfo: info, title }, participants: named, closed: true, board: { current: { how: 'balance', at: Date.now(), no: 1, teams: halves(named) }, history: [], ...(map ? { map } : {}) } });
    const valBoard = mapBoard('valorant', GAMES.val, '발로란트 내전', { game: 'valorant', key: 'ascent', at: Date.now() - team.MAP_LOCK_MS - 60e3 });
    const owBoard = mapBoard('overwatch', owInfo, '오버워치 내전', { game: 'overwatch', key: 'grimsvotn', at: Date.now() });
    const valP = team.buildBoardPayload(valBoard, '1');
    add('내전 · 모집', '팀 설정 카드(맵 추첨 결과 · 발로란트)', '윗줄 ✔️ 맵 추첨 완료 - **[맵 이름]** 아래에 이름이 알약 박스 위에 박힌 맵 이미지 · 뽑은 지 5분이 지나서 두 번째 줄의 🔍 맵 추첨가 눌려요', valP, jpg(valP));
    const owP = team.buildBoardPayload(owBoard, '1');
    add('내전 · 모집', '팀 설정 카드(맵 추첨 결과 · 오버워치)', '오버워치는 호위·혼합·밀기·쟁탈·플래시포인트 전체 맵에서 같은 확률 · 방금 뽑아서 🔒 맵 추첨 버튼이 5분간 비활성화(회색)돼요', owP, jpg(owP));
    team.__mapSpin.set('1', { key: 'busan', n: 3 });
    const spinP = team.buildBoardPayload(mapBoard('overwatch', owInfo, '오버워치 내전', null), '1');
    team.__mapSpin.delete('1');
    add('내전 · 모집', '팀 설정 카드(맵 뽑는 중)', '누르는 순간 헤더가 ### 🔍 맵 추첨 중... 이 되고 버튼이 잠겨요 · 이름 없는 맵 이미지가 5번 바뀌고 점점 느려져요(총 약 5초)', spinP, jpg(spinP));
    add('내전 · 모집', '팀 설정 카드(내역 버튼이 켜진 모습)', '내전 내역이 있으면 📜 내전 내역 (개수) 버튼이 두 번째 줄에 눌리게 보여요', team.buildBoardPayload(histBoard, '1'));
    add('내전 · 모집', '팀 설정 카드(롤 포지션)', '포지션을 저장한 사람이 있으면 5명 팀마다 탑~서포터를 맡기고 그 순서로 줄을 세움', team.buildBoardPayload({ data: base('lol'), participants: named, closed: true, board: { current: { how: 'balance', at: Date.now(), no: 2, teams: halves(named) }, history: [] } }, '1'));
    add('내전 · 모집', '팀 설정 카드(발로란트 역할)', '발로란트는 역할이 고정이 아니라 가능한 역할 2개(주·부)를 티어 앞에 나란히 보여 줌 · 안 정한 사람은 투명 아이콘으로 칸만 맞춤', team.buildBoardPayload({ data: { ...base('lol'), game: 'valorant', gameInfo: owInfo, title: '발로란트 내전' }, participants: named, closed: true, board: { current: { how: 'balance', at: Date.now(), no: 1, teams: halves(named) }, history: [] } }, '1'));
    add('내전 · 모집', '팀 설정 카드(오버워치 역할별 티어)', '돌격1·공격2·지원2로 맡기고, 맡은 역할의 티어를 보여 줌', team.buildBoardPayload({ data: { ...base('lol'), game: 'overwatch', gameInfo: owInfo, title: '오버워치 내전' }, participants: named, closed: true, board: { current: { how: 'balance', at: Date.now(), no: 1, teams: halves(named) }, history: [] } }, '1'));
    const twelve = users(12).map((u, i) => (i >= 10 ? { ...u, displayName: u.displayName + '2' } : u));
    owTiers[110] = { tank: ['master', 3] }; owTiers[111] = { tank: ['gold', 2], damage: ['platinum', 4] };
    owTiers[100].open = ['master', 2]; owTiers[103].open = ['diamond', 4]; owTiers[107].open = ['grandmaster', 5];
    add('내전 · 모집', '팀 설정 카드(오버워치 6vs6)', '6vs6은 자유(오픈 큐): 역할 없이 자유 티어(없으면 가장 높은 역할 티어)로 계산', team.buildBoardPayload({ data: { ...base('lol'), game: 'overwatch', gameInfo: owInfo, title: '오버워치 6vs6 내전', players: '12' }, participants: twelve, closed: true, board: { current: { how: 'balance', at: Date.now(), no: 1, teams: [{ name: null, members: twelve.slice(0, 6).map(u => u.displayName) }, { name: null, members: twelve.slice(6).map(u => u.displayName) }] }, history: [] } }, '1'));
    tm.getTier = (uid, gk) => (uid === 'me' ? fake('100', gk) ?? fake('101', gk) : fake(uid, gk));
    tm.getRoleTiers = uid => Object.fromEntries(tm.OW_ROLES.map(r => [r.key, fake(uid === 'me' ? '104' : uid, `overwatch.${r.key}`)]));
    add('나만 보이는 메시지', '🏅 내 티어 설정 — 롤(포지션 버튼)', '티어 고르기 아래 🧭 포지션 설정', team.buildTierPickPayload('lol', '1', 'me'));
    add('나만 보이는 메시지', '🧭 포지션 설정', '주/부 포지션을 고르면 바로 저장', team.buildPositionPayload('lol', '1', 'me'));
    add('나만 보이는 메시지', '🏅 내 티어 설정 — 오버워치 역할 고르기', '돌격·공격·지원 티어를 따로 저장(저장한 역할은 초록)', team.buildOwRolesPayload('1', 'me'));
    add('나만 보이는 메시지', '🏅 내 티어 설정 — 오버워치 돌격 티어', '', team.buildTierPickPayload('overwatch.tank', '1', 'me'));
    add('나만 보이는 메시지', '🏅 내 티어 설정 — 내 티어 정보(패널)', '게임마다 이름 줄 + 인용 줄, 오른쪽에 🗑️ 전체 초기화', team.buildTierGamePayload('me'));
    add('나만 보이는 메시지', '🗑️ 전체 초기화 확인', '', team.buildResetAllConfirmPayload());
    {
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      add('나만 보이는 메시지', '⚠️ 팀 다시 만들기 경고(✏️·⚖️·🎲)', '이미 정한 팀이 있을 때만 · 만들면 이 창은 자동 삭제', card.notice('⚠️ **이미 설정한 팀이 있어요.**\n⚖️ 밸런스(으)로 다시 만들면 지금 팀은 📜 내전 내역으로 넘어가요.', {
        ephemeral: true,
        rows: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('team:regen:balance:1').setLabel('다시 만들기').setEmoji('🔁').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('team:regen_no:1').setLabel('취소').setStyle(ButtonStyle.Secondary),
        )],
      }));
    }
    Object.assign(tm, orig);
  }
  add('내전 · 모집', '안내 한 줄 — 만료', '모든 짧은 안내가 같은 카드 모양', card.notice('⚠️ **만료된 내전입니다.**', { ephemeral: true }));
  add('내전 · 모집', '안내 한 줄 — 완료', '', card.notice('✅ **채널에 공개 게시되었습니다!**', { ephemeral: true }));

  // 나만 보이는 메뉴·안내 (버튼을 눌렀을 때 뜨는 임시 메시지)
  const mm = (extra = {}) => ({ data: base('lol'), participants: users(6), closed: false, teams: null, ...extra });
  add('나만 보이는 메시지', '주최자 관리 메뉴 (모집 중)', '제목·상태·버튼이 한 카드에', common.buildManagePayload({ label: '내전', match: mm(), rows: naejeonMod.buildManageMenu(mm(), '1'), ephemeral: true }));
  add('나만 보이는 메시지', '주최자 관리 메뉴 (마감 + 조작 결과)', '방금 한 조작 결과가 맨 위에', common.buildManagePayload({ label: '내전', match: mm({ closed: true }), note: '✅ **내전이 마감되었습니다.**', rows: naejeonMod.buildManageMenu(mm({ closed: true }), '1') }));
  add('나만 보이는 메시지', '주최자 관리 메뉴 (멘션 쿨타임 중)', '📣 참가자 멘션 버튼이 30분 동안 잠기고 남은 분이 붙어요', common.buildManagePayload({ label: '내전', match: mm({ closed: true, mentionSent: true, mentionAt: Date.now() - 18 * 60000 }), note: '📣 **참가자에게 멘션을 보냈습니다.**', rows: naejeonMod.buildManageMenu(mm({ closed: true, mentionSent: true, mentionAt: Date.now() - 18 * 60000 }), '1') }));
  add('나만 보이는 메시지', '멘션 쿨타임 안내', '쿨타임 중 버튼을 누른 경우', common.buildManagePayload({ label: '내전', match: mm({ closed: true, mentionAt: Date.now() - 18 * 60000 }), note: '⚠️ **멘션은 42분 뒤에 다시 보낼 수 있습니다.**', rows: naejeonMod.buildManageMenu(mm({ closed: true, mentionAt: Date.now() - 18 * 60000 }), '1') }));
  add('나만 보이는 메시지', '참가 완료 안내 + 참가 취소', '이전엔 평문 한 줄이었던 화면', card.notice('✅ **참가 완료!** 명단에 등록되었습니다.\n취소하려면 아래 버튼을 눌러주세요.', { rows: [naejeonMod.buildLeaveButton('1')], ephemeral: true }));
  add('나만 보이는 메시지', '게임 선택 메뉴', '', gameSelect.buildNaejeonGameSelectPayload('1'));
  add('나만 보이는 메시지', '불러오기 목록', '', reload.buildReloadListPayload({ guildId: '1', client: { naejeonMatches: new Map([['1', { guildId: '1', participants: users(3), closed: false, data: base('lol') }]]), mojipMatches: new Map() } }));
  add('나만 보이는 메시지', '권한 없음 / 오류 안내', '', card.notice('❌ **내전 주최자만 팀을 관리할 수 있습니다.**', { ephemeral: true }));
  add('나만 보이는 메시지', '패널 관리 메뉴', '', panel.buildAdminMenuPayload('1', '✅ **패널을 새로고침했습니다.**'));
  add('나만 보이는 메시지', '삭제 확인', '', panel.buildMatchDeleteConfirmPayload('1', 'naejeon', '2', '"롤 내전" 내전'));
  add('나만 보이는 메시지', '렐름 명단 관리', '', mark.buildRealmRosterAdminMenuPayload('✅ **명단을 새로고침했습니다.**'));
  add('나만 보이는 메시지', '퀴즈 관리 — 작동 중', '일시정지 버튼이 상태 줄 오른쪽에 따로', quizCmd.buildQuizPanelPayload('1'));

  // ── 놀이터 게임 ───────────────────────────────
  const lobby = (n, extra = {}) => ({ id: '1', hostId: '1', lobbyPlayers: users(n).map(u => ({ id: u.id, name: u.displayName })), infinite: false, status: 'waiting', ...extra });
  add('틱택토', '대기 로비', '', ttt.buildLobbyPayload(lobby(1)));
  const tttPlay = { id: '1', status: 'playing', players: { X: '100', O: '101' }, currentTurn: 'O', board: ['X', '', 'O', '', 'X', '', '', '', ''], marks: { X: [0, 4], O: [2] }, infinite: false };
  add('틱택토', '진행 중 (판 버튼이 카드 안)', '', ttt.buildGamePayload(tttPlay));
  add('틱택토', '무한모드 진행', '', ttt.buildGamePayload({ ...tttPlay, infinite: true, board: ['X', 'O', 'X', 'O', 'X', '', '', 'O', ''], marks: { X: [0, 2, 4], O: [1, 3, 7] } }));
  add('틱택토', '승리 + XP 내기 결과', '재대결·종료 버튼은 카드 밖 맨 아래', ttt.buildGamePayload({ ...tttPlay, status: 'finished', winner: 'X', board: ['X', 'O', 'O', '', 'X', '', '', '', 'X'], xpResult: { type: 'wager', wager: 50, winnerId: '100', loserId: '101' } }));

  const omokPlay = { id: '1', status: 'playing', players: { B: '100', W: 'BOT' }, turn: 'B', board: (() => { const b = Array(225).fill(''); [[7, 7, 'B'], [8, 7, 'W'], [8, 8, 'B'], [6, 6, 'W'], [9, 9, 'B']].forEach(([x, y, c]) => { b[y * 15 + x] = c; }); return b; })(), lastMove: { x: 9, y: 9 }, moveCount: 5 };
  add('오목', '대기 로비', '', omok.buildLobbyPayload({ id: '1', hostId: '1', lobbyPlayers: [{ id: '100', name: '민호' }], status: 'waiting' }));
  const omokP = await omok.playingPayload(omokPlay);
  add('오목', '진행 중 (판 그림 + 포기 버튼)', '', omokP, { files: png(omokP.files) });
  const omokF = await omok.finishedPayload({ ...omokPlay, status: 'finished', winner: 'B', endReason: 'five', xpResult: { type: 'bot_win', winnerId: '100', amount: 35 } });
  add('오목', '승리', '', omokF, { files: png(omokF.files) });

  const wcBase = { id: '1', hostId: '100', players: [{ id: '100', name: '민호' }, { id: '101', name: '지수' }, { id: 'BOT', name: '봇' }], currentIdx: 1, history: ['사과', '과일', '일기', '기차', '차표'], lastWord: '차표', lastChar: '표', status: 'playing', humanPlayers: [{ id: '100', name: '민호' }, { id: '101', name: '지수' }], accepted: new Set(['100']), hadBot: true };
  add('끝말잇기', '대기 로비', '', wc.waitingPayload({ ...wcBase, status: 'waiting' }));
  add('끝말잇기', '진행 중', '', wc.playingPayload(wcBase));
  add('끝말잇기', '종료 + 내기 결과', '', wc.finishedPayload({ ...wcBase, status: 'finished', loser: '101', endReason: 'timeout', xpResult: { type: 'wager', loserId: '101', wager: 50, winnerResults: [{ userId: '100', amount: 50 }] } }));
  add('끝말잇기', '재대결 신청', '', wc.rematchRequestPayload(wcBase));

  const rlb = { id: '1', userId: '100', bet: 100, maxAvailable: 300, hackTools: 2 };
  const rlWith = (p) => ({ files: png(p.files) });
  const rlLobby = rl.buildLobbyPayload(rlb, { ephemeral: true, withImage: true });
  add('룰렛', '베팅 선택(본인에게만)', '그림으로 그린 슬롯머신(대기 화면은 한 번만 그려 재사용)', rlLobby, rlWith(rlLobby));
  const rlSpin = rl.buildSpinningPayload(rlb, 100, ['🍒', '🍋', null], 2);
  add('룰렛', '릴 도는 중', '릴이 하나씩 멈춰요(수정 3번)', rlSpin, rlWith(rlSpin));
  const rlWin = rl.buildResultPayload(rlb, { bet: 100, resultLine: '🙂 **더블 매칭!** (x1.2)', netLine: '📈 **+20 XP**', net: 20, reels: ['🍇', '🍇', '🔔'], multiplier: 1.2 });
  add('룰렛', '결과 — 더블 매칭', '', rlWin, rlWith(rlWin));
  const rlJack = rl.buildResultPayload(rlb, { bet: 300, resultLine: '🎉 **JACKPOT!** (x10)', netLine: '📈 **+2700 XP**', net: 2700, reels: ['7️⃣', '7️⃣', '7️⃣'], multiplier: 10 });
  add('룰렛', '결과 — 잭팟', '', rlJack, rlWith(rlJack));
  const rlLose = rl.buildResultPayload(rlb, { bet: 300, resultLine: '😢 **꽝**', netLine: '📉 **-300 XP**', net: -300, reels: ['💎', '🍒', '🍋'], multiplier: 0 });
  add('룰렛', '결과 — 꽝', '', rlLose, rlWith(rlLose));
  add('룰렛', '꽝 → 해킹 툴 사용 확인(본인에게만)', '해킹 툴이 있을 때만 · 60초 지나면 결과 확정', rl.buildHackPromptPayload({ id: '1', bet: 300 }, 2, { ephemeral: true }));
  add('룰렛', '결과 직후 → 속성 재회전석 사용 확인(본인에게만)', '알바트리온 MVP 보상 · 재회전석이 있을 때만 · 릴 한 칸만 다시 돌림 · 60초 지나면 결과 확정', rl.buildRerollPromptPayload({ id: '1', bet: 300, spin: { reels: ['🍒', '🍒', '🍋'], kind: 'two', multiplier: 1.5, payout: 450 } }, 1, { ephemeral: true }));
  const rlHack = rl.buildResultPayload(rlb, { bet: 300, resultLine: '**🍋 레몬 트리플 매칭!** (×2.5)', netLine: '📈 **+450 XP**', net: 450, reels: ['🍋', '🍋', '🍋'], multiplier: 2.5, hacks: 1 });
  [0, 1, 2].forEach(step => {
    const intro = rl.buildHackIntroPayload(rlb, 300, ['💎', '🍒', '🍋'], step, 1);
    add('룰렛', `해킹 침입 연출 ${step + 1}/3`, ['기계가 물들고 ARCADE ROULETTE 글자가 깨지기 시작 · 해골 등장', 'ARCADE ROULETTE 글자가 더 깨짐 · 해골 커짐', '해킹된 기계 정중앙에 큰 해골'][step], intro, rlWith(intro));
  });
  const rlHackSpin = rl.buildSpinningPayload(rlb, 300, ['🍋', null, null], 1, 1);
  add('룰렛', '해킹 툴로 다시 돌리는 중', '해킹된 기계 — 보라·시안 + 해골 + 글리치', rlHackSpin, rlWith(rlHackSpin));
  // 블랙월 게이트웨이 룰렛(사전 해킹): 로비의 사용 버튼 → 돌리기 전 잠식 4단계 → 블랙월 룰렛(7️⃣만 돎) → 100% 잭팟
  const gwLobby = { ...rlb, gateways: 2, gatewayArmed: false };
  const gwL0 = rl.buildLobbyPayload(gwLobby, { ephemeral: true, withImage: true });
  add('룰렛', '게이트웨이 — 로비(사용 전)', '게이트웨이가 있으면 로비에 보유 수와 🌐 사용 버튼이 보임', gwL0, rlWith(gwL0));
  const gwL1 = rl.buildLobbyPayload({ ...gwLobby, gatewayArmed: true }, { ephemeral: true, withImage: true });
  add('룰렛', '게이트웨이 — 로비(사용됨)', '사용하면 버튼이 초록 "사용됨"으로 바뀜(다시 누르면 취소)', gwL1, rlWith(gwL1));
  for (let step = 0; step < rl.WALL_EROSION.length; step++) {
    const er = rl.buildWallErosionPayload(rlb, 300, step);
    add('룰렛', `게이트웨이 — 돌리기 전 잠식 ${step}/${rl.WALL_EROSION.length - 1}`, ['사용 직후 — 아직 멀쩡한 평범한 룰렛', '평범한 룰렛이 가장자리부터 붉은 선·막대·테두리 사각형으로 잠식당함', '잠식이 번져 나감', '대부분 블랙월로 덮임', '거의 다 덮임 — 곧 블랙월 룰렛이 돌아감'][step], er, rlWith(er));
  }
  const gwSpin = rl.buildSpinningPayload(rlb, 300, ['7️⃣', null, null], 1, 0, true);
  add('룰렛', '게이트웨이 — 잠식이 끝난 뒤 도는 중', '완전히 블랙월이 된 룰렛 · 릴엔 7️⃣만 돎', gwSpin, rlWith(gwSpin));
  const gwWin = rl.buildResultPayload(rlb, { bet: 300, resultLine: '🎉 **JACKPOT!** (x10)', netLine: '📈 **+2700 XP**', net: 2700, reels: ['7️⃣', '7️⃣', '7️⃣'], multiplier: 10, gateway: true });
  add('룰렛', '게이트웨이 — 결과(100% 잭팟)', '블랙월 테마 결과 카드 · 부제에 블랙월 게이트웨이 사용', gwWin, rlWith(gwWin));
  add('룰렛', '결과 — 해킹 툴로 번복', '해킹된 기계 그림 · 보라 띠 · 부제에 사용 횟수', rlHack, rlWith(rlHack));

  // ── 레벨 · 랭킹 · 퀴즈 ────────────────────────
  const guild = { id: 'g', members: { fetch: async ({ user }) => new Map(user.map((id, i) => [id, { displayName: ['민호', '지수', '하늘', '도윤', '서연', '준호', '예린', '태양', '나래', '현우', '다온', '시우'][i % 12] }])) } };
  add('레벨 · 랭킹 · 퀴즈', '랭킹 1페이지', '', (await rank.buildRankingView(guild, 1, true)).payload);
  add('레벨 · 랭킹 · 퀴즈', '레벨 카드', '', level.buildLevelPayload('g', { id: '100', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' }, '민호'));
  add('레벨 · 랭킹 · 퀴즈', '오늘의 퀴즈', '', card.payload(quizMod.buildQuizCard({ word: '고양이', hint: '집에서 기르는 작은 동물로, 야옹 하고 운다.', grade: '쉬움', xpReward: 40 })));

  add('레벨 · 랭킹 · 퀴즈', '레벨업 축하', '', req('handlers/레벨/레벨링.js').buildLevelUpPayload('100', 8));
  add('레벨 · 랭킹 · 퀴즈', '퀴즈 정답', '정답자 프로필 썸네일 + 걸린 시간 + 보상', quizMod.buildCorrectPayload({ word: '바늘꽂이', xpReward: 200, grade: '초급', solverName: '유민', solverAvatar: 'https://cdn.discordapp.com/embed/avatars/2.png', elapsedMs: 192000 }));
  add('레벨 · 랭킹 · 퀴즈', '퀴즈 정답 (XP 긴급정지 중)', '', quizMod.buildCorrectPayload({ word: '고양이', grade: '중급', frozen: true, solverName: '민호', solverAvatar: 'https://cdn.discordapp.com/embed/avatars/1.png', elapsedMs: 45000 }));

  // ── 패치노트·점검 알림(공지 채널에 올라오는 카드) ───────
  const pnMod = req('handlers/관리/패치노트.js');
  const pnGame = (id) => pnMod.GAMES.find(g => g.id === id);
  const day = Date.parse('2026-11-12T03:00:00Z');
  add('패치노트 알림', '리그 오브 레전드 — 새 패치노트', '공지 채널에 올라오는 카드(게임 색 띠 + 게임 아이콘 + 내용 보기 링크)', pnMod.buildPatchNotePayload(pnGame('lol'), { key: 'k1', title: '리그 오브 레전드 26.22 패치 노트', url: 'https://www.leagueoflegends.com/ko-kr/news/game-updates/patch-26-22-notes/', at: day }));
  add('패치노트 알림', '발로란트 — 점검 공지', '', pnMod.buildPatchNotePayload(pnGame('valorant-maint'), { key: 'k2', title: '정기 점검 (KST 06:00~10:00)', url: 'https://status.riotgames.com/valorant', at: day }));
  add('패치노트 알림', '오버워치 — 새 패치노트', '', pnMod.buildPatchNotePayload(pnGame('overwatch'), { key: 'k3', title: '오버워치 패치 노트 - 2026년 11월 12일', url: 'https://overwatch.blizzard.com/ko-kr/news/patch-notes/', at: day }));
  add('패치노트 알림', '배틀그라운드 — 새 패치노트(PC·콘솔)', '', pnMod.buildPatchNotePayload(pnGame('pubg'), { key: 'k4', title: '41.1 업데이트 안내', url: 'https://www.pubg.com/ko/news', at: day, note: 'PC · 콘솔' }));
  add('패치노트 알림', '배틀그라운드 — 점검 공지', '', pnMod.buildPatchNotePayload(pnGame('pubg-maint'), { key: 'k5', title: '정기 점검 안내', url: 'https://www.pubg.com/ko/news', at: day }));
  add('패치노트 알림', '/관리 → 테스트 알림', '테스트 서버 채널에 올라오는 확인용 카드', pnMod.buildPatchNotePayload(pnGame('lol'), { key: 'test', title: '[테스트] 패치노트 알림이 정상적으로 도착했어요', url: 'https://discord.com', at: day, note: '관리자가 보낸 테스트 알림입니다' }));

  // ── DM 알림 ───────────────────────────────────
  const dmMatch = { data: base('lol'), participants: users(6), message: { url: 'https://discord.com/channels/1/2/3' } };
  add('DM 알림', '내전 시작 알림 (참가자에게)', '예약한 시각이 되면 DM으로', common.buildMatchDmPayload({ kind: 'start', match: dmMatch, label: '내전' }));
  add('DM 알림', '내전 마감 알림 (주최자에게)', '', common.buildMatchDmPayload({ kind: 'close', match: dmMatch, label: '내전' }));
  add('DM 알림', '렐름 신청 승인 DM', '', mark.buildRealmResultDm('approved', 'Steve_7406', '민호'));
  add('DM 알림', '렐름 신청 거절 DM', '', mark.buildRealmResultDm('rejected', 'Steve_7406', '민호'));

  // ── 경고·안내 메시지 전부(소스에서 자동 추출) ──────────
  for (const n of extractNotices()) {
    const feature = n.file.replace(/^(handlers|forms|commands)\//, '').replace(/\.js$/, '').replace(/\/index$/, '');
    add('경고·안내 메시지', feature, n.text.length > 60 ? '' : '', card.notice(n.text, { ephemeral: true }));
  }

  // ── 관리 · 안내 패널 ──────────────────────────
  const adminHome = req('handlers/관리/홈.js').buildAdminHome;
  add('관리 · 안내 패널', '/관리 홈 — 소식 알림 작동 중', '일시정지 버튼이 줄 오른쪽 · 출처별 마지막 확인', adminHome({ guildId: '1' }));
  add('관리 · 안내 패널', '/관리 홈 — 테스트 서버', '테스트 알림 · 레이드 테스트 버튼은 테스트 서버에서만 보여요', adminHome({ guildId: req('config.js').TEST_GUILD_IDS[0] }));
  patchState = { ...patchState, paused: true };
  add('관리 · 안내 패널', '/관리 홈 — 소식 알림 일시정지됨', '일시정지하면 재개 버튼으로 바뀌고 확인도 멈춰요', adminHome({ guildId: '1', note: '⏸️ **소식 알림을 일시정지했어요.** 재개할 때까지 새 글이 올라와도 알리지 않아요.' }));
  patchState = { ...patchState, paused: false };
  add('관리 · 안내 패널', '/관리 → 게임모집 관리', '패널의 ⚙️ 관리 기능을 /관리에서도 (새로고침은 자동 최신화라 없음)', panel.buildAdminMenuPayload('admin'));
  add('관리 · 안내 패널', '패널 게시 선택', '/관리 → 패널 게시', panel.buildPanelSelectPayload({ withBack: true }));
  add('관리 · 안내 패널', '퀴즈 관리 (메뉴로 버튼)', '', quizCmd.buildQuizPanelPayload('1', '▶️ 자동 출제를 다시 시작했습니다.'));

  const fake = { client: { user: { displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png', username: 'ARCADE' } }, guild: { id: '1' }, guildId: '1' };
  const applicant = { id: '5', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/2.png' };
  add('관리 · 안내 패널', '게임모집 안내 패널', '카드 2장(모집 / 놀이터)', panel.buildSetupPanelPayload(fake));
  add('관리 · 안내 패널', '명령어 목록', '', panel.buildCommandListPayload());
  const dmPref = req('handlers/매치/DM설정.js');
  add('관리 · 안내 패널', 'DM 알림 설정 — ON (기본)', '🔔 DM 알림 설정 버튼 · 지금 상태(ON) 버튼이 비활성화', dmPref.buildDmSettingPayload('screen-dm-on', { ephemeral: true }));
  dmPref.setDmEnabled('screen-dm-off', false);
  add('관리 · 안내 패널', 'DM 알림 설정 — OFF', 'OFF를 누르면 OFF 버튼이 비활성화되고 ON(초록)이 활성화', dmPref.buildDmSettingPayload('screen-dm-off', { ephemeral: true }));
  dmPref.setDmEnabled('screen-dm-off', true);
  add('관리 · 안내 패널', 'XP 관리', '긴급정지·뉴비부스트·레이드 상태를 카드 한 장에', xp.buildManageView('✅ 뉴비부스트를 **켰습니다**.', '1'));
  add('관리 · 안내 패널', '긴급정지 확인', '', xp.buildConfirmView('farm'));
  add('관리 · 안내 패널', 'XP 조정 패널', '', xp.buildPanelView({ guildId: '1' }, '100', { user: null, displayName: '민호' }, '✅ **+500 XP** 적용 (누적 `3120` → `3620`)'));
  add('관리 · 안내 패널', '렐름 신청 안내 패널', '', mark.buildRealmPanelPayload());
  add('관리 · 안내 패널', '렐름 신청서 검토 대기', '', mark.buildRealmReviewPayload({ applicant, displayName: '지수', nickname: 'Steve_7406', appliedAt: Date.now(), status: 'pending' }));
  add('관리 · 안내 패널', '렐름 신청서 승인됨', '', mark.buildRealmReviewPayload({ applicant, displayName: '지수', nickname: 'Steve_7406', appliedAt: Date.now(), status: 'approved', processedByName: '민호' }));
  add('관리 · 안내 패널', '렐름 멤버 명단', '', mark.buildRealmRosterMessagePayload([{ discordName: '지수', nickname: 'Steve_7406' }, { discordName: '하늘', nickname: 'Alex_sky' }, { discordName: '도윤', nickname: 'Dream_Yoon' }]));
  add('관리 · 안내 패널', '코블몬 안내 패널', '', cob.buildCobblemonPanelPayload());

  // ── 전적 검색 (롤 · 발로란트) ──────────────────────────────
  {
    const fs2 = require('fs');
    const { ActionRowBuilder: Row, ButtonBuilder: Btn, ButtonStyle: BtnStyle } = require('discord.js');
    const { createRecordHandlers } = req('handlers/전적/index.js');
    const { renderLol } = req('handlers/전적/롤그림.js');
    const { renderValorant } = req('handlers/전적/발로그림.js');
    const { summarize } = req('handlers/전적/집계.js');
    const captured = [];
    const rec = createRecordHandlers({ owners: { get: () => undefined, set() {} }, canUse: () => true, canUseHere: () => true, getLinked: () => null, setLinked() {}, save() {}, lol: {}, valorant: {}, verifyLol: async () => ({}), verifyValorant: async () => ({}) });
    await rec.startRecordCommand({ guildId: '1', reply: async p => captured.push(p) });
    add('전적 검색', '/전적 — 선택 카드 (나에게만 보임)', '구분선으로 내 전적 / 다른 사람 전적 · 멤버를 고르기 전엔 다른 사람용 롤·발로란트가 회색', captured[0]);
    await rec.handleRecordSelect({ guildId: '1', values: ['101'], update: async p => captured.push(p) });
    add('전적 검색', '/전적 — 멤버를 고른 뒤', '고른 멤버가 메뉴에 표시되고 그 멤버용 버튼이 켜져요', captured[1]);
    // 롤/발로란트 버튼을 누르면 선택 카드가 이 "검색 중" 카드로 바뀌고, 이미지가 올라오면 자동으로 지워진다
    const searchHandlers = createRecordHandlers({ canUse: () => true, canUseHere: () => true, getLinked: () => ({ lol: { name: 'Mino', tag: 'KR1', puuid: 'P' } }), setLinked() {}, save() {}, lol: { lookup: async () => ({ ok: true, png: null, text: 'x', puuid: 'P' }) }, valorant: {}, verifyLol: async () => ({}), verifyValorant: async () => ({}) });
    const searchingShots = [];
    await searchHandlers.handleRecordButton({ guildId: '1', channelId: '2', customId: 'record:lol:me', user: { id: '1' }, update: async p => searchingShots.push(p), channel: { send: async () => {} }, deleteReply: async () => {}, editReply: async () => {} });
    add('전적 검색', '/전적 — 검색 중 (선택 카드가 바뀜)', '롤·발로란트를 누르면 선택 카드가 이 카드로 바뀌고, 이미지가 올라오면 자동으로 사라져요 · 실패하면 오류 안내와 함께 선택 카드로 돌아와요', searchingShots[0]);
    // 안내 카드들(계정 미연결 · 채널 제한 · 연결 결과 · 조회 실패)
    const grab = [];
    const base = { guildId: '1', channelId: '2', user: { id: '1' }, reply: async p => grab.push(p), editReply: async p => grab.push(p), update: async () => {}, deferReply: async () => {}, channel: { send: async () => {} } };
    const mk = (over = {}) => createRecordHandlers({ canUse: () => true, canUseHere: () => true, getLinked: () => null, setLinked() {}, save() {}, lol: {}, valorant: {}, verifyLol: async (name, tag) => ({ puuid: 'P', name, tag }), verifyValorant: async (name, tag) => ({ name, tag }), ...over });
    await mk().handleRecordButton({ ...base, customId: 'record:lol:me' });
    await mk().handleRecordButton({ ...base, customId: 'record:val:u:101' });
    await mk({ canUseHere: () => false }).startRecordCommand(base);
    const fields = values => ({ getTextInputValue: id => values[id] ?? '' });
    await mk().handleRecordModal({ ...base, customId: 'record:link_modal', fields: fields({ lol: 'Mino#KR1', valorant: 'OωO#1116' }) });
    await mk({ verifyValorant: async () => { throw new (req('handlers/전적/리오트.js').RiotError)('not_found', 404); } }).handleRecordModal({ ...base, customId: 'record:link_modal', fields: fields({ lol: 'Mino#KR1', valorant: 'Ghost#KR1' }) });
    await mk({ getLinked: () => ({ lol: { name: 'Mino', tag: 'KR1', puuid: 'P' } }), lol: { lookup: async () => ({ ok: false, message: '요청이 몰려 있어요. 잠시 후 다시 해 주세요.' }) } }).handleRecordButton({ ...base, customId: 'record:lol:me' });
    const [noMine, noOther, wrongCh, linkOk, linkBad, failNote] = grab;
    add('전적 검색', '안내 — 내 계정이 연결 안 됨', '카드 안에 [계정 연결] 버튼 · 나에게만 보임', noMine);
    add('전적 검색', '안내 — 다른 멤버가 연결 안 함', '멤버 멘션 + [닉네임으로 검색] 버튼', noOther);
    add('전적 검색', '안내 — 쓸 수 없는 채널', '쓸 수 있는 채널이 링크로 나와요', wrongCh);
    add('전적 검색', '계정 연결 — 성공', '롤·발로란트 로고와 함께 연결된 계정을 보여줘요', linkOk);
    add('전적 검색', '계정 연결 — 실패', '하나라도 확인이 안 되면 아무것도 저장하지 않아요', linkBad);
    add('전적 검색', '조회 실패 — 선택 카드로 돌아옴', '오류 안내가 맨 위(노란 띠)에 붙고 다시 고를 수 있어요', failNote);
    // 실제 아이콘이 든 그림(node tests/전적/샘플그림.js 로 만든 것)이 있으면 그걸 쓰고, 없으면 빈 아이콘으로 그린다
    const real = require('path').join(__dirname, '전적', 'out', 'lol-real.png');
    const sampleMatches = [0, 1, 2, 3, 4].map(i => ({ id: 'K' + i, ts: Date.now() - (i + 1) * 5400000, dur: 1500 + i * 90, queue: i % 2 ? 440 : 420, win: i % 3 !== 1, champ: ['Yone', 'Azir', 'Ahri', 'Viego', 'Syndra'][i], k: 8 - i, d: 3 + i, a: 6 + i, cs: 180 + i * 12, items: [3031, 3006, 3046, 3087, 0, 3036, 3363], spells: [4, 14], keystone: 8010, subStyle: 8100, vision: i, pos: 'MIDDLE', multi: i === 1 ? 2 : 0, teamKills: 28 }));
    const lolPng = fs2.existsSync(real) ? fs2.readFileSync(real) : renderLol({ name: 'Mino', tag: 'KR1', level: 742, queue: 'all', solo: { tier: 'MASTER', rank: 'I', lp: 606, wins: 448, losses: 371 }, flex: null, summary: summarize(sampleMatches), matches: sampleMatches, icons: {} });
    const sentRoll = [], sentVal = [];  // 채널에 공개로 올라가는 메시지(이미지 + 탭 버튼)를 실제 핸들러로 만든다
    // 발로란트: 실제 응답 모양의 샘플(tests/전적/fixtures)로 그린다
    const { parseStoredMatches } = req('handlers/전적/헨릭.js');
    const { summarizeValorant } = req('handlers/전적/발로집계.js');
    const valMatches = parseStoredMatches(JSON.parse(fs2.readFileSync(require('path').join(__dirname, '전적', 'fixtures', 'henrik-stored.json'), 'utf8')));
    const valReal = require('path').join(__dirname, '전적', 'out', 'real-val.png');
    const valPng = fs2.existsSync(valReal) ? fs2.readFileSync(valReal) : renderValorant({ profile: { name: 'Mino#KR1', tier: 'Gold 2', rr: 47, peak: 'Platinum 1', seasons: [] }, summary: summarizeValorant(valMatches), matches: valMatches.slice(0, 5), icons: {}, names: {}, now: valMatches[0].ts + 3600e3 });
    const shotHandlers = createRecordHandlers({
      canUse: () => true, canUseHere: () => true, setLinked() {}, save() {}, verifyLol: async () => ({}), verifyValorant: async () => ({}),
      getLinked: () => ({ lol: { name: 'Mino', tag: 'KR1', puuid: 'P' }, valorant: { name: 'Mino', tag: 'KR1' } }),
      lol: { lookup: async () => ({ ok: true, png: lolPng, text: 'x', puuid: 'P' }) },
      valorant: { lookup: async () => ({ ok: true, png: valPng, text: 'x', id: 'Mino#KR1' }) },
    });
    const shotBase = { guildId: '1', channelId: '2', user: { id: '1' }, member: { displayName: '민호' }, update: async () => {}, deleteReply: async () => {}, editReply: async () => {} };
    await shotHandlers.handleRecordButton({ ...shotBase, customId: 'record:lol:me', channel: { send: async p => sentRoll.push(p) } });
    await shotHandlers.handleRecordButton({ ...shotBase, customId: 'record:val:me', channel: { send: async p => sentVal.push(p) } });
    add('전적 검색', '롤 전적 이미지 (유저 정보 · 최근 20판 통계 · 최근 5경기)', '채널에 공개로 올라가요 · 아래 두 줄 버튼으로 큐(전체·솔랭·자랭 / 일반·칼바람·아레나)를 바꿔요', sentRoll[0], { files: png(sentRoll[0].files) });
    add('전적 검색', '발로란트 전적 이미지 (HenrikDev)', '유저 정보 · 최근 20판 통계 · 최근 5경기(모드·맵·요원·K/D/A) · 아래 버튼으로 전체/경쟁전/일반전/신속 플레이/스파이크 돌격/팀 데스매치/데스매치를 바꿔요', sentVal[0], { files: png(sentVal[0].files) });

    // ── 전적 검색의 나머지 모든 안내·경고 카드(작은 것까지) — 실제 핸들러에 가짜 상호작용을 넣어 그대로 만든다 ──
    {
      const { RiotError, riotErrorMessage } = req('handlers/전적/리오트.js');
      const G = '전적 검색 · 안내/경고';
      const ownerMap = { M: 'U1' };
      const owners2 = { get: k => ownerMap[k], set: (k, v) => { ownerMap[k] = v; }, del: k => { delete ownerMap[k]; } };
      const mk2 = (over = {}) => createRecordHandlers({
        owners: owners2, canUse: () => true, canUseHere: () => true, getLinked: () => null, setLinked() {}, save() {},
        lol: { lookup: async () => ({ ok: true, png: lolPng, text: '롤 전적 글자판', puuid: 'P' }) },
        valorant: { lookup: async () => ({ ok: true, png: valPng, text: '발로란트 전적 글자판', id: 'Mino#KR1' }) },
        verifyLol: async (name, tag) => ({ puuid: 'P', name, tag }), verifyValorant: async (name, tag) => ({ name, tag }), ...over,
      });
      const fi = (over = {}) => {
        const o = { replies: [], edits: [], updates: [], follows: [], sends: [] };
        const i = {
          guildId: '1', channelId: '2', user: { id: 'U1' }, member: { displayName: '민호' }, message: { id: 'M', components: [] }, customId: '',
          fields: { getTextInputValue: id => (over.values ?? {})[id] ?? '' },
          reply: async p => o.replies.push(p), editReply: async p => o.edits.push(p), update: async p => o.updates.push(p), followUp: async p => o.follows.push(p),
          deferReply: async () => {}, deleteReply: async () => {}, showModal: async () => {}, channel: { send: async p => { o.sends.push(p); return { id: 'S' }; } }, ...over,
        };
        return { i, o };
      };
      const linkedAll = { lol: { name: 'Mino', tag: 'KR1', puuid: 'P' }, valorant: { name: 'Mino', tag: 'KR1' } };
      const run = async (handlers, method, over) => { const x = fi(over); await handlers[method](x.i); return x.o; };

      // 1) 막힘: 서버
      add(G, '막힘 — 아직 쓸 수 없는 서버', '테스트 서버 한정일 때 다른 서버에서 누르면(지금은 본서버 공개라 안 뜸)', (await run(mk2({ canUse: () => false }), 'startRecordCommand', {})).replies[0]);
      // 2) 연결이 없을 때
      add(G, '안내 — 내 발로란트 계정이 연결 안 됨', '내 전적 버튼에서 발로란트를 눌렀을 때', (await run(mk2(), 'handleRecordButton', { customId: 'record:val:me' })).replies[0]);
      add(G, '안내 — 다른 사람 전적에서 나 자신을 골랐는데 연결 없음', '"내 계정 연결"이 아니라 그 사람(나) 안내가 나와요', (await run(mk2(), 'handleRecordButton', { customId: 'record:lol:u:U1' })).replies[0]);
      // 3) 탭·잠금 권한
      add(G, '경고 — 요청자만 탭을 조작할 수 있어요', '잠긴 카드의 탭을 남이 눌렀을 때(나에게만 보임)', (await run(mk2(), 'handleRecordButton', { customId: 'record:q:lol:solo:P', user: { id: 'U2' } })).replies[0]);
      add(G, '경고 — 요청자와 관리자만 잠글 수 있어요', '남이 잠금 버튼을 눌렀을 때', (await run(mk2(), 'handleRecordButton', { customId: 'record:lock', user: { id: 'U2' } })).replies[0]);
      add(G, '경고 — 잠글 수 없는 옛 메시지', '요청자를 모르는 옛 카드의 잠금 버튼을 일반 유저가 눌렀을 때', (await run(mk2(), 'handleRecordButton', { customId: 'record:lock', user: { id: 'U2' }, message: { id: 'OLD', components: [] } })).replies[0]);
      // 4) 잠금 해제된 카드 / 탭을 누른 직후 카드
      const unlockedRun = await run(mk2(), 'handleRecordButton', { customId: 'record:lock', message: { id: 'M', components: sentRoll[0].components } });
      add(G, '롤 전적 이미지 — 잠금 해제 상태(🔓)', '요청자·관리자가 🔒를 누르면 🔓로 바뀌고 누구나 탭을 바꿀 수 있어요', { ...unlockedRun.updates[0], flags: 1 << 15 }, { files: png(sentRoll[0].files) });
      Object.keys(ownerMap).filter(k => k.startsWith('U')).forEach(k => delete ownerMap[k]); // 해제 기록을 지워 다시 잠긴 상태로
      const pendingRun = await run(mk2(), 'handleRecordButton', { customId: 'record:q:lol:solo:P' });
      add(G, '탭을 누른 직후 카드(롤)', '눌린 탭만 파랗게 · 버튼은 잠깐 잠기고 새 그림이 오면 교체돼요', pendingRun.updates[0], { files: png(sentRoll[0].files) });
      // 5) 조회 실패 안내 — 오류 종류별
      const kindName = { not_found: '계정을 못 찾음', denied: 'API 키 만료·거부', rate: '요청이 몰림', unavailable: 'Riot 서버 응답 없음' };
      for (const kind of Object.keys(kindName)) {
        const failing = mk2({ lol: { lookup: async () => ({ ok: false, message: riotErrorMessage(new RiotError(kind, 0)) }) } });
        add(G, `조회 실패(롤 탭) — ${kindName[kind]}`, '탭을 눌렀는데 조회가 실패했을 때 따로 뜨는 안내(나에게만 보임) · 그림은 그대로 남고 버튼은 다시 풀려요', (await run(failing, 'handleRecordButton', { customId: 'record:q:lol:solo:P' })).follows[0]);
      }
      add(G, '조회 실패(발로란트 탭) — 키 미설정', '발로란트 전적 키가 서버에 없을 때', (await run(mk2({ valorant: { lookup: async () => ({ ok: false, message: riotErrorMessage({ kind: 'no_key' }) }) } }), 'handleRecordButton', { customId: 'record:q:val:comp:Mino#KR1' })).follows[0]);
      add(G, '조회 실패(발로란트 탭) — 닉네임을 읽지 못함', '버튼에 든 닉네임이 깨졌을 때', (await run(mk2(), 'handleRecordButton', { customId: 'record:q:val:comp:' })).replies[0]);
      // 6) 이미지 대신 글자 / 이미지를 못 올림
      const textRun = await run(mk2({ getLinked: () => linkedAll, lol: { lookup: async () => ({ ok: true, png: null, text: '**Mino#KR1** · 솔로랭크 마스터 606LP\n최근 20판 · 11승 9패', puuid: 'P' }) } }), 'handleRecordButton', { customId: 'record:lol:me' });
      add(G, '결과 — 그림을 못 그릴 때 글자로 대신', '폰트·그림 엔진을 못 쓰면 글자 카드로 올라와요', textRun.sends[0]);
      const sendFail = await run(mk2({ getLinked: () => linkedAll }), 'handleRecordButton', { customId: 'record:lol:me', channel: { send: async () => { throw new Error('Missing Permissions'); } } });
      add(G, '조회 실패 — 이미지를 못 올림(권한 없음)', '봇이 그 채널에 파일을 못 올릴 때 선택 카드로 돌아와 안내해요', sendFail.edits[sendFail.edits.length - 1]);
      // 7) 닉네임으로 검색 모달 제출
      add(G, '닉네임 검색 — 아무것도 안 적음', '모달(입력창)은 디스코드가 그리는 팝업이라 카드가 아니에요 · 제출 뒤 결과만 카드', (await run(mk2(), 'handleRecordModal', { customId: 'record:find_modal' })).edits[0]);
      add(G, '닉네임 검색 — 형식이 틀림', '이름#태그가 아니면 아무것도 조회하지 않아요', (await run(mk2(), 'handleRecordModal', { customId: 'record:find_modal', values: { lol: 'Mino', valorant: '#KR1' } })).edits.at(-1));
      const both = await run(mk2(), 'handleRecordModal', { customId: 'record:find_modal', values: { lol: 'Mino#KR1', valorant: 'Mino#KR1' } });
      add(G, '닉네임 검색 — 롤+발로란트 동시 검색 중', '로고 두 개 · 두 닉네임이 한 줄로 · 다 올라가면 이 카드는 사라져요', both.edits[0]);
      const partial = await run(mk2({ valorant: { lookup: async () => ({ ok: false, message: riotErrorMessage(new RiotError('not_found', 404)) }) } }), 'handleRecordModal', { customId: 'record:find_modal', values: { lol: 'Mino#KR1', valorant: 'Ghost#KR1' } });
      add(G, '닉네임 검색 — 한쪽만 실패', '롤은 올라가고 발로란트만 실패하면 실패한 쪽 이유만 이 카드에 남아요', partial.edits.at(-1));
      // 8) 계정 연결 모달 제출
      add(G, '계정 연결 — 아무것도 안 적음', '', (await run(mk2(), 'handleRecordModal', { customId: 'record:link_modal' })).edits[0]);
      add(G, '계정 연결 — 형식이 틀림', '', (await run(mk2(), 'handleRecordModal', { customId: 'record:link_modal', values: { lol: 'Mino' } })).edits[0]);
      add(G, '계정 연결 — 확인 중 서버 오류', 'Riot 서버 문제로 계정을 확인하지 못했을 때', (await run(mk2({ verifyLol: async () => { throw new Error('boom'); } }), 'handleRecordModal', { customId: 'record:link_modal', values: { lol: 'Mino#KR1' } })).edits[0]);
    }
  }

  // ── 레이드 (기존 디자인 유지 — 그림 + 글자 + 버튼) ───────────────────────
  const raidMod = req('handlers/레이드/index.js');
  const raidBattle = req('handlers/레이드/전투.js');
  const { MONSTERS: raidMonsters, ROLE_ORDER: raidRoles, createBattle, resolveTurn, choose } = raidBattle;
  const raidParty = n => raidRoles.slice(0, n).map((role, i) => ({ userId: String(100 + i), name: ['민호', '지수', '하늘', '도윤'][i], role }));
  const rf = p => ({ files: png(p.files) });
  const raidState = (monster, partyN, extra = {}) => ({
    client: null, monster, guildId: '1', channelId: '2', phase: 'recruit', party: raidParty(partyN),
    recruitEndsAt: Date.now() + 9 * 60e3, battle: null, battleEndsAt: 0, turnEndsAt: 0, freezesXp: true, hasImage: false, ...extra,
  });
  for (const m of raidMonsters) {
    const rr = raidState(m, 2);
    const pr = await raidMod.recruitView(rr);
    add('레이드', `${m.name} 출현 (모집 중)`, '파티 모집 — 역할 버튼 · 바로 시작 · 플레이 방법', pr, rf(pr));
  }
  const m0 = raidMonsters.find(m => m.id === 'slime') || raidMonsters[0];
  const startBattle = (monster, n = 4) => {
    const rr = raidState(monster, n);
    rr.phase = 'battle';
    rr.battle = createBattle(monster, rr.party, Math.random, { minParty: 1 });
    rr.battleStartedAt = Date.now() - 5 * 60e3;
    rr.battleEndsAt = Date.now() + 15 * 60e3;
    rr.turnEndsAt = Date.now() + 25e3;
    return rr;
  };
  const rb = startBattle(m0);
  const pb = await raidMod.battleView(rb);
  add('레이드', '전투 — 행동 선택', '그림 + 선택 현황 · 행동 버튼', pb, rf(pb));
  rb.battle.members[0].choice = 'attack'; rb.battle.members[1].choice = 'guard';
  const pb2 = await raidMod.battleView(rb);
  add('레이드', '전투 — 일부 선택함', '', pb2, rf(pb2));
  resolveTurn(rb.battle); rb.showingResult = true;
  const pb3 = await raidMod.battleView(rb);
  add('레이드', '전투 — 턴 결과', '버튼이 꺼지고 "TURN N 종료" 띠', pb3, rf(pb3));
  rb.showingResult = false; rb.battle.hp = Math.floor(rb.battle.maxHp * 0.3); rb.battle.rage = true;
  const pb4 = await raidMod.battleView(rb);
  add('레이드', '전투 — 분노 상태', '', pb4, rf(pb4));
  // 원숭이 대장: 부하 부르기 경고 → 부하 등장 → 부하가 맞고 바나나 투척 → 합동 필살기 경고 → 부하 전멸(우울 상태)
  const monkey = raidMonsters.find(m => m.id === 'monkey');
  if (monkey) {
    const rk = startBattle(monkey); const bk = rk.battle;
    const shot = async (title, sub) => { const v = await raidMod.battleView(rk); add('레이드', `원숭이 대장 — ${title}`, sub, v, rf(v)); };
    bk.intent = 'smash';
    await shot('부하 부르기 경고', '필살기 1 · 빨간 경고 상자');
    bk.members.forEach(m => choose(bk, m.userId, 'attack'));
    resolveTurn(bk); rk.showingResult = true;
    await shot('부하 등장', '양옆에 원숭이 부하 두 마리 + HP 막대 · 흙먼지');
    rk.showingResult = false; bk.intent = 'attack';
    bk.members.forEach(m => choose(bk, m.userId, 'attack'));
    resolveTurn(bk); rk.showingResult = true;
    await shot('부하가 대신 맞음', '공격은 부하에게 먼저 · 부하 머리 위 피해 숫자 · 바나나 맞은 카드');
    rk.showingResult = false; bk.intent = 'combo'; bk.minions.forEach(x => { x.hp = Math.max(x.hp, 40); });
    await shot('합동 필살기 경고', '필살기 2 · 부하가 살아 있을 때만');
    bk.intent = 'attack'; bk.minions.forEach(x => { x.hp = Math.min(x.hp, 60); });
    bk.members.forEach(m => choose(bk, m.userId, 'attack'));
    resolveTurn(bk); rk.showingResult = true;
    await shot('부하 전멸 → 우울 상태', '우는 얼굴 · 회색으로 쓰러진 부하');
    rk.showingResult = false;
    await shot('우울 상태', '오른쪽 위 배지 · 받는 피해 증가 · 남은 턴');
  }
  // ??? (블랙월 느낌): 모집 시간 제한 없음 · 대기 XP 실시간 차감 · 패배해도 도주 안 함 · 승리 시 MVP 아이템
  const voidM = raidBattle.loadMonsters().find(m => m.id === 'void'); // 꺼진(enabled false) 몬스터라 MONSTERS가 아닌 loadMonsters
  if (voidM) {
    const H = 3600e3;
    const wait = async (title, sub, extra, partyN = 2) => {
      const rv = { ...raidState(voidM, partyN), waitSince: Date.now(), ...extra };
      const v = await raidMod.recruitView(rv);
      add('레이드', `??? — ${title}`, sub, v, rf(v));
    };
    await wait('대기창 (막 출현)', '전용 디자인: 깨진 시계 · 잃은 XP · 패배 횟수 · 보상(MVP 아이템)', { waitedMs: 0, lostPerUser: 0, defeatStacks: 0 });
    await wait('대기창 (3시간 경과)', '분당 -12~18 XP 차감(숫자가 계속 움직임) · 1인당 잃은 XP가 계속 늘어남', { waitedMs: 3 * H, lostPerUser: 2700, defeatStacks: 0 });
    await wait('대기창 (패배 2회 후)', '졌어도 도주하지 않고 다시 모집 · 패배 1회마다 모든 유저 -200 XP', { waitedMs: 5 * H, lostPerUser: 1500, defeatStacks: 2 }, 0);
    // 전투 장면들
    const vb = (intent, choice = 'attack', n = 4) => {
      const rr = raidState(voidM, n);
      rr.phase = 'battle'; rr.battle = createBattle(voidM, rr.party, Math.random, { minParty: 1 });
      rr.battleStartedAt = Date.now() - 5 * 60e3; rr.battleEndsAt = Date.now() + 15 * 60e3; rr.turnEndsAt = Date.now() + 25e3;
      rr.battle.intent = intent;
      raidBattle.assignMarks(rr.battle);
      return rr;
    };
    const vshot = async (rr, title, sub) => {
      const v = await raidMod.battleView(rr); add('레이드', `??? — ${title}`, sub, v, rf(v));
      if (process.env.DUMP_VOID) { const f = (v.files || [])[0]; if (f) require('fs').writeFileSync(require('path').join(process.env.DUMP_VOID, `${String(dumpN++).padStart(2, '0')}.png`), f.attachment); }
    };
    let dumpN = 1;
    let rr = vb('smash');
    await vshot(rr, '전투 — 필살기 경고', '블랙월 게이트웨이(필살기) 예고 · 빨간 경고 상자');
    rr = vb('deadeye');
    await vshot(rr, '전투 — 데드아이 예고', '표식 저격: 대상 이름이 예고에 · 카드에 빛나는 눈');
    rr = vb('attack');
    rr.battle.members.forEach(mm => choose(rr.battle, mm.userId, 'attack'));
    resolveTurn(rr.battle, () => 0.99); rr.showingResult = true;
    await vshot(rr, '전투 — 데이터 크래시 결과', '터미널 명령줄 띠(말풍선 대신) · 방어 안 한 사람은 ⚠️오류 배지');
    rr.showingResult = false;
    await vshot(rr, '전투 — 오류 상태 선택 화면', '⚠️ 오류: 고른 행동이 무작위로 바뀐다는 안내(아래 글자)');
    rr = vb('analyze');
    rr.battle.members.forEach(mm => choose(rr.battle, mm.userId, 'guard'));
    resolveTurn(rr.battle, () => 0.5); rr.showingResult = true;
    await vshot(rr, '전투 — 취약점 분석 결과', '전원 🔓취약(받는 피해 +30%) 2턴');
    rr = vb('killnine');
    rr.battle.members.forEach(mm => choose(rr.battle, mm.userId, 'attack'));
    resolveTurn(rr.battle, () => 0.01); rr.showingResult = false;
    await vshot(rr, '전투 — kill -9 다음 턴(즉사 판정)', '☠️ 판정 배지 · 이번 턴 끝에 확률로 쓰러짐(치유사 스킬·방어로 대처)');
    // 분노(체력 40% 이하): 붉은 핏줄 분노 마크는 그리지 않음
    rr = vb('attack'); rr.battle.hp = Math.round(rr.battle.maxHp * 0.3); rr.battle.rage = true;
    await vshot(rr, '전투 — 분노', '체력이 줄어 분노: 바닥 불빛·몸 테두리 + 화면이 훨씬 심하게 깨짐(큰 모서리 오염·가로 띠 밀림·붉은 채널 분리·블록 어긋남·주사선, 턴마다 모양이 바뀜), 오른쪽 위 붉은 핏줄 마크는 없음');
    // 기술별 결과 화면(글리치 연출) · 상태이상 중첩 표시
    const result = (intent, pick, rng2, extra) => { const r2 = vb(intent); r2.battle.members.forEach((mm, i) => choose(r2.battle, mm.userId, typeof pick === 'function' ? pick(i) : pick)); if (extra) extra(r2); resolveTurn(r2.battle, rng2); r2.showingResult = true; return r2; };
    await vshot(result('overclock', 'attack', () => 0.5), '전투 — 오버클록 결과', '몬스터가 잔상을 끌며 번지고 줄마다 박자가 어긋남 · CLK ▲▲ 150%');
    await vshot(result('deadeye', 'attack', () => 0.5), '전투 — 데드아이 결과', '표적 카드가 모자이크로 초점이 잠기고 계단식 레이저 · 끊긴 조준 고리');
    await vshot(result('killnine', 'attack', () => 0.5), '전투 — kill -9 결과', '표적 카드가 꺼지는 화면처럼 접힘 + > kill -9 PID · Killed');
    await vshot(result('smash', i => (i === 0 ? 'guard' : 'attack'), () => 0.5), '전투 — 블랙월 게이트웨이 결과(첫 번째만 방어)', '화면 전체가 세로로 갈라짐 · 방어 안 한 사람은 ⚠️오류+🔓취약+☠️즉사가 1턴씩 한꺼번에');
    // 서로 다른 상태이상이 한 카드에 겹친 모습(독·냉기·점액·악취 같은 기존 상태까지)
    const st = vb('attack');
    const m0s = st.battle.members[0], m1s = st.battle.members[1];
    for (const mm of [m0s, m1s]) { mm.errorUntil = st.battle.turn + 2; mm.errorStatus = { name: '오류', emoji: '⚠️' }; mm.vulnUntil = st.battle.turn + 2; mm.vulnRate = 1.3; mm.vulnStatus = { name: '취약', emoji: '🔓' }; mm.doomTurn = st.battle.turn; mm.doomRate = 0.5; mm.doomStacks = 2; mm.doomStatus = { name: '즉사', emoji: '☠️' }; }
    m1s.poisonStacks = 2; m1s.poisonUntil = st.battle.turn + 3; m1s.poisonStatus = { name: '독', emoji: '☠️' };
    m1s.chillStacks = 2; m1s.stenchUntil = st.battle.turn + 2; m1s.stenchRate = 0.5; m1s.stenchStatus = { name: '악취', emoji: '💨' };
    await vshot(st, '전투 — 상태이상 중첩 표시', '첫째: 오류·취약·즉사 / 둘째: 거기에 독·냉기·악취까지 — 왼쪽에 세로로 쌓임');
    // 결과와 안내
    const pn = await raidMod.battleView({ ...vb('attack'), showingResult: false });
    const defeatNote = raidMod.buildEndNoticePayload({ kind: 'defeat', xp: 200, stacks: 2, lost: 1500, details: ['128명 · 합계 : -192,000 XP'] });
    add('레이드', '??? — 패배 채널 안내', '도주하지 않음 · 모든 유저 -200 XP · 지금까지 1인당 잃은 XP', defeatNote);
    const er = vb('attack'); er.phase = 'ended'; er.endedAt = Date.now(); er.frozenAt = Date.now() - 5 * H; er.battle.hp = 0;
    const ev = await raidMod.endView(er, 'clear', [
      { userId: '100', xp: 0, mvp: true, hackTool: false, gateway: true },
      { userId: '101', xp: 1000, mvp: false, hackTool: true, gateway: false },
      { userId: '102', xp: 1000, mvp: false, hackTool: true, gateway: false },
    ]);
    add('레이드', '??? — 토벌 성공 결과', '파티원 +1000 XP + 해킹 툴 1개 · MVP는 XP 없이 🌐 블랙월 게이트웨이만', ev, rf(ev));
    void pn;
  }
  const endR = (outcome, rewards) => { const rr = startBattle(m0); rr.phase = 'ended'; rr.endedAt = Date.now(); rr.frozenAt = Date.now() - 20 * 60e3; if (outcome === 'clear') rr.battle.hp = 0; return raidMod.endView(rr, outcome, rewards); };
  const ec = await endR('clear', [{ userId: '100', xp: 150, mvp: true, hackTool: true }, { userId: '101', xp: 100, mvp: false, hackTool: false }]);
  add('레이드', '종료 — 토벌 성공', 'MVP · 보상 · 해킹 툴(한 명은 보유 한도)', ec, rf(ec));
  for (const [oc, label] of [['wipe', '파티 전멸'], ['timeout', '시간 초과'], ['noshow', '아무도 안 옴'], ['admin', '관리자 종료']]) {
    const pe = await endR(oc, []);
    add('레이드', `종료 — ${label}`, '', pe, rf(pe));
  }
  add('레이드', '종료 안내 — XP 시스템 복구 (결과 메시지에 답장)', '🔧 복구 완료 · 20:42~20:54 (11분 59초)', raidMod.buildEndNoticePayload({ kind: 'recover', details: ['중단 시간 : 20:42~20:54 (11분 59초)'] }));
  add('레이드', '종료 안내 — 복구 실패 (결과 메시지에 답장)', '☠️ 복구 실패 · 합계 128명 · -17,536 XP', raidMod.buildEndNoticePayload({ kind: 'penalty', xp: 137, details: ['128명 · 합계 : -17,536 XP', '중단 시간 : 20:42~21:02 (20분 3초)'] }));
  add('레이드', '❔ 플레이 방법', '본인에게만 보이는 안내', raidMod.buildHelpView(m0));

  return screens;
}

module.exports = { buildScreens };

// 직접 실행하면 그림용 data.js 를 만든다.
// 봇이 등록하는 앱 이모지(아직 ID를 모름)를 로컬 그림으로 보여 주기 위한 이름 → data URI 표
function localEmojiScript() {
  const hack = require(path.join(ROOT, 'handlers/게임/해킹툴.js'));
  const map = Object.fromEntries(Object.values(hack.EMOJIS).map(e => [e.name, 'data:image/png;base64,' + fs.readFileSync(path.join(hack.EMOJI_DIR, e.file)).toString('base64')]));
  const gw = require(path.join(ROOT, 'handlers/게임/블랙월게이트웨이.js'));
  map[gw.GATEWAY_EMOJI.name] = 'data:image/png;base64,' + fs.readFileSync(path.join(gw.EMOJI_DIR, gw.GATEWAY_EMOJI.file)).toString('base64');
  // 게임 썸네일도 봇이 켜져야 여백 넣은 앱 이모지 ID가 생기므로, 원래 이모지 ID → 여백 그림(LOCAL_THUMB)
  const th = require(path.join(ROOT, 'handlers/공통/썸네일.js'));
  const thumbs = Object.fromEntries(Object.entries(th.SOURCES).map(([id, name]) => [id, 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'assets/썸네일', `${name}.png`)).toString('base64')]));
  const tier = require(path.join(ROOT, 'handlers/매치/티어.js'));
  for (const f of fs.readdirSync(tier.EMOJI_DIR).filter(f => f.startsWith('pos_') && f.endsWith('.png'))) {
    map[f.slice(0, -4)] = 'data:image/png;base64,' + fs.readFileSync(path.join(tier.EMOJI_DIR, f)).toString('base64');
  }
  const rec = require(path.join(ROOT, 'handlers/전적/이모지.js'));
  for (const key of rec.EMOJI_FILES) map[rec.emojiName(key)] = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'assets/이모지', `rec_${key}.png`)).toString('base64');
  return 'window.LOCAL_EMOJI = ' + JSON.stringify(map) + ';window.LOCAL_THUMB = ' + JSON.stringify(thumbs) + ';';
}

if (require.main === module && process.argv[2] === '--docs') {
  // 예시 페이지(docs/v2-화면모음.html)를 한 파일로 바로 갱신한다: node tests/카드화면.js --docs
  buildScreens().then(screens => {
    const plain = screens.map(({ payload, ...rest }) => rest);
    const html = fs.readFileSync(path.join(__dirname, '카드화면.html'), 'utf8');
    const data = 'window.SCREENS = ' + JSON.stringify(plain) + ';' + localEmojiScript();
    fs.writeFileSync(path.join(ROOT, 'docs', 'v2-화면모음.html'), html.replace('<script src="data.js"></script>', () => '<script>' + data + '</script>'));
    console.log('예시 페이지 갱신: docs/v2-화면모음.html (' + plain.length + '장)');
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (require.main === module) {
  const outDir = process.argv[2];
  if (!outDir) { console.error('사용: node tests/카드화면.js <출력 폴더>'); process.exit(1); }
  buildScreens().then(screens => {
    fs.mkdirSync(outDir, { recursive: true });
    const plain = screens.map(({ payload, ...rest }) => rest);
    fs.writeFileSync(path.join(outDir, 'data.js'), 'window.SCREENS = ' + JSON.stringify(plain) + ';' + localEmojiScript());
    fs.copyFileSync(path.join(__dirname, '카드화면.html'), path.join(outDir, 'index.html'));
    console.log(`화면 ${plain.length}장 저장 → ${outDir}`);
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
}
