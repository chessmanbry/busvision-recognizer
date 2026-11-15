import test from 'node:test';
import assert from 'node:assert/strict';
import { etaLabel,selectArrival,parseFeedTime,isFeedFresh } from '../src/services/transitData.js';
test('ETA distinguishes missing values, arrival, minutes and service statuses',()=>{
 assert.equal(etaLabel(null).text,'暫無預估');assert.equal(etaLabel('').text,'暫無預估');
 assert.equal(etaLabel('0').text,'即將到站');assert.equal(etaLabel('121').text,'3');
 assert.equal(etaLabel('-2').text,'交管不停靠');assert.equal(etaLabel('-3').text,'末班已過');
});
test('arrival matches route and direction-specific stop, including status GoBack',()=>{
 const rows=[{RouteID:1,StopID:2,GoBack:'1',EstimateTime:'20'},{RouteID:1,StopID:2,GoBack:'2',EstimateTime:'-1'}];
 assert.equal(selectArrival(rows,'1',{id:'2',direction:'0'}).EstimateTime,'-1');
 assert.equal(selectArrival(rows,'9',{id:'2',direction:'0'}),undefined);
});
test('official time uses Taiwan time and old or invalid feeds are not live',()=>{
 const t=parseFeedTime('2026/11/14 13:29:45');assert.equal(t,Date.parse('2026-11-14T05:29:45Z'));
 assert.equal(isFeedFresh(t,t+120001),false);assert.equal(isFeedFresh(NaN),false);assert.equal(isFeedFresh(t,t+10000),true);
});
import {normalizeRoutes,normalizeStops,isNearCampus} from '../src/services/transitData.js';
test('route IDs are deduplicated within a city and retain city namespace',()=>{const rows=[{Id:1,nameZh:'932'},{Id:1,nameZh:'932'},{Id:2,nameZh:'932副'}];assert.equal(normalizeRoutes(rows,'taipei').length,2);assert.equal(normalizeRoutes(rows,'taipei')[0].city,'taipei');assert.equal(normalizeRoutes(rows,'newtaipei',new Set(['1']))[0].nearby,true);});
test('route stops retain both directions in sequence and campus distance is explicit',()=>{const rows=[{Id:1,routeId:5,goBack:1,seqNo:9},{Id:2,routeId:5,goBack:0,seqNo:3},{Id:3,routeId:6,goBack:0,seqNo:1}];const s=normalizeStops(rows,'5');assert.deepEqual(s.map(v=>[v.id,v.direction]),[['2','0'],['1','1']]);assert.equal(isNearCampus({latitude:24.9468,longitude:121.372}),true);assert.equal(isNearCampus({latitude:25.04,longitude:121.53}),false);});
