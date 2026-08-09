// voiceRooms.js — ProBot 스타일 "임시 음성채널" 기능
// 지정된 허브(트리거) 채널에 들어가면 개인 음성채널을 새로 만들어 그리로 옮겨주고,
// 그 채널에 아무도 남지 않으면 자동으로 삭제한다.

const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');

const DATA_PATH = path.join(__dirname, '..', 'voiceRooms.json');

const GUILD_ID = '1339928155359543306';
const HUB_CHANNEL_ID = '1340526081794637864';
const TEMP_CATEGORY_ID = '1339928155359543308';

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
      await channel.delete().catch(() => {});
      tempChannelIds.delete(channelId);
      changed = true;
    }
  }
  if (changed) saveTempChannels();
}

// 허브 채널 입장 → 임시 채널 생성 + 이동 / 임시 채널이 비면 삭제.
// index.js의 voiceStateUpdate 이벤트에서 호출된다.
async function handleTempVoiceState(oldState, newState) {
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (guildId !== GUILD_ID) return;

  // 허브 채널에 새로 들어온 경우(음소거 토글 등 다른 갱신과 구분하기 위해
  // "이전에는 허브가 아니었던" 경우만 처리)
  if (newState.channelId === HUB_CHANNEL_ID && oldState.channelId !== HUB_CHANNEL_ID) {
    const member = newState.member;
    const guild = newState.guild;
    if (!member || !guild) return;

    let tempChannel;
    try {
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

    tempChannelIds.add(tempChannel.id);
    saveTempChannels();

    try {
      await member.voice.setChannel(tempChannel);
    } catch (err) {
      console.error('임시 음성채널로 이동 실패:', err);
      tempChannelIds.delete(tempChannel.id);
      saveTempChannels();
      await tempChannel.delete().catch(() => {});
    }
    return;
  }

  // 추적 중인 임시 채널에서 마지막 사람이 나가면 삭제
  if (oldState.channelId && oldState.channelId !== newState.channelId && tempChannelIds.has(oldState.channelId)) {
    const channel = oldState.channel;
    if (channel && channel.members.size === 0) {
      tempChannelIds.delete(channel.id);
      saveTempChannels();
      await channel.delete().catch(() => {});
    }
  }
}

module.exports = { handleTempVoiceState, reconcileTempChannels };
