const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const TURN_MS  = 20_000;
const TURN_SEC = TURN_MS / 1000;
const JOIN_MS  = 90_000;
const KOREAN   = /^[가-힣]+$/;

// ── 봇 단어 사전 ───────────────────────────────────────────────
const BOT_WORDS = [
  '가방', '가수', '가을', '가족', '가구', '가위', '가게', '가스', '가면', '각도',
  '간식', '갈비', '감자', '강물', '강아지', '거북이', '거울', '겨울', '고구마', '고기',
  '고래', '고양이', '고추', '공부', '공원', '공항', '과자', '교실', '교육', '구름',
  '국수', '기린', '기차', '김치', '나라', '나무', '나비', '나팔', '낙타', '냉면',
  '너구리', '노래', '노을', '눈물', '눈송이', '다람쥐', '다리', '단풍', '달팽이', '당근',
  '대나무', '도깨비', '도서관', '도시', '독수리', '동물', '동생', '두부', '딸기', '라디오',
  '라면', '로봇', '마늘', '마음', '마을', '마차', '만두', '매미', '모기', '모자',
  '목소리', '무지개', '문어', '물고기', '미역', '바나나', '바다', '바람', '바위', '방학',
  '배추', '백조', '뱀장어', '버스', '벌꿀', '벚꽃', '보름달', '볼펜', '봄비', '부채',
  '비행기', '사과', '사람', '사랑', '사막', '사슴', '사자', '삼각형', '새벽', '서울',
  '소나기', '소나무', '소금', '소리', '소방차', '손가락', '수박', '수영장', '숙제', '시계',
  '신발', '아기', '아버지', '아이', '아침', '아파트', '악어', '앵무새', '야구', '양말',
  '어머니', '연필', '염소', '영화', '오리', '오징어', '온도', '우산', '우유', '유리',
  '이불', '일기', '자동차', '자연', '자유', '자전거', '전기', '전철', '전화', '젓가락',
  '지갑', '지구', '지하철', '진달래', '책상', '천둥', '청소', '초록', '축구', '치킨',
  '카메라', '코끼리', '코알라', '크레용', '타조', '태양', '토끼', '토마토', '파도',
  '파랑새', '포도', '포크', '피아노', '하늘', '하루', '하마', '학교', '해바라기',
  '햄버거', '호랑이', '호수', '호박', '화분', '황소',
  '가격', '가사', '가입', '가훈', '각오', '간호사', '갈매기', '감기', '감동', '감사',
  '강당', '강산', '개구리', '거리', '거지', '건강', '건물', '걸음', '검사', '게임',
  '결과', '결혼', '경기', '경찰', '계란', '계절', '계획', '고민', '고백', '고속도로',
  '고통', '곰인형', '공기', '공룡', '공연', '공주', '관광', '광장', '교사', '교통',
  '구두', '구슬', '국가', '국기', '국물', '군인', '궁전', '귀걸이', '그림', '그림자',
  '극장', '근처', '금요일', '기술', '기억', '기자', '기적', '기타', '김밥', '까치',
  '꽃잎', '꽃병', '꿀벌', '나뭇잎', '낙엽', '날개', '날씨', '남자', '낭만', '냄새',
  '냉장고', '노트북', '녹차', '논밭', '놀이터', '농구', '농부', '눈사람', '능력', '다리미',
  '다이어리', '단추', '달력', '담요', '당구', '대통령', '대학교', '댄스', '도둑', '도로',
  '도토리', '독서', '돈가스', '돌고래', '동네', '동화책', '두더지', '등대', '등산', '딱지',
  '땅콩', '라켓', '러시아', '레몬', '로켓', '리본', '리듬', '마늘빵', '마라톤', '마술사',
  '만화', '말투', '망원경', '매력', '머리카락', '메뉴', '명절', '모래', '모델', '목걸이',
  '목도리', '몸무게', '무궁화', '무당벌레', '문제', '문화', '물감', '미소', '미술관', '민들레',
  '바닥', '바이올린', '박물관', '반지', '발자국', '방송', '방울', '배구', '배낭', '백화점',
  '버섯', '벽지', '별자리', '병원', '보물', '보석', '복숭아', '봉투', '부엌', '분위기',
  '불꽃', '불빛', '비누', '비밀', '비타민', '사다리', '사무실', '사진', '사탕', '산책',
  '상자', '새우', '색연필', '생일', '생각', '서랍', '선물', '선생님', '설탕', '성격',
  '세탁기', '소풍', '손목시계', '손수건', '수건', '수달', '수첩', '숫자', '스케이트', '스케치북',
  '습관', '시험', '신문', '신호등', '실내화', '심장', '십자수', '싸움', '쌀국수', '아이스크림',
  '안개', '안경', '야채', '약속', '양파', '어항', '언어', '얼음', '여행', '연극',
  '연못', '열쇠', '영웅', '예감', '예술', '오후', '온천', '옷장', '왕관', '요리사',
  '우체국', '우표', '운동장', '원숭이', '유리창', '유치원', '음악회', '이야기', '이해', '인사',
  '인형', '일요일', '자물쇠', '자정', '잠자리', '장난감', '장미', '재채기', '저녁', '전구',
  '전등', '정원', '젤리', '조각', '조명', '졸업식', '주머니', '주사위', '지붕', '지우개',
  '지진', '진주', '짜장면', '창문', '채소', '책가방', '천사', '청바지', '초콜릿', '축제',
  '취미', '치약', '침대', '카페', '커튼', '컴퓨터', '케이크', '코스모스', '콘서트', '콩나물',
  '크리스마스', '탁구', '태권도', '택시', '텐트', '토마토주스', '통조림', '트럼펫', '파티', '편지',
  '포옹', '표범', '풍선', '프라이팬', '피자', '필통', '하늘색', '학원', '한복', '함박눈',
  '항구', '해변', '햇살', '향기', '헬리콥터', '형제', '호떡', '호루라기', '화장실', '환경',
  '활동', '회사원', '후드티', '휴가', '흙탕물', '희망',
  '폭포', '계곡', '언덕', '들판', '초원', '화산', '태풍', '눈보라', '이슬', '서리',
  '밤하늘', '은하수', '별똥별', '달빛', '햇빛', '그늘', '웅덩이', '진흙', '자갈', '모래사장',
  '바닷가', '갯벌', '산봉우리', '절벽', '동굴', '폭풍', '무더위', '한파', '장마', '안개꽃',
  '팬더', '캥거루', '하이에나', '치타', '오소리', '두루미', '백로', '딱따구리', '사마귀', '메뚜기',
  '여치', '반딧불이', '지렁이', '불가사리', '해파리', '상어', '고등어', '갈치', '참치', '조개',
  '소라', '전복', '성게', '미꾸라지', '붕어', '잉어', '메기', '가재', '개미', '나방',
  '하늘소', '사슴벌레', '장수풍뎅이', '두꺼비', '이구아나', '카멜레온', '홍학', '공작새', '기러기', '제비',
  '참새', '까마귀', '물개', '바다표범', '물범', '펭귄', '북극곰', '다슬기', '지네',
  '교과서', '필기구', '연습장', '시간표', '반장', '급식', '도시락', '등교', '하교', '방과후',
  '숙제장', '시험지', '성적표', '졸업장', '입학식', '동아리', '봉사활동', '체육복', '운동화', '실습실',
  '과학실', '음악실', '미술실', '도서실', '교무실', '강의실', '발표', '토론', '논술',
  '소방관', '변호사', '판사', '검사관', '회계사', '통역사', '디자이너', '프로그래머', '개발자', '미용사',
  '조종사', '승무원', '택배기사', '운전기사', '상담사', '심리학자', '과학자', '발명가', '예술가', '음악가',
  '화가', '작가', '시인', '배우', '감독', '코치', '심판',
  '스마트폰', '태블릿', '키보드', '마우스', '모니터', '프린터', '스피커', '이어폰', '헤드폰', '충전기',
  '배터리', '와이파이', '인터넷', '웹사이트', '애플리케이션', '소프트웨어', '하드웨어', '데이터', '서버', '네트워크',
  '로봇청소기', '드론', '인공지능', '알고리즘', '프로그램', '게임기', '콘솔', '조이스틱',
  '축구공', '농구공', '야구공', '배드민턴', '볼링', '수영복', '골프채', '스키', '스노보드', '등산화',
  '헬스장', '요가', '필라테스', '체조', '씨름', '유도', '검도', '양궁', '사격', '펜싱',
  '조정', '카누', '서핑', '스케이트보드',
  '떡볶이', '순대', '튀김', '어묵', '라볶이', '잡채', '갈비탕', '삼계탕', '된장찌개', '김치찌개',
  '부대찌개', '비빔밥', '칼국수', '만두국', '라멘', '초밥', '스시', '파스타', '스테이크', '샐러드',
  '샌드위치', '핫도그', '도넛', '와플', '팬케이크', '마카롱',
  '청소기', '전자레인지', '에어컨', '선풍기', '가습기', '제습기', '정수기', '커피포트', '전기밥솥', '압력솥',
  '냄비', '그릇', '접시', '컵라면', '숟가락', '도마', '냉동실', '식탁', '소파', '서랍장',
  '책장',
  '머리', '이마', '눈썹', '속눈썹', '입술', '턱수염', '어깨', '팔꿈치', '손목',
  '손등', '손톱', '발목', '발바닥', '발가락', '무릎', '허리', '배꼽', '가슴', '엉덩이',
  '허벅지', '종아리',
  '기쁨', '슬픔', '분노', '두려움', '놀람', '설렘', '그리움', '외로움', '행복', '불안',
  '긴장', '자신감', '용기', '절망', '후회', '부끄러움', '질투',
  '우주', '행성', '위성', '혜성', '유성', '은하', '블랙홀', '우주선',
  '우주인',
  '첼로', '플루트', '드럼', '클라리넷', '하프', '오르간', '색소폰', '리코더', '심벌즈', '탬버린',
  '오케스트라', '합창단', '지휘자', '작곡가', '멜로디', '화음', '박자',
  '시장', '편의점', '마트', '은행', '경찰서', '소방서', '약국', '서점', '문구점', '미용실',
  '세탁소', '부동산', '식당', '술집', '영화관', '놀이공원', '동물원', '수족관', '체육관', '경기장',
  '정류장', '주차장',
];

