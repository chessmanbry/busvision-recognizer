import test from 'node:test';
import assert from 'node:assert/strict';
import {findLedRegions} from '../src/services/ledRegions.js';
import {selectNativeRoute} from '../src/services/nativeRouteSelection.js';
test('side bus crop searches below the normal front-sign band',()=>{
 const W=200,H=120, pixels=new Uint8ClampedArray(W*H*4);
 for(let x=70;x<92;x+=7)for(let y=90;y<103;y++)for(let k=0;k<3;k++)pixels[(W*y+x+k)*4]=255;
 assert.equal(findLedRegions(pixels,W,H).length,0);
 assert.ok(findLedRegions(pixels,W,H,true).length);
 const line={text:'941',x:70,y:90,w:22,h:13,confidence:.9,source:'led-contrast'};
 assert.equal(selectNativeRoute([line],W,H,null).reliable,false);
 assert.equal(selectNativeRoute([line],W,H,null,true).reliable,true);
});
