import test from 'node:test';
import assert from 'node:assert/strict';
import {createProvider} from '../src/provider.js';

const credentials={ownerId:'owner@im.wechat',conversationId:'owner@im.wechat',botId:'bot@im.bot',botToken:'synthetic-token'};
const response=(value,status=200)=>new Response(JSON.stringify(value),{status});
async function fixture(t,{configuration={ret:0,typing_ticket:'private-ticket'},status=200}={}){
  const map=new Map(),calls=[];let resolve;const incoming=new Promise(done=>{resolve=done;});let polls=0;
  const state={get:key=>map.get(key),set:(key,value)=>map.set(key,structuredClone(value)),delete:key=>map.delete(key)};
  const provider=createProvider({credentials,state,onMessage:async value=>resolve(value),fetch:async(url,options)=>{
    const endpoint=new URL(url).pathname.split('/').at(-1),body=JSON.parse(options.body);calls.push({endpoint,body});
    if(endpoint==='getupdates'){
      if(++polls===1)return response({ret:0,msgs:[{message_id:'100',from_user_id:credentials.ownerId,to_user_id:credentials.botId,message_type:1,message_state:2,context_token:'private-context',item_list:[{type:1,text_item:{text:'hello'}}]}],get_updates_buf:'next'});
      return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
    }
    if(endpoint==='getconfig')return response(configuration,status);
    if(endpoint==='sendtyping')return response({ret:0});
    throw Error('Unexpected endpoint');
  }});
  t.after(()=>provider.stop());await provider.start();const message=await incoming;return {provider,message,calls,state};
}
test('Weixin typing ticket is owner-bound, cached and cancelled without creating a reply',async t=>{
  const f=await fixture(t);await f.provider.setTyping({message:f.message,active:true,authorize:()=>{}});await f.provider.setTyping({message:f.message,active:true,authorize:()=>{}});await f.provider.setTyping({message:f.message,active:false,authorize:()=>{}});
  assert.equal(f.calls.filter(value=>value.endpoint==='getconfig').length,1);assert.deepEqual(f.calls.filter(value=>value.endpoint==='sendtyping').map(value=>value.body.status),[1,1,2]);assert.equal(f.calls.some(value=>value.endpoint==='sendmessage'),false);assert.equal(f.state.get('typingTicket').owner,credentials.ownerId);assert.equal(JSON.stringify(f.provider.status()).includes('private-ticket'),false);
});
test('expired and wrong-owner tickets are refreshed but another message peer cannot request typing',async t=>{
  const f=await fixture(t);f.state.set('typingTicket',{owner:'other',value:'stale',expires:Date.now()+100000});await f.provider.setTyping({message:f.message,active:true,authorize:()=>{}});
  f.state.set('typingTicket',{owner:credentials.ownerId,value:'old',expires:Date.now()-1});await f.provider.setTyping({message:f.message,active:true,authorize:()=>{}});assert.equal(f.calls.filter(value=>value.endpoint==='getconfig').length,2);
  const before=f.calls.length;await assert.rejects(f.provider.setTyping({message:{...f.message,senderId:'other'},active:true,authorize:()=>{}}));assert.equal(f.calls.length,before);
});
test('optional typing permission refusal does not invalidate normal polling and secrets stay out of errors',async t=>{
  const f=await fixture(t,{configuration:{ret:-4,errmsg:'private raw error'},status:403});await assert.rejects(f.provider.setTyping({message:f.message,active:true,authorize:()=>{}}),error=>!error.message.includes('private raw'));assert.equal(f.provider.status().needsLogin,false);
  const before=f.calls.length;await assert.rejects(f.provider.setTyping({message:f.message,active:true,authorize:()=>{throw Error('revoked');}}),/revoked/);assert.equal(f.calls.length,before);
});
