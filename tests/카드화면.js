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
  add('내전 · 모집', '팀 관리(주최자 전용)', '', team.buildTeamManagePayload({ data: base('lol'), participants: users(8), teams: null, closed: false }, '1', '방식을 선택하세요.'));
  add('내전 · 모집', '안내 한 줄 — 만료', '모든 짧은 안내가 같은 카드 모양', card.notice('⚠️ **만료된 내전입니다.**', { ephemeral: true }));
  add('내전 · 모집', '안내 한 줄 — 완료', '', card.notice('✅ **채널에 공개 게시되었습니다!**', { ephemeral: true }));

  // 나만 보이는 메뉴·안내 (버튼을 눌렀을 때 뜨는 임시 메시지)
  const mm = (extra = {}) => ({ data: base('lol'), participants: users(6), closed: false, teams: null, ...extra });
  add('나만 보이는 메시지', '주최자 관리 메뉴 (모집 중)', '제목·상태·버튼이 한 카드에', common.buildManagePayload({ label: '내전', match: mm(), rows: naejeonMod.buildManageMenu(mm(), '1'), ephemeral: true }));
  add('나만 보이는 메시지', '주최자 관리 메뉴 (마감 + 조작 결과)', '방금 한 조작 결과가 맨 위에', common.buildManagePayload({ label: '내전', match: mm({ closed: true }), note: '✅ **내전이 마감되었습니다.**', rows: naejeonMod.buildManageMenu(mm({ closed: true }), '1') }));
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

  const rlb = { id: '1', userId: '100', bet: 100, maxAvailable: 300 };
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

  // ── 레벨 · 랭킹 · 퀴즈 ────────────────────────
  const guild = { id: 'g', members: { fetch: async ({ user }) => new Map(user.map((id, i) => [id, { displayName: ['민호', '지수', '하늘', '도윤', '서연', '준호', '예린', '태양', '나래', '현우', '다온', '시우'][i % 12] }])) } };
  add('레벨 · 랭킹 · 퀴즈', '랭킹 1페이지', '', (await rank.buildRankingView(guild, 1, true)).payload);
  add('레벨 · 랭킹 · 퀴즈', '레벨 카드', '', level.buildLevelPayload('g', { id: '100', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' }, '민호'));
  add('레벨 · 랭킹 · 퀴즈', '오늘의 퀴즈', '', card.payload(quizMod.buildQuizCard({ word: '고양이', hint: '집에서 기르는 작은 동물로, 야옹 하고 운다.', grade: '쉬움', xpReward: 40 })));

  add('레벨 · 랭킹 · 퀴즈', '레벨업 축하', '', req('handlers/레벨/레벨링.js').buildLevelUpPayload('100', 8));
  add('레벨 · 랭킹 · 퀴즈', '퀴즈 정답', '정답자 프로필 썸네일 + 걸린 시간 + 보상·난이도', quizMod.buildCorrectPayload({ word: '바늘꽂이', xpReward: 200, grade: '초급', solverName: '유민', solverAvatar: 'https://cdn.discordapp.com/embed/avatars/2.png', elapsedMs: 192000 }));
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

  // ── 레이드 (기존 디자인 유지 — 그림 + 글자 + 버튼) ───────────────────────
  const raidMod = req('handlers/레이드/index.js');
  const raidBattle = req('handlers/레이드/전투.js');
  const { MONSTERS: raidMonsters, ROLE_ORDER: raidRoles, createBattle, resolveTurn } = raidBattle;
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
  const endR = (outcome, rewards) => { const rr = startBattle(m0); rr.phase = 'ended'; rr.endedAt = Date.now(); rr.frozenAt = Date.now() - 20 * 60e3; if (outcome === 'clear') rr.battle.hp = 0; return raidMod.endView(rr, outcome, rewards); };
  const ec = await endR('clear', [{ userId: '100', xp: 150, mvp: true }, { userId: '101', xp: 100, mvp: false }]);
  add('레이드', '종료 — 토벌 성공', 'MVP · 보상', ec, rf(ec));
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
if (require.main === module && process.argv[2] === '--docs') {
  // 예시 페이지(docs/v2-화면모음.html)를 한 파일로 바로 갱신한다: node tests/카드화면.js --docs
  buildScreens().then(screens => {
    const plain = screens.map(({ payload, ...rest }) => rest);
    const html = fs.readFileSync(path.join(__dirname, '카드화면.html'), 'utf8');
    const data = 'window.SCREENS = ' + JSON.stringify(plain) + ';';
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
    fs.writeFileSync(path.join(outDir, 'data.js'), 'window.SCREENS = ' + JSON.stringify(plain) + ';');
    fs.copyFileSync(path.join(__dirname, '카드화면.html'), path.join(outDir, 'index.html'));
    console.log(`화면 ${plain.length}장 저장 → ${outDir}`);
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
}
