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

async function buildScreens() {
  // 랭킹은 레벨링 데이터 대신 가짜 순위를 쓴다(랭킹·레벨 모듈을 부르기 전에 패치).
  const lv = req('handlers/레벨링.js');
  lv.getLeaderboardSize = () => 12;
  lv.getLeaderboard = (g, limit, offset) => Array.from({ length: 12 }, (_, i) => ({
    userId: 'u' + i, rank: i + 1, level: 14 - i, xp: 9200 - i * 610, currentLevelXp: 120 + i * 37, neededXp: 480,
  })).slice(offset, offset + limit);
  lv.getXp = () => 3120;

  const { buildPublicMessagePayload } = req('handlers/내전.js');
  const { buildMojipMessagePayload } = req('handlers/모집.js');
  const common = req('handlers/공용.js');
  const card = req('handlers/카드.js');
  const team = req('handlers/팀.js');
  const ttt = req('handlers/틱택토.js');
  const omok = req('handlers/오목.js');
  const wc = req('handlers/끝말잇기.js');
  const rl = req('handlers/룰렛.js');
  const xp = req('commands/XP.js').views;
  const panel = req('commands/패널.js');
  const rank = req('commands/랭킹.js');
  const level = req('commands/레벨.js');
  const quizMod = req('handlers/퀴즈.js');
  const mark = req('forms/마크/index.js');
  const cob = req('forms/코블몬/index.js');

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
  add('내전 · 모집', '내전 모집 중', '게임 색 띠 + 게임 아이콘 + 진행 막대 + 버튼이 카드 안에', buildPublicMessagePayload({
    data: base('lol', { data: { description: '다이아 이하 환영 · 마이크 필수', notifyAt: nowPlus(2) } }), participants: users(6), closed: false, teams: null, roleContent: '<@&1> ',
  }));
  add('내전 · 모집', '내전 정원 마감(모집 완료)', '정원이 차면 회색 띠', buildPublicMessagePayload({ data: base('val'), participants: users(10), closed: false, teams: null }));
  add('내전 · 모집', '내전 마감 + 팀 배정', '팀 1 / 팀 2가 위아래로', buildPublicMessagePayload({ data: base('lol'), participants: users(10), closed: true, teams: { team1: users(10).slice(0, 5), team2: users(10).slice(5) } }));
  add('내전 · 모집', '모집 (가벼운 인원 모집)', '', buildMojipMessagePayload({ data: base('custom', { label: '모집', data: { players: '4', description: '렐름 같이 하실 분' } }), participants: users(2), closed: false }));
  add('내전 · 모집', '게시 전 미리보기', '작성자에게만 보이는 임시 메시지', common.buildPreviewPayload('naejeon', base('lol', { data: { description: '메모 예시', notifyAt: nowPlus(3) } }), { ephemeral: true }));
  add('내전 · 모집', '취소된 내전', '', card.payload(common.buildCancelledCard({ label: '내전', data: base('lol'), byOrganizer: true })));
  add('내전 · 모집', '팀 배정 완료 알림', '팀을 나누면 채널에 올라오는 카드', card.payload(common.buildTeamResultCard(base('lol'), { team1: users(10).slice(0, 5), team2: users(10).slice(5) })));
  add('내전 · 모집', '팀 관리(주최자 전용)', '', team.buildTeamManagePayload({ data: base('lol'), participants: users(8), teams: null, closed: false }, '1', '방식을 선택하세요.'));
  add('내전 · 모집', '안내 한 줄 — 만료', '모든 짧은 안내가 같은 카드 모양', card.notice('⚠️ **만료된 내전입니다.**', { ephemeral: true }));
  add('내전 · 모집', '안내 한 줄 — 완료', '', card.notice('✅ **채널에 공개 게시되었습니다!**', { ephemeral: true }));

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
  add('룰렛', '베팅 선택(본인에게만)', '', rl.buildLobbyPayload(rlb, { ephemeral: true }));
  add('룰렛', '릴 도는 중', '버튼 3개가 슬롯머신 릴', rl.buildSpinningPayload(rlb, 100, ['🍒', '🎰', '🎰']));
  add('룰렛', '결과 — 잭팟', '', rl.buildResultPayload(rlb, { bet: 100, resultLine: '🎉 **JACKPOT!** (x10)', netLine: '📈 **+900 XP**', net: 900, reels: ['7️⃣', '7️⃣', '7️⃣'] }));

  // ── 레벨 · 랭킹 · 퀴즈 ────────────────────────
  const guild = { id: 'g', members: { fetch: async ({ user }) => new Map(user.map((id, i) => [id, { displayName: ['민호', '지수', '하늘', '도윤', '서연', '준호', '예린', '태양', '나래', '현우', '다온', '시우'][i % 12] }])) } };
  add('레벨 · 랭킹 · 퀴즈', '랭킹 1페이지', '', (await rank.buildRankingView(guild, 1, true)).payload);
  add('레벨 · 랭킹 · 퀴즈', '레벨 카드', '', level.buildLevelPayload('g', { id: '100', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' }, '민호'));
  add('레벨 · 랭킹 · 퀴즈', '오늘의 퀴즈', '', card.payload(quizMod.buildQuizCard({ word: '고양이', hint: '집에서 기르는 작은 동물로, 야옹 하고 운다.', grade: '쉬움', xpReward: 40 })));

  // ── 관리 · 안내 패널 ──────────────────────────
  const fake = { client: { user: { displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png', username: 'ARCADE' } }, guild: { id: '1' }, guildId: '1' };
  const applicant = { id: '5', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/2.png' };
  add('관리 · 안내 패널', '게임모집 안내 패널', '카드 2장(모집 / 놀이터)', panel.buildSetupPanelPayload(fake));
  add('관리 · 안내 패널', '명령어 목록', '', panel.buildCommandListPayload());
  add('관리 · 안내 패널', '/xp 콘솔 메뉴', '', xp.buildMenuView());
  add('관리 · 안내 패널', 'XP 관리', '긴급정지·뉴비부스트·레이드 상태를 카드 한 장에', xp.buildManageView('✅ 뉴비부스트를 **켰습니다**.', '1'));
  add('관리 · 안내 패널', '긴급정지 확인', '', xp.buildConfirmView('farm'));
  add('관리 · 안내 패널', 'XP 조정 패널', '', xp.buildPanelView({ guildId: '1' }, '100', { user: null, displayName: '민호' }, '✅ **+500 XP** 적용 (누적 `3120` → `3620`)'));
  add('관리 · 안내 패널', '렐름 신청 안내 패널', '', mark.buildRealmPanelPayload());
  add('관리 · 안내 패널', '렐름 신청서 검토 대기', '', mark.buildRealmReviewPayload({ applicant, displayName: '지수', nickname: 'Steve_7406', appliedAt: Date.now(), status: 'pending' }));
  add('관리 · 안내 패널', '렐름 신청서 승인됨', '', mark.buildRealmReviewPayload({ applicant, displayName: '지수', nickname: 'Steve_7406', appliedAt: Date.now(), status: 'approved', processedByName: '민호' }));
  add('관리 · 안내 패널', '렐름 멤버 명단', '', mark.buildRealmRosterMessagePayload([{ discordName: '지수', nickname: 'Steve_7406' }, { discordName: '하늘', nickname: 'Alex_sky' }, { discordName: '도윤', nickname: 'Dream_Yoon' }]));
  add('관리 · 안내 패널', '코블몬 안내 패널', '', cob.buildCobblemonPanelPayload());

  return screens;
}

module.exports = { buildScreens };

// 직접 실행하면 그림용 data.js 를 만든다.
if (require.main === module) {
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
