const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');
const { writeJsonIfChanged } = require('../../handlers/저장');
const { logSystem, logError } = require('../../handlers/로그');

const COBBLEMON_COLOR = 0xE8344E;
// 패널 제목. 재시작 시 저장 목록이 비어 있으면 이 제목으로 게시된 패널을 찾는다.
const PANEL_TITLE = 'ARCADE 코블몬 서버 안내';

// 안내 패널 썸네일. 마크 패널과 같이 attachment:// 방식으로 매번 첨부해 올린다.
const THUMBNAIL_PATH = path.join(__dirname, '..', '..', 'assets', 'cobblemon_thumbnail.png');
const THUMBNAIL_FILENAME = 'cobblemon_thumbnail.png';

// "설치기 다운로드" 버튼이 여는 다운로드 링크. 비어 있으면 "준비 중"으로 안내한다.
const INSTALLER_URL = 'https://github.com/Mino7406/ACI/releases/latest/download/ARCADE_Cobblemon_Installer.exe';

// 서버 오픈 시각(KST). 이 전에는 어드민·오너 포함 누구도 다운로드할 수 없다.
// 링크 버튼은 누르는 순간을 막을 수 없어서, 오픈 전에는 같은 모양의 일반 버튼을 두고(누르면 "잠김" 안내)
// 오픈 시각이 되면 게시된 패널의 버튼을 그 자리에서 진짜 링크 버튼으로 바꿔 한 번에 다운로드되게 한다.
const INSTALLER_OPEN_AT = new Date('2026-10-25T09:00:00+09:00');

// "ARCADE 모드 사용법" 버튼이 여는 안내 페이지. 비어 있으면 "준비 중" 안내 버튼을 띄운다.
const GUIDE_URL = 'https://mino7406.github.io/ACI/';

// 오픈 시각에 버튼을 바꿔줄 패널 메시지 목록. 재시작해도 어느 메시지를 고칠지 알도록 저장한다.
// { panels: [{ channelId, messageId }] }
const COBBLEMON_PANELS_PATH = path.join(__dirname, '..', '..', 'DB', 'cobblemon_panels.json');
fs.mkdirSync(path.dirname(COBBLEMON_PANELS_PATH), { recursive: true });

function loadPanels() {
  try {
    if (fs.existsSync(COBBLEMON_PANELS_PATH)) return JSON.parse(fs.readFileSync(COBBLEMON_PANELS_PATH, 'utf8')).panels ?? [];
  } catch (err) {
    console.error('코블몬 패널 목록 읽기 실패:', err);
    logSystem({ 유형: '저장 오류', 내용: `cobblemon_panels.json 읽기 실패: ${err?.message ?? err}` });
  }
  return [];
}

function savePanels(panels) {
  try { writeJsonIfChanged(COBBLEMON_PANELS_PATH, { panels }); } catch (err) {
    console.error('코블몬 패널 목록 저장 실패:', err);
    logSystem({ 유형: '저장 오류', 내용: `cobblemon_panels.json 저장 실패: ${err?.message ?? err}` });
  }
}

function isInstallerOpen() {
  return Date.now() >= INSTALLER_OPEN_AT.getTime();
}

// 패널 버튼 줄. 오픈 전에는 설치기 버튼이 일반 버튼('cobblemon:installer'), 오픈 후에는 링크 버튼이다.
function buildCobblemonButtons() {
  const installerButton = INSTALLER_URL && isInstallerOpen()
    ? new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(INSTALLER_URL)
    : new ButtonBuilder().setCustomId('cobblemon:installer').setStyle(ButtonStyle.Success);

  const guideButton = GUIDE_URL
    ? new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(GUIDE_URL)
    : new ButtonBuilder().setCustomId('cobblemon:guide').setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(
    installerButton.setLabel('설치기 다운로드').setEmoji({ id: '1562830370368528384' }), // <:cobblemon:...>
    guideButton.setLabel('ARCADE 모드 사용법').setEmoji({ id: '1563093933809074247' }), // <:pokedex:...>
  );
}

// "코블몬" 안내 패널 — 신청 절차 없이 설치기 링크와 모드 사용법 버튼만 둔다.
// client를 넘기면 footer 아이콘에 봇 프로필 사진을 붙인다(안 넘겨도 동작).
function buildCobblemonPanelPayload(client) {
  const embed = new EmbedBuilder()
    .setColor(COBBLEMON_COLOR)
    .setTitle(PANEL_TITLE)
    .setDescription(
      [
        '-# **2026.10.25 ~**',
        '',
        '> **<:pokeball_cobblemon:1563187920158986281> 참가 방법**',
        '**<:cobblemon:1562830370368528384>설치기 다운로드** 버튼을 누르면 다운로드 링크로 이동됩니다.\n해당 서버는 위 설치기를 통해야만 **접속이 가능합니다.**',
        '',
        '> **<:greatball_cobblemon:1563187918762279072> 주의사항**',
        '해당 서버는 렉을 최소화하기 위해 **월드 제한**을 두고 있습니다.\n**렉을 유발하는 장치 제작, 행동은 제제 대상**입니다.',
        '',
        '> **<:ultraball_cobblemon:1563187922071462009> 행동 강령**',
        'ARCADE 전용 모드 제작으로 갈등 발생을 최소화 하였으나 **갈등을 조장하는 장치 제작, 행동은 제제 대상**입니다.',
      ].join('\n'),
    )
    .setThumbnail(`attachment://${THUMBNAIL_FILENAME}`)
    .setFooter({
      text: "관련 문의는 임원 '김민호' 에게 해주시면 됩니다.",
      iconURL: client?.user?.displayAvatarURL() ?? undefined,
    });

  return {
    embeds: [embed],
    components: [buildCobblemonButtons()],
    files: [new AttachmentBuilder(THUMBNAIL_PATH, { name: THUMBNAIL_FILENAME })],
  };
}