function findBotWord(game) {
  const available = BOT_WORDS.filter(
    w => w.length >= 2 && !game.used.has(w) && (!game.lastChar || w[0] === game.lastChar),
  );
  if (!available.length) return null;
  return available[Math.floor(Math.random() * available.length)];
}

function getGames(client) {
  if (!client.wcGames) client.wcGames = new Map();
  return client.wcGames;
}

function getDisplayName(interaction) {
  return interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
}

// ── 임베드 빌더 ────────────────────────────────────────────────

function buildWaitingEmbed(game) {
  const list = game.players
    .map((p, i) => `${i + 1}. **\`${p.name}\`**${p.id === game.hostId ? '  👑' : ''}`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔤 끝말잇기')
    .setDescription(`참가자를 기다리는 중 **(${game.players.length}명)**\n\n${list}`)
    .addFields({
      name: '📋 규칙',
      value:
        '• 이전 단어의 **마지막 글자**로 시작하는 단어를 입력하세요.\n' +
        '• 이미 사용된 단어는 사용할 수 없습니다.\n' +
        `• **${TURN_SEC}초** 내에 입력하지 않으면 탈락합니다.`,
    })
    .setFooter({ text: '최소 2명이 참가해야 시작할 수 있습니다.' });
}

function buildPlayingEmbed(game) {
  const currentPlayer = game.players[game.currentIdx];
  const recentWords = game.history.slice(-8).join(' → ') || '(없음)';

  const wordLine = game.lastWord
    ? `**마지막 단어** : \`${game.lastWord}\`　**시작 글자** : \`${game.lastChar}\``
    : '**첫 번째 단어를 입력하세요!** (아무 한국어 단어)';

  const playerList = game.players
    .map((p, i) => `${i === game.currentIdx ? '▶️' : '　'} **\`${p.name}\`**`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🔤 끝말잇기 진행 중')
    .setDescription(`${wordLine}\n\n💬 **\`${currentPlayer.name}\`의 차례** — 채팅에 단어를 입력하세요! (${currentPlayer.id === 'BOT' ? '자동' : `${TURN_SEC}초`})`)
    .addFields(
      { name: '👥 순서', value: playerList, inline: true },
      { name: '📝 최근 단어', value: recentWords, inline: true },
    )
    .setTimestamp();
}

function buildFinishedEmbed(game) {
  const loserPlayer = game.players.find(p => p.id === game.loser);
  const loserName = loserPlayer?.name ?? '알 수 없음';

  const REASONS = {
    timeout:     `⏰ ${TURN_SEC}초 내에 단어를 입력하지 못했습니다.`,
    wrong_start: `❌ \`${game.failWord}\`은(는) \`${game.lastChar}\`(으)로 시작하지 않습니다.`,
    duplicate:   `🔁 \`${game.failWord}\`은(는) 이미 사용된 단어입니다.`,
    not_korean:  `🚫 \`${game.failWord}\`은(는) 한국어 단어가 아닙니다.`,
    too_short:   `🚫 한 글자 단어(\`${game.failWord}\`)는 사용할 수 없습니다.`,
    gave_up:     `🏳️ 단어를 이을 수 없어 포기했습니다.`,
    cancelled:   `❌ 방장이 게임을 취소했습니다.`,
  };

  const recent = game.history.slice(-10).join(' → ') || '(없음)';

  return new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('🔤 끝말잇기 종료')
    .setDescription(
      `**탈락** : \`${loserName}\`\n**이유** : ${REASONS[game.endReason] || '게임 종료'}\n\n` +
      `총 **${game.history.length}개** 단어 사용`,
    )
    .addFields({ name: '📝 마지막 단어들', value: recent })
    .setTimestamp();
}

// ── 컴포넌트 빌더 ──────────────────────────────────────────────

function buildWaitingComponents(game) {
  const hasBot = game.players.some(p => p.id === 'BOT');
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`wc:join:${game.id}`)
        .setLabel('✋ 참가')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`wc:start:${game.id}`)
        .setLabel('▶️ 게임 시작')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(game.players.length < 2),
      new ButtonBuilder()
        .setCustomId(`wc:bot_start:${game.id}`)
        .setLabel('🤖 봇과 시작')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(hasBot || game.players.length !== 1),
      new ButtonBuilder()
        .setCustomId(`wc:cancel:${game.id}`)
        .setLabel('❌ 취소')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildPlayingComponents(game) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`wc:giveup:${game.id}`)
        .setLabel('🏳️ 포기')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── 게임 종료 ──────────────────────────────────────────────────

