// 음성채널.js — ProBot 스타일 "임시 음성채널" 기능
// 지정된 허브(트리거) 채널에 들어가면 개인 음성채널을 새로 만들어 그리로 옮겨주고,
// 그 채널에 아무도 남지 않으면 자동으로 삭제한다.

const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');

const DATA_PATH = path.join(__dirname, '..', 'voiceRooms.json');

const GUILD_ID = '1339928155359543306';
const HUB_CHANNEL_ID = '1340526081794637864';
const TEMP_CATEGORY_ID = '1499097643966660810';

// 봇이 만든 임시 채널 ID 목록. 재시작해도 잃어버리지 않게 파일로 저장한다
// (재시작 중에 방이 비어도 삭제를 못 하니, 다시 켜졌을 때 확인해서 정리해야 함).
let tempChannelIds = new Set();

function loadTempChannels() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      tempChannelIds = new Set(JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')));
    }
  } catch {
    tempChannelIds = new Set();
  }
}

function saveTempChannels() {
  fs.writeFileSync(DATA_PATH, JSON.stringify([...tempChannelIds]), 'utf8');
}

// 봇 재시작 시 이전에 만든 임시 채널들을 다시 확인한다.
// 그새 비어있으면 바로 삭제하고, 아직 사람이 있으면 계속 추적 대상에 남긴다.
async function reconcileTempChannels(client) {
  loadTempChannels();
  if (tempChannelIds.size === 0) return;

  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return;

  let changed = false;
  for (const channelId of [...tempChannelIds]) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      tempChannelIds.delete(channelId);
      changed = true;
      continue;
    }
    if (channel.members.size === 0) {
      await channel.delete().catch(err => console.error('임시 음성채널 삭제 실패:', err));
      tempChannelIds.delete(channelId);
      changed = true;
    }
  }
  if (changed) saveTempChannels();
}

// 추적 중인 임시 채널이 비었으면 삭제한다. (허브로 바로 재입장해 새 방을 만드는
// 경우에도 이전 방 정리가 빠지지 않도록, 생성 처리보다 먼저 항상 검사한다.)
async function cleanupIfEmpty(oldState, newState) {
  if (!oldState.channelId || oldState.channelId === newState.channelId) return;
  if (!tempChannelIds.has(oldState.channelId)) return;

  const channel = oldState.channel ?? await oldState.guild.channels.fetch(oldState.channelId).catch(() => null);
  if (!channel) {
    tempChannelIds.delete(oldState.channelId);
    saveTempChannels();
    return;
  }
  if (channel.members.size === 0) {
    tempChannelIds.delete(channel.id);
    saveTempChannels();
    await channel.delete().catch(err => console.error('임시 음성채널 삭제 실패:', err));
  }
}

// 허브 채널 입장 → 임시 채널 생성 + 이동. 만든 사람에게는 채널 관리 권한(이름/인원제한 등
// 수정)을 부여한다.
async function createTempChannel(newState) {
  const member = newState.member;
  const guild = newState.guild;
  if (!member || !guild) return;

  let tempChannel;
  try {
    // parent만 지정하면 카테고리 권한을 그대로 이어받는다.
    tempChannel = await guild.channels.create({
      name: `🔊 ${member.displayName}의 방`,
      type: ChannelType.GuildVoice,
      parent: TEMP_CATEGORY_ID,
      bitrate: newState.channel?.bitrate,
      userLimit: newState.channel?.userLimit,
    });
  } catch (err) {
    console.error('임시 음성채널 생성 실패:', err);
    return;
  }

  // 채널은 이미 만들어졌으니 이 시점부터는 무조건 추적 대상에 넣는다
  // (권한 부여가 실패해도 방 자체는 정상 동작해야 하고, 삭제 추적도 끊기면 안 됨).
  tempChannelIds.add(tempChannel.id);
  saveTempChannels();

  // 채널 관리 권한 부여는 별도 오류로 실패해도(예: 봇에 "역할 관리" 권한이 없는 경우)
  // 아래 이동 로직에 영향을 주지 않도록 분리한다.
  await tempChannel.permissionOverwrites
    .create(member.id, { ManageChannels: true })
    .catch(err => console.error('채널 관리 권한 부여 실패(봇에 "역할 관리" 권한이 있는지 확인):', err));

  try {
    await member.voice.setChannel(tempChannel);
  } catch (err) {
    console.error('임시 음성채널로 이동 실패:', err);
    tempChannelIds.delete(tempChannel.id);
    saveTempChannels();
    await tempChannel.delete().catch(err2 => console.error('임시 음성채널 정리 실패:', err2));
  }
}

// index.js의 voiceStateUpdate 이벤트에서 호출된다.
async function handleTempVoiceState(oldState, newState) {
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (guildId !== GUILD_ID) return;

  await cleanupIfEmpty(oldState, newState);

  // 허브 채널에 새로 들어온 경우(음소거 토글 등 다른 갱신과 구분하기 위해
  // "이전에는 허브가 아니었던" 경우만 처리)
  if (newState.channelId === HUB_CHANNEL_ID && oldState.channelId !== HUB_CHANNEL_ID) {
    await createTempChannel(newState);
  }
}

module.exports = { handleTempVoiceState, reconcileTempChannels };
