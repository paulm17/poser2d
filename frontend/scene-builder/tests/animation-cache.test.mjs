import test from 'node:test';
import assert from 'node:assert/strict';
import {AnimationFrameCache} from '../src/poses/animation-cache.js';

test('frame cache shares requests and evicts the least recently used clip',async()=>{
 const cache=new AnimationFrameCache(2);let calls=0;
 await Promise.all([cache.get('a',async()=>{calls++;return {id:'a'};}),cache.get('a',()=>{throw Error('Duplicate request');})]);assert.equal(calls,1);
 await cache.get('b',()=>({id:'b'}));cache.peek('a');await cache.get('c',()=>({id:'c'}));
 assert(cache.peek('a'));assert.equal(cache.peek('b'),undefined);assert.equal(cache.values.size,2);
});
test('failed frame requests can be retried',async()=>{
 const cache=new AnimationFrameCache();await assert.rejects(cache.get('broken',()=>{throw Error('Network failure');}));
 assert.equal(cache.pending.size,0);assert.deepEqual(await cache.get('broken',()=>({ready:true})),{ready:true});
});
