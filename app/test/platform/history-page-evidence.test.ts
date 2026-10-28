import assert from 'node:assert/strict';
import {test} from 'node:test';
import {projectHistoryPage,type HistoryMessageLike} from '../../src/platform/history.ts';
const own=new Set(['111','222']),thread='0:1:222:333';
function raw(over:Partial<HistoryMessageLike>={}):HistoryMessageLike {
 return {threadId:thread,msgId:'7701260499833538097',senderUid:'333',content:JSON.stringify({text:'hi'}),
  msgType:7,createTime:1793089447000,indexInConversationV2:'9007199254740995',...over};
}
function make(rows:HistoryMessageLike[],cursor:string|null=null,returned='9007199254740996'){
 return projectHistoryPage(rows,{conversationId:thread,targetUid:'333',ownUids:own,statusCode:0,
  hasMore:true,cursor:returned,direction:'older',requestedCursor:cursor,requestedDirection:'older'});
}
test('T4-1 原始、过滤、接受之和守恒；排除原因逐项保留',()=>{
 const page=make([raw(),raw({threadId:'0:1:222:444'}),raw({senderUid:'444'}),raw({deleted:true}),
  raw({senderUid:''}),raw({msgId:''})],'9007199254740999');
 assert.equal(page.rawCount,6);
 assert.equal(page.acceptedCount,2);
 assert.equal(page.excludedCount,4);
 assert.deepEqual(page.exclusions,{foreignConversation:1,foreignSender:2,deleted:1,unrepresentable:0});
 assert.equal(page.missingIdCount,1);
 assert.equal(page.messages[1]?.serverMessageId,null);
 assert.equal(page.cursor,'9007199254740996');
 assert.equal(page.requestedCursor,'9007199254740999');
 assert.equal(page.requestedDirection,'older');
});
test('T4-1 19 位 ID 和超安全整数索引绝不 Number 化',()=>{
 const page=make([raw({indexInConversationV2:'9007199254740995'})]);
 const msg=page.messages[0];
 assert.equal(msg?.serverMessageId,'7701260499833538097');
 assert.equal(msg?.indexInConversation,'9007199254740995');
 assert.notEqual(String(Number(msg?.serverMessageId)),msg?.serverMessageId);
 assert.notEqual(String(Number(msg?.indexInConversation)),msg?.indexInConversation);
});
test('T4-1 群类型、删除行和不可表示行不等于历史空页',()=>{
 const page=make([raw({conversationType:2}),raw({deleted:true})]);
 assert.equal(page.rawCount,2);
 assert.equal(page.acceptedCount,0);
 assert.equal(page.excludedCount,2);
 assert.deepEqual(page.messages,[]);
});
test('T4-1 SDK 最终空页仍保留原生 hasMore 和 cursor，由恢复器判异常',()=>{
 const page=make([],null,'9007199254740999');
 assert.equal(page.hasMore,true);
 assert.equal(page.rawCount,0);
 assert.equal(page.excludedCount,0);
 assert.equal(page.cursor,'9007199254740999');
});
