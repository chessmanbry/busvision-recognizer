import {test} from 'node:test';
import assert from 'node:assert/strict';
import {associate,observe} from '../src/services/busEvidence.js';
test('941 requires complementary evidence on one bus and fresh unique route context',()=>{
 const run=(parts,context)=>{const t={history:[]};return parts.map((v,i)=>observe(t,v,'941',context,i*400)).at(-1)};
 const ctx={routes:['941','932'],due:['941'],expires:4000};
 assert.equal(run(['1','1'],ctx),'candidate');
 assert.equal(run(['94','41'],ctx),'corroborated');
 assert.equal(run(['94','41'],{...ctx,expires:5}),'visual-only');
 assert.equal(run(['94','41'],{...ctx,routes:['941','941副']}),'ambiguous');
 assert.equal(run(['94','932','41'],ctx),'candidate');
 assert.equal(run(['941','941'],null),'visual-match');
});
test('crossing buses do not exchange evidence',()=>{
 const [bus]=associate([],[[0,0,100,100]],0);bus.history.push({token:'94',at:0});
 const tracks=associate([bus],[[5,0,100,100],[30,0,100,100]],200);
 assert.ok(tracks.every(t=>t.crowded && !t.history.length));
});
test('two separated buses retain independent readings even if detector order changes',()=>{
 const ctx={routes:['941','932'],due:['941','932'],expires:4000};
 let tracks=associate([],[[0,0,60,60],[200,0,60,60]],0);
 observe(tracks[0],'94','941',ctx,0);
 observe(tracks[1],'932','941',ctx,0);
 tracks=associate(tracks,[[196,0,60,60],[4,0,60,60]],450);
 assert.equal(observe(tracks[0],'41','941',ctx,450),'candidate');
 assert.equal(observe(tracks[1],'41','941',ctx,450),'corroborated');
});
test('941 approaching, but only 932 appears; the target never confirms',()=>{
 const t={history:[]}, ctx={routes:['941','932'],due:['941'],expires:4000};
 for(const [i,token] of ['1','932','932','1'].entries())
   assert.ok(!['visual-match','corroborated'].includes(observe(t,token,'941',ctx,i*500)));
});
test('weak full-sign reads require three separate frames; a different route resets them',()=>{
 const t={history:[]};
 const step=(text,at)=>observe(t,text,'208',null,at,true);
 assert.equal(step('208',1),'weak-full-read');assert.equal(step('208',300),'weak-full-read');
 assert.equal(step('605',400),'conflict');
 step('208',550);step('208',800);
 assert.equal(step('208',1100),'visual-match');
});
