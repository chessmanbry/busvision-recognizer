import test from 'node:test';
import assert from 'node:assert/strict';
import {createAlignmentTracker, matchesTarget, saveWaitingTarget, readWaitingTarget, clearWaitingTarget} from '../src/services/waitingTarget.js';
test('alignment: debounce, occlusion tolerance, sustained loss, vibration cooldown', () => {
 const track=createAlignmentTracker();
 assert.deepEqual(track(true,1000),{aligned:false,cue:null});
 assert.deepEqual(track(true,2200),{aligned:true,cue:'acquired'});
 assert.deepEqual(track(false,3400),{aligned:true,cue:null});
 assert.deepEqual(track(true,4600),{aligned:true,cue:null});
 assert.deepEqual(track(false,9700),{aligned:false,cue:'lost'});
 track(true,10000);
 assert.deepEqual(track(true,11200),{aligned:true,cue:null});
 track(false,18000); track(true,19000);
 assert.equal(track(true,20200).cue,'acquired');
});
test('target exact route, no substring or colored-route confusion',()=>{
 const target={routeName:'藍 12'};
 assert.equal(matchesTarget('藍12',target),true);
 assert.equal(matchesTarget('12',target),false);
 assert.equal(matchesTarget('藍123',target),false);
 assert.equal(matchesTarget('紅12',target),false);
});
test('target stores city, direction and stop, expires after two hours and can cancel',()=>{
 const data=new Map(); globalThis.localStorage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const t=saveWaitingTarget({city:'newtaipei',id:'1',name:'932',departure:'A',destination:'B'},{id:'2',name:'C',direction:'1',destination:'A'});
 assert.equal(readWaitingTarget().destination,'A'); assert.equal(readWaitingTarget().stop.direction,'1');
 assert.equal(readWaitingTarget(t.createdAt+7200000),null);
 clearWaitingTarget(); assert.equal(readWaitingTarget(),null);
 delete globalThis.localStorage;
});
