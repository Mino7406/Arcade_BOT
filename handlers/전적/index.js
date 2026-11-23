// 전적/index.js — /전적 명령의 상호작용: 나에게만 보이는 선택창([롤] [발로란트] [계정 연결]) → 채널에 공개되는 전적 이미지.
// 지금은 테스트 서버에서만 쓸 수 있다(config.js 의 RECORD_SEARCH_TEST_ONLY). 외부 서비스는 createRecordHandlers 로 주입해서 테스트한다.
//
// customId 규칙(100자 이하):
//   record:lol:<대상>   record:val:<대상>   — 대상: me | u:<디스코드 유저 id> (none 은 멤버를 고르기 전의 회색 버튼)
//   record:pick         — 다른 사람 전적의 멤버 선택 메뉴
//   record:link / record:link_modal — 계정 연결 모달 열기 / 제출
//   record:find / record:find_modal — 닉네임으로 검색 모달 열기 / 제출
//   record:q:lol:<all|solo|flex>:<puuid> — 롤 이미지의 큐 탭
const path = require('path');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, MessageFlags,
} = require('discord.js');
const accounts = require('./계정');
const { parseRiotId } = accounts;
const { createLimiter } = require('./요청대기열');
const { createRiotClient, RiotError, riotErrorMessage } = require('./리오트');
const { createMatchStore } = require('./경기저장');
const { createStatic } = require('./정적데이터');
const { createLolService } = require('./롤');
const { createValorantService } = require('./발로');
const { fetchValorant } = require('./헨릭');
const { recordEmoji } = require('./이모지');
const { createOwnerStore } = require('./소유자');
const { warmLolRender } = require('./롤그림');
const { warmValorantRender } = require('./발로그림');
const { card, payload, menu } = require('../공통/카드');
const { RECORD_SEARCH_CHANNEL_IDS } = require('../../config');

