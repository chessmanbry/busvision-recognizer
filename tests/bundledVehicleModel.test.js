import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
test('bundled vehicle weights match manifest and use Android-served binary extensions', () => {
 const root=new URL('../public/models/bus/',import.meta.url);
 const manifest=JSON.parse(readFileSync(new URL('model.json',root)));
 for(const group of manifest.weightsManifest){
  let size=0;
  for(const path of group.paths){assert.match(path,/\.bin$/);size+=statSync(new URL(path,root)).size;}
  const expected=group.weights.reduce((sum,w)=>sum+w.shape.reduce((a,b)=>a*b,1)*({float32:4,int32:4,bool:1,uint8:1,uint16:2}[w.quantization?.dtype||w.dtype]),0);
  assert.equal(size,expected);
 }
});
