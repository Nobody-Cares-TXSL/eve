/** normalizeInboundMessage 的单元验证（T0-3 证据之一，全 mock 无网络）。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeInboundMessage, type RawMessageLike } from '../../src/platform/normalize.ts';

const SELF = '1000000000000001';
const PEER = '10000000000002';
const SELF_UIDS = new Set([SELF]);

function base(over: Partial<RawMessageLike> = {}): RawMessageLike {
  return {
    threadId: `0:1:${SELF}:${PEER}`,
    conversationShortId: '7701260499833538097',
    senderUid: PEER,
    serverMessageId: '7701260499833538097',
    text: '你好',
    messageType: 7,
    createTime: '1793089447211',
    indexInConversation: '1672502401420000',
    ...over,
  };
}

/** 归一化并断言成功，返回消息；默认单 UID 的 selfUids。 */
function ok(raw: RawMessageLike, selfUids: ReadonlySet<string> = SELF_UIDS) {
  const result = normalizeInboundMessage(raw, selfUids);
  assert.equal(result.ok, true, `期望归一化成功，实际：${JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.message;
}

test('权威会话键用 threadId，不是 conversationShortId', () => {
  assert.equal(ok(base()).conversationId, `0:1:${SELF}:${PEER}`);
});

test('threadId 缺失时回退 conversationShortId', () => {
  assert.equal(ok(base({ threadId: undefined })).conversationId, '7701260499833538097');
});

test('两者都缺 → 拒绝归一化，不猜测归属', () => {
  const result = normalizeInboundMessage(base({ threadId: undefined, conversationShortId: '' }), SELF_UIDS);
  assert.equal(result.ok, false);
});

test('缺少 senderUid → 拒绝（无法判定方向，宁可不处理）', () => {
  assert.equal(normalizeInboundMessage(base({ senderUid: undefined }), SELF_UIDS).ok, false);
});

test('19 位 ID 以字符串保留——该值超出 double 安全精度，转 number 必损坏', () => {
  const message = ok(base());
  assert.equal(typeof message.serverMessageId, 'string');
  assert.equal(message.serverMessageId, '7701260499833538097');
  // 反证：若曾走 number 通道，字符串回写就不等于原值——这就是坚持字符串的理由
  assert.notEqual(String(Number('7701260499833538097')), '7701260499833538097');
});

test('fromSelf：senderUid 命中 selfUids 即为自发回显', () => {
  assert.equal(ok(base({ senderUid: SELF })).fromSelf, true);
  assert.equal(ok(base()).fromSelf, false);
});

test('imUid 也要进 selfUids 集合（SDK 判归属同时看 imUid 与 uid）', () => {
  const IM_UID = '999999999';
  // 集合只含主 UID：imUid 的自发回显会被误判为对方消息 → 可能自我对话死循环
  assert.equal(ok(base({ senderUid: IM_UID })).fromSelf, false);
  // 集合含两者：正确识别
  assert.equal(ok(base({ senderUid: IM_UID }), new Set([SELF, IM_UID])).fromSelf, true);
});

test('无文本事件归为 non_text，正文保持空串不伪造', () => {
  assert.equal(ok(base({ text: '' })).kind, 'non_text');
  assert.equal(ok(base({ text: undefined })).kind, 'non_text');
  assert.equal(ok(base({ text: undefined })).text, '');
});

test('可选 ID 缺失 → null（归档层据此走 no_id_mode），而非空串', () => {
  const message = ok(base({ serverMessageId: undefined, clientMessageId: undefined }));
  assert.equal(message.serverMessageId, null);
  assert.equal(message.clientMessageId, null);
});

test('序号优先 V2，缺失回退 v1（仅透传，不做步长推断）', () => {
  assert.equal(ok(base({ indexInConversationV2: '9000000000000001' })).indexInConversation, '9000000000000001');
  assert.equal(ok(base({ indexInConversationV2: undefined })).indexInConversation, '1672502401420000');
  assert.equal(ok(base({ indexInConversationV2: undefined, indexInConversation: undefined })).indexInConversation, null);
});

test('messageType 未提供 → -1 透传哨兵，不冒充文本 7', () => {
  assert.equal(ok(base({ messageType: undefined })).messageType, -1);
});
