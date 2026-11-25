import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPatterns, enteringAtStop, normalizeRoutes,parseFeedTime} from '../src/services/transitData.js';
import {corroborateFragments} from '../src/services/busEvidence.js';
import {sameBoardingStop} from '../src/services/recognitionContext.js';

test('921 opposite gates preserve each next stop and destination; a branch ends on its own sequence',()=>{
  const rows=[{Id:1,pathAttributeId:101,nameZh:'921',departureZh:'三峽',destinationZh:'捷運景安站'},
    {Id:1,pathAttributeId:102,nameZh:'921',pathAttributeName:'921區間'},
    {Id:2,pathAttributeId:201,nameZh:'941'}];
  const labels=['臺北大學正門','大學學成路口','捷運景安站','臺北大學正門','學勤路','三峽二站','區間終點'];
  const stops=labels.map((nameZh,i)=>({Id:i+1,routeId:1,goBack:i<3?0:1,nameZh,seqNo:i+1,stopLocationId:i<3?81:82}));
  stops.push({Id:91,routeId:2,goBack:0,nameZh:labels[0],seqNo:1,stopLocationId:82});
  const detail=(path,ids)=>ids.map((id,i)=>({PathAttributeId:path,StopId:id,SequenceNo:i+1}));
  const [main,branch,other]=buildPatterns(normalizeRoutes(rows,'newtaipei'),stops,
    [...detail(101,[1,2,3,4,5,6]),...detail(102,[4,7])]);
  const [out,back]=main.stops.filter(s=>s.name===labels[0]);
  assert.deepEqual([out.next,out.destination,back.next,back.destination],['大學學成路口','捷運景安站','學勤路','三峽']);
  assert.equal(branch.stops[0].destination,'區間終點');
  assert.equal(sameBoardingStop(stops[0],back,true),false);
  assert.equal(sameBoardingStop(stops.at(-1),back,true),true);
  assert.equal(other.route.name,'941');
});

test('only the last fresh per-vehicle entry on the exact branch, side and stop contributes',()=>{
  const timestamp='2026/11/25 12:00:00', now=parseFeedTime(timestamp);
  const row={DataTime:timestamp,BusID:'A',RouteID:123,GoBack:'1',StopID:52,CarOnStop:'1'};
  const services=[{name:'941',pathId:'123',direction:'1',stopId:'52'}];
  const entering=(rows,at=now,feed=now)=>enteringAtStop(rows,services,feed,at).map(e=>e.name);
  assert.deepEqual(entering([row]),['941']);
  for(const delta of [{CarOnStop:0},{GoBack:'0'},{RouteID:124},{StopID:53},{BusStatus:99}])
    assert.deepEqual(entering([{...row,...delta}]),[]);
  assert.deepEqual(entering([{...row,CarOnStop:0},row]),[]);
  assert.deepEqual(entering([row],now+45001),[]);
  assert.deepEqual(entering([row],now,now-121000),[]);
});

test('general mode requires fresh actual entry, a unique name and complementary frames from one bus',()=>{
  const ctx={routes:['941','932'],due:['941'],entering:[{name:'941',until:5000}],expires:6000};
  function run(parts,c=ctx,track={}){
    return parts.map((p,i)=>corroborateFragments(track,p,c,100+i*300,150+i*300)).at(-1);
  }
  assert.equal(run(['94','41']),'941');
  for(const inputs of [['1','1'],['94','94'],['94','','41'],['94','932','41']]) assert.equal(run(inputs),null);
  assert.equal(run(['94','41'],{...ctx,entering:[]}),null);
  assert.equal(run(['94','41'],{...ctx,routes:['941','941副']}),null);
  assert.equal(run(['94','41'],ctx,{crowded:true}),null);
});
