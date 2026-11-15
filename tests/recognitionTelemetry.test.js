import test from 'node:test';
import assert from 'node:assert/strict';
import { recordRecognitionTelemetry, readRecognitionTelemetry } from '../src/services/recognitionTelemetry.js';
const memory = () => { let value; return { getItem: () => value, setItem: (_, v) => { value = v; } }; };
test('bounded telemetry includes failed attempts but excludes text and photos', () => {
 const storage = memory();
 for (let i=0;i<105;i++) recordRecognitionTelemetry({ outcome:'error',totalMs:i,raw:'PRIVATE',frame:'data:image/jpeg',route:'921',ocrMs:NaN },storage);
 const rows=readRecognitionTelemetry(storage);
 assert.equal(rows.length,100);assert.equal(rows[0].totalMs,5);assert.equal(rows[99].outcome,'error');
 assert.ok(rows.every(r=>!('raw' in r)&&!('frame' in r)&&!('route' in r)&&!('ocrMs' in r)));
});
test('corruption and unavailable storage do not interrupt recognition', () => {
 const broken={getItem:()=>'{',setItem:()=>{throw new Error('quota');}};
 assert.deepEqual(readRecognitionTelemetry(broken),[]);
 assert.doesNotThrow(()=>recordRecognitionTelemetry({totalMs:100},broken));
});
