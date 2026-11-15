import test from 'node:test';
import assert from 'node:assert/strict';
import { getOcrDimensions } from '../src/services/ocrSizing.js';
test('large and tall OCR crops respect the hard size cap', () => {
 assert.deepEqual(getOcrDimensions(1870,1689),{width:1280,height:1156});
 assert.deepEqual(getOcrDimensions(1614,1584),{width:1280,height:1256});
 assert.deepEqual(getOcrDimensions(100,4000),{width:32,height:1280});
});
test('small route crops preserve previous upscaling', () => {
 assert.deepEqual(getOcrDimensions(426,400),{width:852,height:800});
 assert.deepEqual(getOcrDimensions(600,100),{width:810,height:135});
 assert.throws(()=>getOcrDimensions(0,400));
});