function endGame(game, games, loserId, reason, failWord = null) {
  clearTimeout(game.timeoutId);
  game.status    = 'finished';
  game.loser     = loserId;
  game.endReason = reason;
  game.failWord  = failWord;
  games.delete(game.id);
  game.message?.edit({ embeds: [buildFinishedEmbed(game)], components: [] }).catch(() => {});
}

async function botPlay(game, games) {
  const g = games.get(game.id);
  if (!g || g.status !== 'playing') return;

  const word = findBotWord(g);
  if (!word) {
    endGame(g, games, 'BOT', 'gave_up');
    return;
  }

  g.used.add(word);
  g.history.push(word);
  g.lastWord = word;
  g.lastChar = word[word.length - 1];
  g.currentIdx = (g.currentIdx + 1) % g.players.length;

  await g.message?.edit({
    embeds: [buildPlayingEmbed(g)],
    components: buildPlayingComponents(g),
  }).catch(() => {});

  startTurn(g, games);
}

function startTurn(game, games) {
  clearTimeout(game.timeoutId);

  const currentPlayer = game.players[game.currentIdx];
  if (currentPlayer.id === 'BOT') {
    game.timeoutId = setTimeout(() => botPlay(game, games), 2000);
    return;
  }

  game.timeoutId = setTimeout(() => {
    const g = games.get(game.id);
    if (!g || g.status !== 'playing') return;
    endGame(g, games, g.players[g.currentIdx].id, 'timeout');
  }, TURN_MS);
}

