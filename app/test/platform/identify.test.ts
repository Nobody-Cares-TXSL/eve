import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchExactDouyinId } from '../../src/platform/identify.ts';

test('抖音号精确匹配，昵称相似与 UID 字段不能冒充', () => {
  const entries = [
    { uid:'12345', uniqueId:'target.8', nickname:'相似', secUid:'sec1' },
    { uid:'54321', uniqueId:'target', nickname:'正确', secUid:'sec2' },
    { uid:'999', uniqueId:'wrong', nickname:'target', secUid:'sec3' },
    { uid:'invalid', uniqueId:'target', nickname:'伪造', secUid:'sec4' },
  ];
  assert.deepEqual(matchExactDouyinId('target', entries).map(x => x.uid), ['54321']);
  assert.deepEqual(matchExactDouyinId('missing',entries), []);
});
test('缺少 secUid 的搜索项不作为可确认身份', () => {
  assert.equal(matchExactDouyinId('target', [{uid:'54321',uniqueId:'target',nickname:'A',secUid:''}]).length, 0);
});
