import test from 'node:test';
import assert from 'node:assert/strict';
import {runNativePipeline} from '../src/services/nativeRecognitionPipeline.js';
import {findLedRegions} from '../src/services/ledRegions.js';
const good={width:1000,height:1000,engine:'test',lines:[{text:'208',x:100,y:100,w:150,h:60,confidence:.9}]};
test('clear native reading completes in one call without browser preprocessing',async()=>{
 let calls=0;const result=await runNativePipeline('image',{recognize:async()=>{calls++;return good},context:null,isCurrent:()=>true});
 assert.equal(result.selection.best.route,'208');assert.equal(result.selection.reliable,true);assert.equal(calls,1);
});
test('native timeout and cancellation cannot commit stale OCR results',async()=>{
 await assert.rejects(runNativePipeline('image',{recognize:()=>new Promise(()=>{}),isCurrent:()=>true,budgetMs:10}),/time budget/);
 let current=true;await assert.rejects(runNativePipeline('image',{recognize:async()=>{current=false;return good},isCurrent:()=>current}),/cancelled/);
});
test('blank frames and broad solid red bodywork do not produce LED regions',()=>{
 const w=240,h=320,d=new Uint8ClampedArray(w*h*4);assert.deepEqual(findLedRegions(d,w,h),[]);
 for(let y=20;y<170;y++)for(let x=10;x<220;x++){const i=(y*w+x)*4;d[i]=220;d[i+1]=30;d[i+2]=25;d[i+3]=255;}
 assert.deepEqual(findLedRegions(d,w,h),[]);
});
