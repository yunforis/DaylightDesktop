/**
 * RAG 开关判定集中在这里，避免各调用点各写一份表达式而慢慢跑偏。
 *
 * `ragEnabled` 与 `ragEmbeddings` 都是「默认开启、显式 false 才关闭」：知识库检索是旁路能力，
 * 配置好邮箱与模型后应当开箱可用，而不是要求用户先找到一个默认关闭的开关。
 */

export function isRagEnabled(settings) {
  return settings?.ragEnabled !== false;
}

export function isRagEmbeddings(settings) {
  return settings?.ragEmbeddings !== false;
}