const EPHEMERAL = MessageFlags.Ephemeral;
const QUEUE_TABS = [['all', '전체'], ['solo', '솔랭'], ['flex', '자랭'], ['normal', '일반'], ['aram', '칼바람'], ['arena', '아레나']];
// 탭 버튼 줄 배치(한 줄 최대 5개): 롤은 랭크 / 모드 3+3, 발로란트는 4+3
const QUEUE_ROWS = [['all', 'solo', 'flex'], ['normal', 'aram', 'arena']];
const VAL_ROWS = [['all', 'comp', 'unrated', 'swift'], ['spike', 'tdm', 'dm']];
const VAL_TABS = [['all', '전체'], ['comp', '경쟁전'], ['unrated', '일반전'], ['swift', '신속 플레이'], ['spike', '스파이크 돌격'], ['tdm', '팀 데스매치'], ['dm', '데스매치']];
// 탭 버튼 이모지: 발로란트는 게임 모드 로고(앱 이모지, 아직 준비 전이면 기본 이모지). 롤은 큐별 로고가 따로 없어 기본 이모지.
const VAL_TAB_EMOJI = { all: () => EMOJI.valorant, comp: () => recordEmoji('val_rank') ?? '🏆', unrated: () => recordEmoji('val_standard') ?? '🎮', swift: () => recordEmoji('val_swift') ?? '⚡', spike: () => recordEmoji('val_spike') ?? '💣', tdm: () => recordEmoji('val_tdm') ?? '🔫', dm: () => recordEmoji('val_dm') ?? '🎯' };
const QUEUE_TAB_EMOJI = { all: () => EMOJI.lol, solo: () => recordEmoji('lol_solo') ?? '👤', flex: () => recordEmoji('lol_flex') ?? '👥', arena: () => recordEmoji('lol_arena') ?? '⚔️', normal: () => recordEmoji('lol_rift') ?? '🎮', aram: () => recordEmoji('lol_aram') ?? '❄️' };
// 안내 메시지는 전부 카드(제목·부제·본문·버튼)로 보낸다. ephemeral 이면 나에게만 보이고, 모달 응답처럼 이미 대기 중인 메시지를 고칠 때는 false.
const info = ({ color = 'warn', header, sub, lines = [], rows, footer }, ephemeral = true) => payload(card({ color, header, sub, blocks: lines, rows, footer }), { ephemeral });
const notReadyCard = () => info({ color: 'muted', header: '🚧 준비 중이에요', sub: '전적 검색', lines: ['전적 검색은 지금 테스트 서버에서만 쓸 수 있어요.'] });
const wrongChannelCard = () => info({
  header: '📍 이 채널에서는 쓸 수 없어요', sub: '전적 검색',
  lines: ['`/전적`은 아래 채널에서 쓸 수 있어요.', `${RECORD_SEARCH_CHANNEL_IDS.map(id => `<#${id}>`).join('\n')}\n🔊 음성채널 채팅방`],
});
// 안내 카드의 문제 줄: 게임 이름(굵게)을 한 줄로 쓰고 줄을 바꿔 문구를 쓴다(긴 문구가 이름 옆에서 어색하게 꺾이지 않게)
const problemLine = (label, message) => `**${label}**
${message}`;
const ZOOM_FOOTER = '🔍 사진을 눌러 확대해서 볼 수 있어요';
const { escapeMarkdown } = require('discord.js');
// 결과 카드 맨 위 줄: 요청자(작은 글씨). 이 줄 밑에 구분선을 긋고 이미지를 둔다(이미지 블록의 divider: true).
const requesterLine = requester => `-# 요청자 : ${requester}`;
// 요청자 이름: 서버 별명 → 계정 표시 이름 → 아이디. 이름 속 마크다운 기호(*, _ 등)는 그대로 보이게 막는다.
const requesterOf = i => escapeMarkdown(String(i.member?.displayName ?? i.user?.globalName ?? i.user?.username ?? '알 수 없음'));
const ACCENT = { lol: 0x3b82f6, valorant: 0xff4655 };
// 앱 이모지(개발자 포털에 올려 둔 롤·발로란트 로고)
const EMOJI = { lol: { id: '1510933684750913626', name: 'Lol' }, valorant: { id: '1510933698349109268', name: 'Val' } };

// 전적 이미지 한 장(또는 그림을 못 그릴 때 글자)을 카드 메시지로 만든다. row 는 카드 안에 들어갈 버튼 줄.
function resultPayload(res, game, row, requester) {
  const rows = [].concat(row ?? []); // 탭 버튼 줄(여러 줄일 수 있다)
  if (!res.png) return payload(card({ color: ACCENT[game], blocks: [res.text], rows }));
  return { ...payload(card({ color: ACCENT[game], top: requesterLine(requester), blocks: [{ image: 'attachment://record.png', divider: true }], footer: ZOOM_FOOTER, rows })), files: [new AttachmentBuilder(res.png, { name: 'record.png' })] };
}

function createRecordHandlers({ owners, canUse, canUseHere, getLinked, setLinked, save, lol, valorant, verifyLol, verifyValorant }) {
  // 쓸 수 없는 곳이면 안내 카드, 쓸 수 있으면 null(서버 한정 → 채널 제한 순서)
  const blockedCard = i => (!canUse(i.guildId) ? notReadyCard() : !canUseHere(i.guildId, i.channelId) ? wrongChannelCard() : null);
  const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  // 탭 버튼들을 정해 둔 줄 배치(QUEUE_ROWS·VAL_ROWS)대로 ActionRow 로 만든다.
  const tabRows = (layout, tabs, build) => layout.map(keys => new ActionRowBuilder().addComponents(keys.map(k => build(k, tabs.find(([t]) => t === k)[1]))));
  const queueRow = (puuid, current, locked = false) => tabRows(QUEUE_ROWS, QUEUE_TABS, (q, label) =>
    button(`record:q:lol:${q}:${puuid}`, label, q === current ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji(QUEUE_TAB_EMOJI[q]()).setDisabled(locked));

  // 발로란트 모드 탭(customId 에 이름#태그를 담는다). 결과 이미지가 있을 때만 붙는다.
  const valRow = (id, current, locked = false) => tabRows(VAL_ROWS, VAL_TABS, (t, label) =>
    button(`record:q:val:${t}:${id}`, label, t === current ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji(VAL_TAB_EMOJI[t]()).setDisabled(locked));
  // 탭을 누른 직후 곧바로 보여 주는 카드: 옛 그림은 그대로(attachments 를 건드리지 않음) 두고 눌린 탭만 파랗게, 버튼은 잠근다. 새 그림이 오면 교체된다.
  const pendingCard = (game, rows, requester) => payload(card({ color: ACCENT[game], top: requesterLine(requester), blocks: [{ image: 'attachment://record.png', divider: true }], footer: ZOOM_FOOTER, rows }), { keepAttachments: true });
  const tabsFor = (game, res) => (!res.ok || !res.png ? null : game === 'lol' ? queueRow(res.puuid, 'all') : valRow(res.id, 'all'));

  // 선택 카드 한 장: 구분선으로 "내 전적 / 다른 사람 전적"을 나눈다. pickedId 가 있으면 그 멤버용 버튼이 켜진다.
  function selectCard(pickedId, ephemeral, note) {
    const mine = new ActionRowBuilder().addComponents(
      button('record:lol:me', '롤', ButtonStyle.Primary).setEmoji(EMOJI.lol),
      button('record:val:me', '발로란트', ButtonStyle.Danger).setEmoji(EMOJI.valorant),
      button('record:link', '계정 연결').setEmoji('🔗'));
    const pick = new UserSelectMenuBuilder().setCustomId('record:pick').setPlaceholder('👤 멤버를 골라 주세요').setMinValues(1).setMaxValues(1);
    if (pickedId) pick.setDefaultUsers(pickedId);
    const others = new ActionRowBuilder().addComponents(
      button(pickedId ? `record:lol:u:${pickedId}` : 'record:lol:none', '롤', ButtonStyle.Primary).setEmoji(EMOJI.lol).setDisabled(!pickedId),
      button(pickedId ? `record:val:u:${pickedId}` : 'record:val:none', '발로란트', ButtonStyle.Danger).setEmoji(EMOJI.valorant).setDisabled(!pickedId),
      button('record:find', '닉네임으로 검색').setEmoji('🔍'));
    return payload(card({
      color: note ? 'warn' : 'info', header: '📊 전적 검색', sub: '롤 · 발로란트',
      blocks: [note ? `### ⚠️ 조회하지 못했어요\n${note}` : null, '### 🙋 내 전적', { rows: [mine] }, '### 👥 다른 사람 전적', { rows: [new ActionRowBuilder().addComponents(pick), others] }],
    }), { ephemeral });
  }

  // /전적 → 나에게만 보이는 선택 카드
  async function startRecordCommand(interaction) {
    const blocked = blockedCard(interaction);
    if (blocked) return interaction.reply(blocked);
    return interaction.reply(selectCard(null, true));
  }

  // 멤버 선택 메뉴: 같은 카드를 그 멤버용 버튼이 켜진 모습으로 바꾼다
  async function handleRecordSelect(interaction) {
    const blocked = blockedCard(interaction);
    if (blocked) return interaction.reply(blocked);
    return interaction.update(selectCard(interaction.values[0], false));
  }

  // 대상 키(me | u:<id>) → 조회할 계정. 연결이 없으면 target 이 null.
  function resolveTarget(key, userId, game) {
    const ownerId = key.startsWith('u:') ? key.slice(2) : userId;
    const acc = getLinked(ownerId)?.[game];
    if (!acc) return { target: null, own: ownerId === userId, ownerId };
    return { target: game === 'lol' ? { name: acc.name, tag: acc.tag, puuid: acc.puuid } : { name: acc.name, tag: acc.tag }, own: ownerId === userId };
  }

  // 누른 선택 카드를 바로 이 카드로 바꿔서(버튼이 없어 중복으로 누를 수 없다) 조회하는 동안 기다리게 한다.
  const gameTag = game => (game === 'lol' ? `<:${EMOJI.lol.name}:${EMOJI.lol.id}>` : `<:${EMOJI.valorant.name}:${EMOJI.valorant.id}>`); // 게임 로고 이모지 글자
  const searchingCard = game => payload(card({ color: 'info', header: `${gameTag(game)} 전적 검색 중...`, sub: `${game === 'lol' ? '롤' : '발로란트'} · 잠시만 기다려 주세요` }));

  // 결과 이미지(또는 글자)를 채널에 올린다. 성공이면 null, 실패하면 안내 문구를 돌려준다.
  async function upload(interaction, res, game, row) {
    if (!res.ok) return res.message;
    try {
      const sent = await interaction.channel.send(resultPayload(res, game, row, requesterOf(interaction)));
      if (sent?.id) owners.set(sent.id, interaction.user.id); // 이 이미지 밑의 탭 버튼은 띄운 사람만 누를 수 있다
      return null;
    } catch (err) {
      console.error('전적 이미지를 올리지 못함:', err);
      return '이미지를 올리지 못했어요. 봇이 이 채널에 파일을 올릴 수 있는지 확인해 주세요.';
    }
  }

  async function handleRecordButton(interaction) {
    const blocked = blockedCard(interaction);
    if (blocked) return interaction.reply(blocked);
    const parts = interaction.customId.split(':');
    const action = parts[1];

    if (action === 'link') {
      const input = (id, label) => new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setPlaceholder('이름#태그 (예: Mino#KR1)').setRequired(false).setMaxLength(30));
      return interaction.showModal(new ModalBuilder().setCustomId('record:link_modal').setTitle('게임 계정 연결')
        .addComponents(input('lol', '롤 Riot ID (비워두면 연결 안 함)'), input('valorant', '발로란트 Riot ID (비워두면 연결 안 함)')));
    }

    if (action === 'find') {
      const input = (id, label) => new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setPlaceholder('이름#태그 (예: Mino#KR1)').setRequired(false).setMaxLength(30));
      return interaction.showModal(new ModalBuilder().setCustomId('record:find_modal').setTitle('닉네임으로 전적 검색')
        .addComponents(input('lol', '롤 Riot ID (비워두면 조회 안 함)'), input('valorant', '발로란트 Riot ID (비워두면 조회 안 함)')));
    }

    if (action === 'q') { // 이미지의 탭 버튼: 그 이미지를 띄운 사람만 누를 수 있다(주인을 모르는 옛 메시지는 누구나)
      const owner = owners.get(interaction.message?.id);
      if (owner && owner !== interaction.user.id) {
        return interaction.reply(info({ header: '🙅 요청자만 조작할 수 있어요', sub: '전적 검색', lines: [`이 전적은 <@${owner}>님이 요청했어요.`, '내 전적은 `/전적`으로 직접 조회해 보세요.'] }));
      }
      // 이미지의 탭 버튼: 누르는 즉시 눌린 탭을 표시하고, 새 이미지가 준비되면 같은 메시지를 교체한다
      if (parts[2] === 'val') {
        const tab = parts[3];
        const id = parseRiotId(parts.slice(4).join(':'));
        if (!id) return interaction.reply(info({ color: 'err', header: '❌ 전적을 불러오지 못했어요', sub: '발로란트 전적', lines: ['닉네임을 읽지 못했어요.'] }));
        const idText = `${id.name}#${id.tag}`;
        await interaction.update(pendingCard('valorant', valRow(idText, tab, true), requesterOf(interaction)));
        const res = await valorant.lookup(id, tab);
        if (!res.ok) { // 실패하면 잠근 버튼을 풀고 오류를 안내한다
          await interaction.editReply(pendingCard('valorant', valRow(idText, null), requesterOf(interaction)));
          return interaction.followUp(info({ color: 'err', header: '❌ 전적을 불러오지 못했어요', sub: '발로란트 전적', lines: [res.message] }));
        }
        return interaction.editReply(resultPayload(res, 'valorant', valRow(res.id, tab), requesterOf(interaction)));
      }
      const queue = parts[3], puuid = parts[4];
      await interaction.update(pendingCard('lol', queueRow(puuid, queue, true), requesterOf(interaction)));
      const res = await lol.lookup({ puuid }, queue);
      if (!res.ok) {
        await interaction.editReply(pendingCard('lol', queueRow(puuid, null), requesterOf(interaction)));
        return interaction.followUp(info({ color: 'err', header: '❌ 전적을 불러오지 못했어요', sub: '롤 전적', lines: [res.message] }));
      }
      return interaction.editReply(resultPayload(res, 'lol', queueRow(res.puuid ?? puuid, queue), requesterOf(interaction))); // 첨부를 비우고 새 그림으로 바꾼다
    }

    if (action === 'lol' || action === 'val') {
      const game = action === 'lol' ? 'lol' : 'valorant';
      const { target, own, ownerId } = resolveTarget(parts.slice(2).join(':'), interaction.user.id, game);
      if (!target) {
        const name = game === 'lol' ? '롤' : '발로란트';
        return interaction.reply(own
          ? info({ header: '🔗 계정 연결이 필요해요', sub: `${name} 전적`, lines: [`아직 **${name}** 계정이 연결되지 않았어요.`, '연결해 두면 이름을 입력하지 않아도 바로 조회할 수 있어요.'], rows: [new ActionRowBuilder().addComponents(button('record:link', '계정 연결', ButtonStyle.Primary).setEmoji('🔗'))] })
          : info({ header: '🙅 연결된 계정이 없어요', sub: `${name} 전적`, lines: [`<@${ownerId}>님은 아직 **${name}** 계정을 연결하지 않았어요.`, '닉네임을 알고 있다면 직접 찾아볼 수 있어요.'], rows: [new ActionRowBuilder().addComponents(button('record:find', '닉네임으로 검색').setEmoji('🔍'))] }));
      }
      await interaction.update(searchingCard(game));
      const res = await (game === 'lol' ? lol : valorant).lookup(target, 'all');
      const problem = await upload(interaction, res, game, tabsFor(game, res));
      if (problem) return interaction.editReply(selectCard(null, false, problem)); // 선택 카드로 돌아와 다시 고를 수 있게
      return interaction.deleteReply().catch(() => {}); // 이미지가 올라갔으니 선택 카드는 지운다
    }
  }

  async function checkOne(label, text, verify) {
    const id = parseRiotId(text);
    if (!id) return { error: problemLine(label, '이름#태그 형식으로 적어 주세요. (예: Mino#KR1)') };
    try {
      return { account: await verify(id.name, id.tag) };
    } catch (err) {
      return { error: problemLine(label, err instanceof RiotError ? riotErrorMessage(err) : '확인하지 못했어요. 잠시 후 다시 해 주세요.') };
    }
  }

  // 닉네임으로 검색 모달 제출: 채운 게임의 전적을 이름으로 조회해 채널에 올린다(연결 불필요).
  async function handleFind(interaction) {
    const lolText = interaction.fields.getTextInputValue('lol').trim();
    const valText = interaction.fields.getTextInputValue('valorant').trim();
    if (!lolText && !valText) return interaction.editReply(info({ header: '✏️ 입력이 필요해요', sub: '닉네임으로 검색', lines: ['롤이나 발로란트 중 하나 이상 입력해 주세요.'] }, false));
    const jobs = [['롤', 'lol', lolText, lol], ['발로란트', 'valorant', valText, valorant]].filter(j => j[2]);
    const problems = [];
    const ids = jobs.map(([label, , text]) => {
      const id = parseRiotId(text);
      if (!id) problems.push(problemLine(label, '이름#태그 형식으로 적어 주세요. (예: Mino#KR1)'));
      return id;
    });
    if (problems.length) return interaction.editReply(info({ header: '✏️ 형식을 확인해 주세요', sub: '닉네임으로 검색', lines: problems }, false));
    await interaction.editReply(payload(card({ color: 'info', header: `${jobs.map(([, game]) => gameTag(game)).join(' ')} 전적 검색 중...`, sub: `${jobs.map(([label], n) => `${label} ${ids[n].name}#${ids[n].tag}`).join(' · ')} · 잠시만 기다려 주세요` })));
    for (const [n, [label, game, , service]] of jobs.entries()) {
      const res = await service.lookup(ids[n], 'all');
      const problem = await upload(interaction, res, game, tabsFor(game, res));
      if (problem) problems.push(problemLine(label, problem));
    }
    if (problems.length) return interaction.editReply(info({ color: 'err', header: '❌ 전적을 불러오지 못했어요', sub: '닉네임으로 검색', lines: problems }, false));
    return interaction.deleteReply().catch(() => {}); // 올라갔으니 안내 메시지는 지운다
  }

  // 계정 연결 모달 제출: 입력한 계정이 실제로 있는지 확인하고, 하나라도 틀리면 아무것도 저장하지 않는다.
  async function handleRecordModal(interaction) {
    const blocked = blockedCard(interaction);
    if (blocked) return interaction.reply(blocked);
    await interaction.deferReply({ flags: EPHEMERAL });
    if (interaction.customId === 'record:find_modal') return handleFind(interaction);
    const lolText = interaction.fields.getTextInputValue('lol').trim();
    const valText = interaction.fields.getTextInputValue('valorant').trim();
    if (!lolText && !valText) return interaction.editReply(info({ header: '✏️ 입력이 필요해요', sub: '계정 연결', lines: ['롤이나 발로란트 중 하나 이상 입력해 주세요.'] }, false));
    const [lolRes, valRes] = await Promise.all([
      lolText ? checkOne('롤', lolText, verifyLol) : null,
      valText ? checkOne('발로란트', valText, verifyValorant) : null,
    ]);
    const problems = [lolRes?.error, valRes?.error].filter(Boolean);
    if (problems.length) return interaction.editReply(info({ color: 'err', header: '❌ 연결하지 않았어요', sub: '계정 연결', lines: problems, footer: '입력한 계정이 모두 확인돼야 연결돼요' }, false));
    const linked = {};
    if (lolRes) linked.lol = { puuid: lolRes.account.puuid, name: lolRes.account.name, tag: lolRes.account.tag };
    if (valRes) linked.valorant = valRes.account;
    setLinked(interaction.user.id, linked);
    save();
    const lines = [];
    if (lolRes) lines.push(`<:${EMOJI.lol.name}:${EMOJI.lol.id}> **롤** · ${lolRes.account.name}#${lolRes.account.tag}`);
    if (valRes) lines.push(`<:${EMOJI.valorant.name}:${EMOJI.valorant.id}> **발로란트** · ${valRes.account.name}#${valRes.account.tag}`);
    return interaction.editReply(info({ color: 'ok', header: '✅ 계정을 연결했어요', sub: '계정 연결', lines, footer: '이제 /전적에서 이름 없이 바로 볼 수 있어요' }, false));
  }

  return { startRecordCommand, handleRecordSelect, handleRecordButton, handleRecordModal };
}

// ── 실제 연결(처음 쓸 때 만든다) ───────────────────────────────────────────
const OWNERS_PATH = path.join(__dirname, '..', '..', 'DB', 'riot-owners.json');
const MATCHES_PATH = path.join(__dirname, '..', '..', 'DB', 'riot-matches.json');
const ICON_DIR = path.join(__dirname, '..', '..', 'assets', '전적');
let live = null;

function getLive() {
  if (live) return live;
  const riotKey = process.env.RIOT_API_KEY ?? '';
  const henrikKey = process.env.HENRIK_API_KEY ?? '';
  const riot = createRiotClient({ key: riotKey, limiter: createLimiter() });
  const store = createMatchStore({ file: MATCHES_PATH });
  const owners = createOwnerStore({ file: OWNERS_PATH });
  const statics = createStatic({
    fetchJson: async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); },
    fetchBuffer: async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} ${r.status}`); return Buffer.from(await r.arrayBuffer()); },
    dir: ICON_DIR,
  });
  const lol = createLolService({ riot, store, statics });
  const valorant = createValorantService({ key: henrikKey, statics });
  live = {
    store, owners, lol, valorant,
    handlers: createRecordHandlers({
      owners,
      canUse: accounts.canUseRecordSearch, canUseHere: accounts.canUseRecordChannel, getLinked: accounts.getLinked, setLinked: accounts.setLinked, save: accounts.saveRecordAccounts,
      lol,
      valorant,
      verifyLol: lol.verify,
      verifyValorant: async (name, tag) => { await fetchValorant({ name, tag, key: henrikKey }); return { name, tag }; },
    }),
  };
  return live;
}

function loadRecordSearch() {
  accounts.loadRecordAccounts();
  getLive().store.load();
  getLive().owners.load();
}

function saveRecordSearch() {
  accounts.saveRecordAccounts();
  if (live) { live.store.save(); live.owners.save(); }
}

// 봇이 켜진 뒤 한가할 때 미리 데운다(레이드 그림과 같은 방식): 그림 엔진·글자 모양은 잘게 나눠 한 조각씩, 정적 데이터는 네트워크로.
// 첫 /전적이 느리지 않게 하는 것이 목적이라 실패해도 조용히 넘어간다.
function warmUpRecordSearch() {
  const startedAt = Date.now();
  const steps = [() => warmLolRender(), () => warmValorantRender()];
  const next = () => {
    const step = steps.shift();
    if (!step) {
      Promise.allSettled([getLive().lol.warm(), getLive().valorant.warm()]).then(() => console.warn(`🎨 전적 그림·정적 데이터 미리 데우기 완료 — ${Date.now() - startedAt}ms`));
      return;
    }
    try { step(); } catch (err) { console.error('전적 그림 미리 데우기 실패(첫 조회가 조금 느릴 수 있음):', err); }
    setImmediate(next);
  };
  setImmediate(next);
}

module.exports = {
  createRecordHandlers, loadRecordSearch, saveRecordSearch, warmUpRecordSearch,
  startRecordCommand: i => getLive().handlers.startRecordCommand(i),
  handleRecordButton: i => getLive().handlers.handleRecordButton(i),
  handleRecordSelect: i => getLive().handlers.handleRecordSelect(i),
  handleRecordModal: i => getLive().handlers.handleRecordModal(i),
};
