import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/components/Recorder.jsx', import.meta.url), 'utf8');
const start = source.indexOf('  const runRecognition = ') + '  const runRecognition = '.length;
const fn = source.slice(start, source.indexOf('\n  const recognizeDataUrl', start)).trim().replace(/;$/, '');
async function scenario(firstRoute = '', matches = true) {
 let clock = 0; const calls=[], commits=[], attempts=[];
 const sandbox = {
  canUseNativeOcr:()=>false,readRecognitionContext:()=>matches?null:{name:'測試站',routes:['932']},routeMatchesContext:()=>matches,
  performance:{now:()=>clock}, RECOGNITION_BUDGET_MS:12000, VEHICLE_STAGE_BUDGET_MS:4000, OCR_TIMEOUT_MS:9000,
  reportStatus:()=>{},setStatus:()=>{},setEngineStatus:()=>{},setBusBox:()=>{},setCandidates:()=>{},setLastRoute:()=>{},setConfidence:()=>{},setRawText:()=>{},setLastCrop:()=>{},
  canvasFromDataUrl:async()=>({width:1600,height:900}), vehicleEnabledRef:{current:false},
  debugLog:()=>{},centerSearchCrop:()=>({}),cropCanvas:()=>({toDataURL:()=>''}),
  findDemoPanels:()=>Array.from({length:4},()=>({score:.5,kind:'paper'})),mapRect:r=>r,
  runOcr:async(_canvas,_label,budget)=>{
   calls.push(budget);
   const duration=firstRoute && calls.length===1 ? 100 : 5000;
   if (duration>budget || (firstRoute && calls.length>1)){clock+=budget;throw new Error('OCR timeout');}
   clock+=duration;return{text:firstRoute,confidence:40,setupMs:0,preprocessMs:0,engineMs:duration};
  },
  normalizeRouteText:s=>s,extractLiteralRouteText:()=>'',recognizeRedLedByShape:()=>'',inferRedLedRouteFromRaw:()=>'',
  summarizeText:s=>s,digitLikeCount:()=>0,isNoisyOcrRaw:()=>false,isReliableRoute:r=>!!r,pushDebug:()=>{},
  stableRef:{current:{route:'',count:0}},commitResult:async r=>commits.push(r),recordRecognitionTelemetry:r=>attempts.push(r),console,
 };
 await vm.runInNewContext(`(${fn})`,sandbox)('image','preview-ocr',null,()=>true);
 return {clock,calls,commits,attempts};
}
test('candidate OCR attempts share one budget instead of each receiving nine seconds', async()=>{
 const r=await scenario();assert.equal(r.clock,12000);assert.deepEqual(r.calls,[9000,7000,2000]);
 assert.equal(r.attempts[0].outcome,'budget-reached');assert.equal(r.commits[0].route,'');
});
test('later OCR timeout preserves an earlier reliable candidate',async()=>{
 const r=await scenario('932');assert.equal(r.commits[0].route,'932');assert.equal(r.attempts[0].outcome,'budget-reached');
});

test('station mismatch suppresses a visually accepted but unserved route without rewriting it',async()=>{const r=await scenario('332',false);assert.equal(r.commits[0].route,'');assert.equal(r.attempts[0].outcome,'station-mismatch');});