// ── 커맨드 진입 ────────────────────────────────────────────────

async function startWcCommand(interaction) {
  const games = getGames(interaction.client);
  const gameId = interaction.id;

  const game = {
    id: gameId,
    hostId: interaction.user.id,
    channelId: interaction.channelId,
    players: [{ id: interaction.user.id, name: getDisplayName(interaction) }],
    currentIdx: 0,
    used: new Set(),
    history: [],
    lastWord: null,
    lastChar: null,
    status: 'waiting',
    loser: null,
    endReason: null,
    failWord: null,
    message: null,
    timeoutId: null,
  };
  games.set(gameId, game);

  await interaction.reply({
    embeds: [buildWaitingEmbed(game)],
    components: buildWaitingComponents(game),
  });
  try {
    game.message = await interaction.fetchReply();
  } catch {
    games.delete(gameId);
    return;
  }

  game.timeoutId = setTimeout(async () => {
    const g = games.get(gameId);
    if (!g || g.status !== 'waiting') return;
    games.delete(gameId);
    await game.message?.edit({ content: '⏰ **참가자가 없어 게임이 취소되었습니다.**', embeds: [], components: [] }).catch(() => {});
  }, JOIN_MS);
}

// ── 버튼 핸들러 ────────────────────────────────────────────────

