import test from 'node:test';
import assert from 'node:assert/strict';
import {OutboundRejection} from '@dot-bridge/core/channels/outbound.js';
import {createProvider} from '../src/provider.js';

const credentials = {ownerId:'owner@im.wechat',conversationId:'owner@im.wechat',botId:'bot@im.bot',botToken:'fixture-token'};
const input = {text:'fixture reminder',idempotencyKey:'stable-owner-intent',authorize:()=>{}};
const abortable = signal => new Promise((resolve,reject)=>{
  if(signal.aborted)reject(Error('aborted'));
  else signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});
});
async function fixture(t,serve=async()=>Response.json({ret:0})){
  const calls=[];
  const provider=createProvider({credentials,state:{get:()=>undefined,set:()=>{},delete:()=>{}},onMessage:async()=>{},fetch:async(url,options)=>{
    if(url.endsWith('/getupdates'))return abortable(options.signal);
    calls.push({url,options});return serve(url,options);
  }});
  await provider.start();t.after(()=>provider.stop());return {provider,calls};
}

test('independent owner text uses the fixed official endpoint and no source context',async t=>{
  const {provider,calls}=await fixture(t);
  const result=await provider.sendOwnerMessage(input);
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
  assert.equal(calls[0].options.redirect,'error');
  const body=JSON.parse(calls[0].options.body);
  assert.deepEqual(body.msg,{from_user_id:'',to_user_id:credentials.ownerId,client_id:result.providerMessageId,message_type:2,message_state:2,item_list:[{type:1,text_item:{text:input.text}}]});
  assert.match(result.providerMessageId,/^dot-owner-[a-f0-9]{32}$/u);
  await provider.sendOwnerMessage(input);
  assert.equal(JSON.parse(calls[1].options.body).msg.client_id,result.providerMessageId);
});

test('caller cannot override owner or supply a cached token; malformed or unauthorized sends never reach HTTP',async t=>{
  const {provider,calls}=await fixture(t);
  for(const patch of [{recipient:'other'},{to:'other'},{message:{replyContext:{contextToken:'old'}}},{contextToken:'old'},{authorize:undefined},{authorize:()=>{throw Error('revoked');}},{authorize:async()=>{}},{text:' '},{text:'x'.repeat(2001)},{text:'\ud800'},{text:'bad\x00text'},{idempotencyKey:''}]){
    await assert.rejects(provider.sendOwnerMessage({...input,...patch}));
  }
  assert.equal(calls.length,0);
});

test('platform business refusal is a sanitized terminal rejection, not success or a transport retry',async t=>{
  const {provider,calls}=await fixture(t,async()=>Response.json({ret:-2,errmsg:'private fixture context refusal'}));
  await assert.rejects(provider.sendOwnerMessage(input),error=>error instanceof OutboundRejection&&error.reason==='provider_rejected'&&!error.message.includes('private fixture'));
  assert.equal(calls.length,1);assert.equal(provider.status().needsLogin,false);
});

test('explicit permission and quota errors are distinguished without invalidating a working login on HTTP 403',async t=>{
  for(const [status,reason] of [[403,'provider_permission_denied'],[429,'provider_quota_exhausted'],[400,'provider_rejected']]){
    const {provider,calls}=await fixture(t,async()=>new Response('private denial',{status}));
    await assert.rejects(provider.sendOwnerMessage(input),error=>error instanceof OutboundRejection&&error.reason===reason);
    assert.equal(calls.length,1);assert.equal(provider.status().needsLogin,false);
  }
});

test('missing ACK, server errors, invalid JSON and lost transport remain ambiguous and are never retried',async t=>{
  for(const serve of [async()=>Response.json({}),async()=>Response.json({ret:'0'}),async()=>new Response('unavailable',{status:503}),async()=>new Response('invalid'),async()=>{throw Error('Bearer fixture-token');}]){
    const {provider,calls}=await fixture(t,serve);
    await assert.rejects(provider.sendOwnerMessage(input),error=>!(error instanceof OutboundRejection)&&error.message==='Weixin provider request failed.');
    assert.equal(calls.length,1);
  }
});

test('stop aborts an in-flight independent send and waits for its completion',async t=>{
  const {provider,calls}=await fixture(t,async(url,options)=>abortable(options.signal));
  const work=provider.sendOwnerMessage(input);const result=assert.rejects(work);
  await provider.stop();await result;
  assert.equal(calls.length,1);await assert.rejects(provider.sendOwnerMessage(input));assert.equal(calls.length,1);
});
