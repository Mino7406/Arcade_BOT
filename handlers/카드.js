// 카드.js — 컴포넌트 v2(ContainerBuilder) 카드 공통 빌더.
// 예전에는 기능마다 EmbedBuilder를 직접 만들어 색·푸터·필드 모양이 제각각이었다.
// 이제 모든 화면이 이 파일의 card()/notice()/payload()로 같은 모양을 낸다.
//
// 컴포넌트 v2 메시지의 규칙(디스코드):
//  - IsComponentsV2 플래그를 켜면 content / embeds / poll / sticker 를 같이 못 쓴다.
//  - 한 번 v2로 보낸 메시지는 v1(content+embeds)으로 되돌릴 수 없다 → 수정(edit/update)할 때도
//    계속 payload()로 만들어 같은 플래그를 붙여야 한다.
//  - 메시지 전체 텍스트(TextDisplay 합계)는 4000자까지, 컴포넌트는 컨테이너 안 포함 40개까지.
//  - 버튼·선택 메뉴 줄(ActionRow)은 컨테이너 안에 넣을 수 있다(카드 안에 버튼이 들어가 한 덩어리로 보임).
//
// 순수 도구 파일이라 다른 핸들러를 require 하지 않는다(순환참조 방지).

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SectionBuilder,
  MediaGalleryBuilder,
  ThumbnailBuilder,
  MessageFlags,
  ComponentType,
} = require('discord.js');

const V2_FLAG = MessageFlags.IsComponentsV2;
const EPHEMERAL_FLAG = MessageFlags.Ephemeral;

// 카드 왼쪽 띠 색. 상태별로 같은 색을 쓰도록 한곳에 모았다.
const COLORS = {
  ok: 0x57F287,     // 성공·완료·마감
  warn: 0xFEE75C,   // 주의·만료
  err: 0xED4245,    // 실패·취소·거절
  info: 0x5865F2,   // 일반 안내(블러플)
  muted: 0x808080,  // 대기·시간 초과
  gold: 0xF1C40F,   // 보상·랭킹
};

// TextDisplay 하나는 4000자, 메시지 전체 합계도 4000자 제한이라 긴 목록은 줄 단위로 자른다.
const TEXT_LIMIT = 3800;

function clip(text, limit = TEXT_LIMIT) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return `${s.slice(0, limit - 1)}…`;
}

// 줄 목록을 limit 안에서 자르고, 잘린 줄 수를 "… 외 N줄"로 알려준다.
function clipLines(lines, limit = 1500) {
  const out = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const add = lines[i].length + 1;
    if (used + add > limit) {
      out.push(`… 외 ${lines.length - i}줄`);
      return out.join('\n');
    }
    out.push(lines[i]);
    used += add;
  }
  return out.join('\n');
}

function emojiUrl(id, size = 128) {
  return `https://cdn.discordapp.com/emojis/${id}.png?size=${size}`;
}

// 커스텀 이모지 문자열(<:이름:id>)에서 id만 꺼낸다. 유니코드 이모지면 null.
function customEmojiId(emoji) {
  const m = /^<a?:\w+:(\d+)>$/.exec(String(emoji ?? '').trim());
  return m ? m[1] : null;
}

function divider(small = true) {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(small ? SeparatorSpacingSize.Small : SeparatorSpacingSize.Large);
}

function gap() {
  return new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small);
}

// 본문을 담은 TextDisplay. 빈 문자열은 디스코드가 거부하므로 항상 최소 한 글자를 넣는다.
function text(content) {
  return new TextDisplayBuilder().setContent(clip(content) || '​');
}

// 이모지 접두사로 알림 톤을 고른다: ⚠️ 주의 · ❌ 실패 · ✅ 성공 · ⏰/⏳ 대기.
function toneOf(content) {
  const s = String(content ?? '').trimStart();
  if (/^(❌|🚫|⛔|☠️)/u.test(s)) return 'err';
  if (/^(⚠️|⚠)/u.test(s)) return 'warn';
  if (/^(✅|🎉|🏆)/u.test(s)) return 'ok';
  if (/^(⏰|⏳|💤)/u.test(s)) return 'muted';
  return 'info';
}

/**
 * 카드(컨테이너) 한 장을 만든다.
 *
 * @param {object} o
 * @param {number|string} [o.color]  띠 색(숫자) 또는 COLORS 키
 * @param {string} [o.header]        큰 제목(`# ` 자동). 이모지 포함 가능
 * @param {string} [o.sub]           제목 아래 작은 회색 줄(`-# ` 자동). 배열이면 " · "로 이음
 * @param {string} [o.thumb]         오른쪽 위 작은 그림 URL (제목+부제와 같은 섹션에 붙음)
 * @param {string} [o.thumbAlt]
 * @param {Array<string|object|null>} [o.blocks]  본문 덩어리. 문자열 = 구분선 + 글,
 *                                   {text, noDivider:true} = 구분선 없이 이어 붙임, null = 건너뜀
 * @param {string} [o.image]         본문 아래 큰 그림 URL(attachment://파일명 가능)
 * @param {string} [o.footer]        맨 아래 작은 회색 줄(`-# ` 자동)
 * @param {Array} [o.rows]           카드 안(맨 아래)에 넣을 ActionRow 목록
 */