// /신청서로 패널을 게시한 직후 호출 — 오픈 시각에 버튼을 바꿀 수 있게 메시지 위치를 기억해 둔다.
function rememberCobblemonPanel(message) {
  const panels = loadPanels().filter(p => p.messageId !== message.id);
  panels.push({ channelId: message.channelId, messageId: message.id });
  savePanels(panels);
}

// 저장된 목록이 비어 있을 때(목록 저장 기능 이전에 게시했거나 DB를 옮긴 경우) 봇이 올린 패널을 채널에서 찾아 기억한다.
// 각 텍스트 채널의 최근 메시지 100개 안에서 이 패널 제목을 가진 봇 메시지를 찾는다.
async function discoverCobblemonPanels(client) {
  const found = [];
  for (const guild of client.guilds.cache.values()) {
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) continue;
    for (const channel of channels.values()) {
      if (!channel?.isTextBased?.() || !channel.messages) continue;
      const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (!messages) continue;
      for (const m of messages.values()) {
        if (m.author.id === client.user.id && m.embeds[0]?.title === PANEL_TITLE) {
          found.push({ channelId: m.channelId, messageId: m.id });
        }
      }
    }
  }
  if (found.length) savePanels(found);
  return found;
}

// 저장된 패널들을 지금 코드 기준(본문·이모지·썸네일·오픈 전/후 버튼)으로 다시 그린다. 지워진 메시지는 목록에서 뺀다.
async function refreshCobblemonPanels(client) {
  let panels = loadPanels();
  if (!panels.length) panels = await discoverCobblemonPanels(client);
  const kept = [];
  for (const p of panels) {
    const channel = await client.channels.fetch(p.channelId).catch(() => null);
    const message = channel && await channel.messages.fetch(p.messageId).catch(() => null);
    if (!message) continue;
    kept.push(p);
    // attachments: []로 기존 썸네일 첨부를 비우고 새로 올려, 편집할 때마다 첨부가 쌓이지 않게 한다.
    await message.edit({ ...buildCobblemonPanelPayload(client), attachments: [] }).catch(err => {
      console.error('코블몬 패널 갱신 실패:', err);
      logError('처리 오류', `코블몬 패널 갱신 실패 (${p.channelId}/${p.messageId})`, err);
    });
  }
  savePanels(kept);
  return kept.length;
}

// 봇 시작 시 호출. 게시된 패널을 지금 코드 내용으로 한 번 새로 그리고(재시작만으로 문구·이모지 수정이 반영되도록),
// 오픈 전이면 오픈 시각에 다시 그려 버튼을 다운로드 링크로 바꾸도록 예약한다.
function startCobblemonOpenTimer(client) {
  refreshCobblemonPanels(client)
    .then(count => logSystem({ 유형: '봇 상태', 내용: `코블몬 패널 ${count}개를 최신 내용으로 갱신` }))
    .catch(err => console.error('코블몬 패널 갱신 실패:', err));
  scheduleOpenRefresh(client);
}

function scheduleOpenRefresh(client) {
  const wait = INSTALLER_OPEN_AT.getTime() - Date.now();
  if (wait <= 0) return; // 이미 열렸으면 시작 시 갱신에서 링크 버튼으로 그려진다.
  // setTimeout 최대 지연(약 24.8일)을 넘으면 그 시점에 다시 예약한다.
  setTimeout(async () => {
    if (INSTALLER_OPEN_AT.getTime() > Date.now()) { scheduleOpenRefresh(client); return; }
    const count = await refreshCobblemonPanels(client).catch(err => { console.error('코블몬 패널 갱신 실패:', err); return 0; });
    logSystem({ 유형: '봇 상태', 내용: `코블몬 설치기 오픈 — 패널 ${count}개의 버튼을 다운로드 링크로 전환` });
  }, Math.min(wait, 2_000_000_000));
}

// ── "설치기 다운로드"(오픈 전)·"ARCADE 모드 사용법"(링크 미설정 시) 버튼 ('cobblemon:' 프리픽스) ──
async function handleCobblemonButton(interaction) {
  const sub = interaction.customId.split(':')[1];
  if (sub === 'installer') {
    if (!INSTALLER_URL) {
      await interaction.reply({ content: '**아직 준비 중입니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!isInstallerOpen()) {
      const openAtUnix = Math.floor(INSTALLER_OPEN_AT.getTime() / 1000);
      await interaction.reply({
        content: `🔒 **설치기는 <t:${openAtUnix}:F>에 열립니다.** (<t:${openAtUnix}:R>)`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // 오픈 시각이 지났는데 아직 일반 버튼인 패널(갱신 전)을 누른 경우 — 이 패널을 바로 링크 버튼으로 바꾼다.
    await interaction.update({ components: [buildCobblemonButtons()] });
    await interaction.followUp({
      content: '**설치기가 열렸습니다.** 버튼을 한 번 더 누르면 다운로드됩니다.',
      flags: MessageFlags.Ephemeral,
    });
  } else if (sub === 'guide') {
    await interaction.reply({ content: '**아직 준비 중입니다.**', flags: MessageFlags.Ephemeral });
  }
}

module.exports = {
  buildCobblemonPanelPayload,
  rememberCobblemonPanel,
  startCobblemonOpenTimer,
  handleCobblemonButton,
};
