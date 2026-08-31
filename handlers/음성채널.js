// 음성채널.js — ProBot 스타일 "임시 음성채널" 기능
// 지정된 허브(트리거) 채널에 들어가면 개인 음성채널을 새로 만들어 그리로 옮겨주고,
// 그 채널에 아무도 남지 않으면 자동으로 삭제한다.

const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');

const { GUILD_ID, HUB_CHANNEL_ID, TEMP_CATEGORY_ID } = require('../config');
const { logSystem } = require('./로그');
const { writeJsonIfChanged } = require('./저장');

const DATA_PATH = path.join(__dirname, '..', 'DB', 'voiceRooms.json');
fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });

// 봇이 만든 임시 채널 ID 목록. 재시작해도 잃어버리지 않게 파일로 저장한다
// (재시작 중에 방이 비어도 삭제를 못 하니, 다시 켜졌을 때 확인해서 정리해야 함).
let tempChannelIds = new Set();

function loadTempChannels() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      tempChannelIds = new Set(JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')));
    }
  } catch (err) {
    // 파일이 깨져 있으면 빈 목록으로 시작할 수밖에 없는데, 그러면 이전에 만든 임시 채널들이
    // 추적에서 빠져 아무도 없어도 자동 삭제되지 않는다. 조용히 넘어가면 원인을 알 수 없어 기록한다.
    console.error('임시 음성채널 목록 읽기 실패(추적 목록이 초기화됨):', err);
    logSystem({ 유형: '저장 오류', 내용: `voiceRooms.json 읽기 실패 — 임시 채널 추적 목록 초기화됨: ${err?.message ?? err}` });
    tempChannelIds = new Set();
  }
}

function saveTempChannels() {
  writeJsonIfChanged(DATA_PATH, [...tempChannelIds]);
}

// 방이 얼마나 유지됐는지. 생성 시각을 따로 저장하지 않아도 채널 객체가 createdTimestamp를
// 들고 있으므로 그걸 그대로 쓴다(voiceRooms.json 형식은 건드리지 않는다).
function livedFor(channel) {
  if (!channel?.createdTimestamp) return '유지 시간 알 수 없음';
  const minutes = Math.round((Date.now() - channel.createdTimestamp) / 60_000);
  if (minutes < 60) return `${minutes}분 유지`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 유지`;
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
      logSystem({
        유형: '음성채널',
        채널: `#${channel.name}`,
        내용: `임시 음성채널 삭제 — '${channel.name}'(${channel.id}), ${livedFor(channel)} (봇 재시작 후 빈 방 정리)`,
      });
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
    // 생성 로그와 짝을 맞춘다 — 마지막으로 나간 사람과 방이 유지된 시간까지 남겨야
    // "언제 만들어져서 언제 사라졌는지"가 로그만으로 이어진다.
    const leaver = oldState.member;
    logSystem({
      유형: '음성채널',
      유저: leaver ? `${leaver.displayName}(${leaver.id})` : '-',
      채널: `#${channel.name}`,
      내용: `임시 음성채널 삭제 — '${channel.name}'(${channel.id}), ${livedFor(channel)} (마지막 인원 퇴장)`,
    });
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
    // parent만 지정해서는 카테고리 권한(노래봇 등에 부여된 접속 권한 포함)이 자동으로
    // 복사되지 않는다(디스코드 클라이언트의 "동기화"는 UI 전용 동작). API로 만들 때는
    // 카테고리의 permissionOverwrites를 직접 넘겨줘야 실제로 같은 권한이 적용된다.
    const category = await guild.channels.fetch(TEMP_CATEGORY_ID).catch(() => null);

    // 생성 시점에 position을 같이 넘기면 디스코드가 무시하고 아무 데나(심지어 허브보다
    // 위로) 배치하는 경우가 있어, 일단 만든 뒤 아래에서 setPosition으로 따로 지정한다.
    tempChannel = await guild.channels.create({
      name: `🔊│${member.displayName}의 방`,
      type: ChannelType.GuildVoice,
      parent: TEMP_CATEGORY_ID,
      bitrate: newState.channel?.bitrate,
      userLimit: newState.channel?.userLimit,
      permissionOverwrites: category?.permissionOverwrites.cache.map(o => ({
        id: o.id,
        type: o.type,
        allow: o.allow,
        deny: o.deny,
      })),
    });
  } catch (err) {
    console.error('임시 음성채널 생성 실패:', err);
    logSystem({
      유형: '음성채널',
      유저: `${member.displayName}(${member.id})`,
      내용: `임시 음성채널 생성 실패 — ${err?.message ?? err}`,
    });
    return;
  }

  // 허브("통화방 만들기") 바로 다음 자리에 고정한다. 매번 이 위치로 옮기면 기존 임시
  // 채널들은 한 칸씩 밀려날 뿐이라, 개수와 상관없이 항상 허브와 다른 고정방(1인실 등)
  // 사이에 모여 있게 된다.
  try {
    const hub = newState.channel ?? await guild.channels.fetch(HUB_CHANNEL_ID).catch(() => null);
    if (hub) await tempChannel.setPosition(hub.position + 1);
  } catch (err) {
    console.error('임시 음성채널 위치 지정 실패:', err);
  }

  // 채널은 이미 만들어졌으니 이 시점부터는 무조건 추적 대상에 넣는다
  // (권한 부여가 실패해도 방 자체는 정상 동작해야 하고, 삭제 추적도 끊기면 안 됨).
  tempChannelIds.add(tempChannel.id);
  saveTempChannels();

  // 누가 언제 방을 만들었는지 DB/log.json에 남긴다. 임시 채널은 비면 곧 사라지기 때문에
  // 생성 시점에 남겨두지 않으면 나중에 디스코드 쪽에서 되짚을 방법이 없다.
  logSystem({
    유형: '음성채널',
    유저: `${member.displayName}(${member.id})`,
    채널: `#${tempChannel.name}`,
    내용: `임시 음성채널 생성 — '${tempChannel.name}'(${tempChannel.id})`,
  });

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
    // 위에서 이미 '생성' 로그를 남겼으므로, 되돌린 사실도 남겨야 짝이 맞는다.
    logSystem({
      유형: '음성채널',
      유저: `${member.displayName}(${member.id})`,
      채널: `#${tempChannel.name}`,
      내용: `임시 음성채널 삭제 — '${tempChannel.name}'(${tempChannel.id}) (이동 실패로 취소됨)`,
    });
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
