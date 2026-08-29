// 이름.js — 상호작용/멤버에서 화면에 표시할 이름을 뽑는 공통 규칙.
// 예전엔 여러 게임 핸들러(로그·틱택토·끝말잇기)에 같은 getDisplayName 함수가 복붙돼 있었고
// 내전/모집·레벨·XP 커맨드에는 인라인으로 흩어져 있었다. "서버 별명 → 글로벌 표시 이름 →
// 유저명" 순서 하나로 통일한다.

// interaction을 실행한 유저의 표시 이름.
function displayNameFromInteraction(interaction) {
  return interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
}

// 이미 조회해둔 member/user 조합에서 표시 이름. 대상 유저를 따로 resolve하는 경로(/레벨, /xp)에서 쓴다.
// member는 서버를 나갔으면 없을 수 있으므로, 마지막으로 '알 수 없는 유저'까지 폴백한다.
function displayNameFromMember(member, user) {
  return member?.displayName || user?.globalName || user?.username || '알 수 없는 유저';
}

module.exports = { displayNameFromInteraction, displayNameFromMember };