function card(o = {}) {
  const container = new ContainerBuilder();
  const accent = typeof o.color === 'string' ? COLORS[o.color] : o.color;
  if (accent !== undefined && accent !== null) container.setAccentColor(accent);

  const head = [];
  if (o.header) head.push(text(`# ${o.header}`));
  const subText = Array.isArray(o.sub) ? o.sub.filter(Boolean).join(' · ') : o.sub;
  if (subText) head.push(text(`-# ${subText}`));

  if (head.length > 0) {
    if (o.thumb) {
      const thumb = new ThumbnailBuilder().setURL(o.thumb);
      if (o.thumbAlt) thumb.setDescription(o.thumbAlt);
      container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(...head).setThumbnailAccessory(thumb));
    } else {
      container.addTextDisplayComponents(...head);
    }
  }

  let first = head.length === 0;
  for (const block of o.blocks || []) {
    if (block === null || block === undefined || block === false) continue;
    const spec = typeof block === 'string' ? { text: block } : block;
    if (!spec.text) continue;
    if (!first && !spec.noDivider) container.addSeparatorComponents(divider());
    else if (!first && spec.noDivider) container.addSeparatorComponents(gap());
    container.addTextDisplayComponents(text(spec.text));
    first = false;
  }

  if (o.image) {
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item => item.setURL(o.image)));
    first = false;
  }

  if (o.footer) {
    if (!first) container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(text(`-# ${o.footer}`));
    first = false;
  }

  const rows = [].concat(o.rows || []).filter(Boolean);
  if (rows.length > 0) {
    if (!first) container.addSeparatorComponents(gap());
    container.addActionRowComponents(...rows);
  }

  return container;
}

/**
 * 보내기/수정용 메시지 옵션(payload)을 만든다. v2 메시지는 수정할 때마다 같은 플래그가 필요하고
 * 예전 content/embeds/첨부가 남아 있으면 거부되므로 항상 비워서 돌려준다.
 *
 * @param {ContainerBuilder|Array} cards  카드 하나 또는 컴포넌트 배열(카드 + 바깥 ActionRow 등)
 * @param {object} [extra]  allowedMentions, ephemeral:true 등 나머지 옵션
 */
function payload(cards, extra = {}) {
  const { ephemeral, keepAttachments, ...rest } = extra;
  const components = Array.isArray(cards) ? cards : [cards];
  return {
    // 임베드 안의 <@id> 는 알림이 가지 않았지만 v2 글자(TextDisplay)는 알림이 간다.
    // 예전 동작을 지키려고 기본은 멘션 차단 — 일부러 부를 때만 allowedMentions를 직접 넘긴다.
    allowedMentions: { parse: [] },
    ...rest,
    content: '',
    embeds: [],
    // 예전 메시지에 남은 첨부를 정리한다. 이미지(attachment://)를 계속 쓰는 화면은 keepAttachments:true.
    ...(keepAttachments ? {} : { attachments: [] }),
    components,
    flags: V2_FLAG | (ephemeral ? EPHEMERAL_FLAG : 0),
  };
}

/**
 * 이미 올라간 v2 메시지에서 "맨 위 버튼 줄"만 바꾼다(카드·이미지 등 나머지는 그대로).
 * 예전엔 message.edit({ components: [] }) 로 버튼만 떼었지만, v2에서는 components 가 메시지 전체라
 * 그렇게 하면 카드까지 사라진다. 카드 안(컨테이너 안)의 버튼은 건드리지 않는다.
 */
function withTopRows(message, rows = []) {
  const kept = (message.components || [])
    .filter(c => c.type !== ComponentType.ActionRow)
    .map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c));
  return {
    allowedMentions: { parse: [] },
    components: [...kept, ...[].concat(rows).filter(Boolean)],
    flags: V2_FLAG,
  };
}

/**
 * 짧은 안내 한 줄(만료·취소·완료 등)을 카드로 만든다. 예전의
 *   { content: '⚠️ **만료된 내전입니다.**', embeds: [], attachments: [], components: [] }
 * 를 그대로 대체한다. 톤(띠 색)은 문장 앞 이모지로 자동 결정.
 *
 * @param {string} content
 * @param {object} [o]
 * @param {Array}  [o.rows]  카드 안에 넣을 ActionRow(예: 관리 메뉴)
 * @param {string} [o.tone]  'ok'|'warn'|'err'|'info'|'muted'
 * @param {boolean} [o.ephemeral]
 */
function notice(content, o = {}) {
  const { rows, tone, color, ephemeral, ...rest } = o;
  const c = card({ color: color ?? tone ?? toneOf(content), blocks: [content], rows });
  return payload(c, { ephemeral, ...rest });
}

module.exports = {
  V2_FLAG,
  EPHEMERAL_FLAG,
  COLORS,
  clip,
  clipLines,
  emojiUrl,
  customEmojiId,
  divider,
  gap,
  text,
  toneOf,
  card,
  payload,
  withTopRows,
  notice,
};
