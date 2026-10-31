/** T6-3c-real-A：会话快照只能由真实 SDK 实例派生，不接受调用方拼装。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { deriveSendSession, sessionStillLive } from '../../src/platform/outbound-session.ts';

const THREAD = '0:1:222:333';
const expected = { ownerUid: '111', ownImUid: '222', targetUid: '333', conversationId: THREAD };

function refs(o: {
  online?: boolean; imUid?: string; kind?: 'friend' | 'stranger' | 'none';
  blocked?: boolean; threadId?: string; uid?: string; extraAccount?: boolean; sameAccountRef?: boolean;
} = {}) {
  const contact = {
    account: null as unknown, uid: o.uid ?? '333', threadId: o.threadId ?? THREAD,
    conversationType: 1, blocked: 'blocked' in o ? o.blocked : false,
  };
  const account = {
    uid: '111', imUid: o.imUid ?? '222', online: o.online ?? true,
    pickFriend: (uid: string) => (o.kind === 'friend' && uid === '333' ? contact : undefined),
    pickStranger: (uid: string) => (o.kind === 'stranger' && uid === '333' ? contact : undefined),
  };
  contact.account = o.sameAccountRef === false ? { uid: '111' } : account;
  if (o.kind === 'none') {
    account.pickFriend = () => undefined;
    account.pickStranger = () => undefined;
  }
  return { client: { accounts: o.extraAccount ? [account, { uid: '999' }] : [account] }, account, contact };
}

test('好友与陌生人都能派生快照', () => {
  const f = deriveSendSession({ ...refs({ kind: 'friend' }), expected });
  assert.equal(f.ok, true);
  if (!f.ok) return;
  assert.equal(f.session.contact?.kind, 'friend');
  assert.equal(f.session.uid, '111');
  assert.equal(f.session.imUid, '222');

  const s = deriveSendSession({ ...refs({ kind: 'stranger' }), expected });
  assert.equal(s.ok, true);
  if (!s.ok) return;
  assert.equal(s.session.contact?.kind, 'stranger');
});

test('联系人必须挂在同一个 Account 实例上，伪造替身被拒', () => {
  const r = deriveSendSession({ ...refs({ kind: 'friend', sameAccountRef: false }), expected });
  assert.deepEqual(r, { ok: false, code: 'contact_unverified' });
});

test('联系人必须由 account.pickFriend/pickStranger 真实返回', () => {
  const r = deriveSendSession({ ...refs({ kind: 'none' }), expected });
  assert.deepEqual(r, { ok: false, code: 'contact_unverified' });
});

test('多账号、离线、imUid 不符一律 session_unverified', () => {
  for (const o of [{ extraAccount: true }, { online: false }, { imUid: '999' }]) {
    const r = deriveSendSession({ ...refs(o), expected });
    assert.deepEqual(r, { ok: false, code: 'session_unverified' });
  }
});

test('blocked 未知（undefined）保守拒绝，不当作未拉黑', () => {
  const r = deriveSendSession({ ...refs({ kind: 'friend', blocked: undefined as unknown as boolean }), expected });
  assert.deepEqual(r, { ok: false, code: 'contact_blocked' });
  const blocked = deriveSendSession({ ...refs({ kind: 'friend', blocked: true }), expected });
  assert.deepEqual(blocked, { ok: false, code: 'contact_blocked' });
});

test('线程与目标/自身不符 → foreign_conversation', () => {
  const r = deriveSendSession({ ...refs({ kind: 'friend', threadId: '0:1:222:444' }), expected });
  assert.deepEqual(r, { ok: false, code: 'foreign_conversation' });
});

test('身份参数非法 → identity_invalid（非数字/自身等于目标）', () => {
  // 注意：ownImUid === ownerUid 会先被 session 检查拦下，这里覆盖真正走到身份检查的分支
  const bad = { ownerUid: 'abc', ownImUid: '222', targetUid: '333', conversationId: THREAD };
  assert.deepEqual(deriveSendSession({ ...refs({ kind: 'friend' }), expected: bad }),
    { ok: false, code: 'identity_invalid' });
  const sameTarget = { ownerUid: '111', ownImUid: '222', targetUid: '111', conversationId: THREAD };
  assert.deepEqual(deriveSendSession({ ...refs({ kind: 'friend' }), expected: sameTarget }),
    { ok: false, code: 'identity_invalid' });
});

test('sessionStillLive：实例漂移即 false（含对象引用变化）', () => {
  const live = { ...refs({ kind: 'friend' }), expected };
  const first = deriveSendSession(live);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const baseline = { account: live.account, contact: live.contact };
  assert.equal(sessionStillLive(first.session, live, baseline), true, '同一批实例应仍存活');

  // 账号下线（同一实例，状态变化）
  live.account.online = false;
  assert.equal(sessionStillLive(first.session, live, baseline), false);

  // 联系人被替换成另一个「字段完全相同」的新实例：只有引用校验能抓到
  const replaced = { ...refs({ kind: 'friend' }), expected };
  assert.equal(sessionStillLive(first.session, replaced, baseline), false, '换实例即视为漂移');
});

test('outbound-session.ts 不 import douyin-im', () => {
  const src = readFileSync(new URL('../../src/platform/outbound-session.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from ['"]douyin-im['"]/);
});
