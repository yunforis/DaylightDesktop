export const DEFAULT_INVITATION_PREFERENCES = Object.freeze({
  autoReply: false,
  acceptedTemplate: '你好，感谢邀请。我确认参加「{title}」。\n时间：{time}\n地点：{location}\n期待见面！',
  declinedTemplate: '你好，感谢邀请。很抱歉，这次无法参加「{title}」。\n祝活动顺利，期待下次有机会见面。',
});
export function normalizeInvitationPreferences(value = {}) {
  return { autoReply: value?.autoReply === true, ...Object.fromEntries(['acceptedTemplate','declinedTemplate'].map(key => [key,
    typeof value?.[key] === 'string' && value[key].trim() ? value[key].trim().slice(0,4000) : DEFAULT_INVITATION_PREFERENCES[key]])) };
}
