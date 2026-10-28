/**
 * T0-3 smoke：PlatformPort 契约 + mock 替身的行为验证。
 * 证明「core 只依赖端口、测试零网络」这条路走得通；真实实现 T1 补。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockPlatformPort } from '../../src/platform/mock.ts';
import type { InboundMessage, PlatformStatus } from '../../src/platform/types.ts';

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    conversationId: '0:1:self:peer',
    serverMessageId: '1234567890123456789',
    clientMessageId: null,
    senderUid: 'peer',
    fromSelf: false,
    text: 'hi',
    kind: 'text',
    messageType: 7,
    createTime: '1793089447211',
    indexInConversation: '1672502401420000',
    ...over,
  };
}

test('subscribe 先于 start：事件不丢（订阅时序契约）', () => {
  const port = new MockPlatformPort();
  const seen: InboundMessage[] = [];
  port.subscribe({ onMessage: (m) => seen.push(m), onStatus: () => {} });
  port.start();
  port.pushMessage(inbound());
  assert.equal(seen.length, 1);
});

test('状态事件透传（reconnecting 计数供 T4 消费）', () => {
  const port = new MockPlatformPort();
  const statuses: PlatformStatus[] = [];
  port.subscribe({ onMessage: () => {}, onStatus: (s) => statuses.push(s) });
  port.pushStatus({ type: 'reconnecting', attempt: 2, delayMs: 2000 });
  port.pushStatus({ type: 'online', uid: 'self', imUid: 'self-im', nickname: 'x' });
  assert.deepEqual(statuses.map((s) => s.type), ['reconnecting', 'online']);
});

test('readHistory 只返回目标会话（跨会话隔离的端口级预演）', async () => {
  const port = new MockPlatformPort();
  port.subscribe({ onMessage: () => {}, onStatus: () => {} });
  port.pushMessage(inbound({ conversationId: '0:1:self:peer' }));
  port.pushMessage(inbound({ conversationId: '0:1:self:other', serverMessageId: '999' }));
  const history = await port.readHistory('0:1:self:peer');
  assert.equal(history.statusCode, 0);
  assert.equal(history.hasMore, false);
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0]?.conversationId, '0:1:self:peer');
});

test('start/stop 各被调用一次（仅测试 mock 计数，不证明幂等或优雅停机）', async () => {
  const port = new MockPlatformPort();
  await port.start();
  await port.stop();
  assert.equal(port.startCount, 1);
  assert.equal(port.stopCount, 1);
});

test('readHistory 保留历史分页游标与 hasMore', async () => {
  const port = new MockPlatformPort();
  for (let i = 0; i < 5; i++) port.pushMessage(inbound({serverMessageId: String(i)}));
  const first = await port.readHistory('0:1:self:peer');
  assert.equal(first.hasMore, true);
  assert.equal(first.cursor, '3');
  assert.equal(first.messages.length, 2);
  const second = await port.readHistory('0:1:self:peer', first.cursor);
  assert.equal(second.hasMore, true);
  const third = await port.readHistory('0:1:self:peer', second.cursor);
  assert.equal(third.hasMore, false);
  assert.equal(third.cursor, '0');
});