async function handleWcButton(interaction) {
  const { customId } = interaction;
  const games = getGames(interaction.client);

  // ── 참가 ──────────────────────────────────────────────────
  if (customId.startsWith('wc:join:')) {
    const gameId = customId.slice('wc:join:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'waiting') {
      await interaction.reply({ content: '⚠️ **참가할 수 없는 게임입니다.**', ephemeral: true });
      return;
    }
    if (game.players.some(p => p.id === interaction.user.id)) {
      await interaction.reply({ content: '⚠️ **이미 참가 중입니다.**', ephemeral: true });
      return;
    }
    game.players.push({ id: interaction.user.id, name: getDisplayName(interaction) });
    await interaction.update({ embeds: [buildWaitingEmbed(game)], components: buildWaitingComponents(game) });
    return;
  }

  // ── 시작 ──────────────────────────────────────────────────
  if (customId.startsWith('wc:start:')) {
    const gameId = customId.slice('wc:start:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'waiting') {
      await interaction.reply({ content: '⚠️ **게임을 시작할 수 없습니다.**', ephemeral: true });
      return;
    }
    if (interaction.user.id !== game.hostId) {
      await interaction.reply({ content: '⚠️ **방장만 게임을 시작할 수 있습니다.**', ephemeral: true });
      return;
    }
    if (game.players.length < 2) {
      await interaction.reply({ content: '⚠️ **최소 2명이 필요합니다.**', ephemeral: true });
      return;
    }
    clearTimeout(game.timeoutId);
    for (let i = game.players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [game.players[i], game.players[j]] = [game.players[j], game.players[i]];
    }
    game.status = 'playing';
    game.currentIdx = 0;
    await interaction.update({ embeds: [buildPlayingEmbed(game)], components: buildPlayingComponents(game) });
    startTurn(game, games);
    return;
  }

  // ── 봇과 시작 ─────────────────────────────────────────────
  if (customId.startsWith('wc:bot_start:')) {
    const gameId = customId.slice('wc:bot_start:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'waiting') {
      await interaction.reply({ content: '⚠️ **게임을 시작할 수 없습니다.**', ephemeral: true });
      return;
    }
    if (interaction.user.id !== game.hostId) {
      await interaction.reply({ content: '⚠️ **방장만 사용할 수 있습니다.**', ephemeral: true });
      return;
    }
    if (game.players.some(p => p.id === 'BOT')) {
      await interaction.reply({ content: '⚠️ **봇은 이미 참가 중입니다.**', ephemeral: true });
      return;
    }
    if (game.players.length !== 1) {
      await interaction.reply({ content: '⚠️ **참가자가 1명일 때만 봇과 시작할 수 있습니다.**', ephemeral: true });
      return;
    }
    clearTimeout(game.timeoutId);
    game.players.push({ id: 'BOT', name: '🤖 봇' });
    for (let i = game.players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [game.players[i], game.players[j]] = [game.players[j], game.players[i]];
    }
    game.status = 'playing';
    game.currentIdx = 0;
    await interaction.update({ embeds: [buildPlayingEmbed(game)], components: buildPlayingComponents(game) });
    startTurn(game, games);
    return;
  }

  // ── 취소 ──────────────────────────────────────────────────
  if (customId.startsWith('wc:cancel:')) {
    const gameId = customId.slice('wc:cancel:'.length);
    const game = games.get(gameId);
    if (!game) {
      await interaction.reply({ content: '⚠️ **게임을 찾을 수 없습니다.**', ephemeral: true });
      return;
    }
    if (interaction.user.id !== game.hostId) {
      await interaction.reply({ content: '⚠️ **방장만 취소할 수 있습니다.**', ephemeral: true });
      return;
    }
    clearTimeout(game.timeoutId);
    if (game.status === 'playing') {
      endGame(game, games, game.hostId, 'cancelled');
      await interaction.deferUpdate();
    } else {
      games.delete(gameId);
      await interaction.update({ content: '❌ **게임이 취소되었습니다.**', embeds: [], components: [] });
    }
    return;
  }

  // ── 포기 ──────────────────────────────────────────────────
  if (customId.startsWith('wc:giveup:')) {
    const gameId = customId.slice('wc:giveup:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'playing') {
      await interaction.reply({ content: '⚠️ **진행 중인 게임이 아닙니다.**', ephemeral: true });
      return;
    }
    const currentPlayer = game.players[game.currentIdx];
    if (currentPlayer.id === 'BOT' || interaction.user.id !== currentPlayer.id) {
      await interaction.reply({ content: `⚠️ **지금은 \`${currentPlayer.name}\`의 차례입니다.**`, ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    endGame(game, games, currentPlayer.id, 'gave_up');
    return;
  }
}

// ── 채팅 메시지 핸들러 ──────────────────────────────────────────

async function handleWcMessage(message) {
  if (message.author.bot) return;

  const games = getGames(message.client);
  for (const game of games.values()) {
    if (game.status !== 'playing') continue;
    if (game.channelId !== message.channelId) continue;

    const currentPlayer = game.players[game.currentIdx];
    if (currentPlayer.id === 'BOT' || currentPlayer.id !== message.author.id) continue;

    const word = message.content.trim();
    if (!word) continue; // 스티커/첨부파일 등 텍스트 없는 메시지는 시도로 취급하지 않음

    if (!KOREAN.test(word)) {
      await message.react('❌').catch(() => {});
      endGame(game, games, currentPlayer.id, 'not_korean', word);
      return;
    }

    if (word.length < 2) {
      await message.react('❌').catch(() => {});
      endGame(game, games, currentPlayer.id, 'too_short', word);
      return;
    }

    if (game.lastChar && word[0] !== game.lastChar) {
      await message.react('❌').catch(() => {});
      endGame(game, games, currentPlayer.id, 'wrong_start', word);
      return;
    }

    if (game.used.has(word)) {
      await message.react('❌').catch(() => {});
      endGame(game, games, currentPlayer.id, 'duplicate', word);
      return;
    }

    game.used.add(word);
    game.history.push(word);
    game.lastWord = word;
    game.lastChar = word[word.length - 1];
    game.currentIdx = (game.currentIdx + 1) % game.players.length;

    await message.react('✅').catch(() => {});
    await game.message.edit({
      embeds: [buildPlayingEmbed(game)],
      components: buildPlayingComponents(game),
    }).catch(() => {});

    startTurn(game, games);
    return;
  }
}

module.exports = { startWcCommand, handleWcButton, handleWcMessage };
