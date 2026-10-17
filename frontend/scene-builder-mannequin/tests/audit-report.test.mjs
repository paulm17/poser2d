import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const summary=JSON.parse(readFileSync(new URL('../docs/pose-audit/summary.json',import.meta.url)));
test('exhaustive pose audit covers the complete corpus and matches current evaluator/mapping sources',()=>{
 assert.equal(summary.pass,true);assert.equal(summary.records,12106);
 assert.equal(summary.gallery,254);assert.equal(summary.frames,11852);
 assert.equal(summary.jointsPerRecord,53);assert.equal(summary.sourceJointsPerRecord,47);
 assert.equal(summary.failures,0);assert.equal(summary.discontinuityFailures,0);
 for(const [path,hash]of Object.entries(summary.provenance)){
  const file=new URL('../scripts/'+path,import.meta.url);
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),hash,`${path} changed: rerun audit-poses.mjs`);
 }
 for(const key of ['rotationDegrees','segmentDirectionDegrees','palmAcrossDirectionDegrees','soleUpDirectionDegrees','stepRotationErrorDegrees'])assert.ok(summary.maximum[key].value<.001);
 for(const key of ['positionMetres','pelvisAnchorMetres','localPositionMetres'])assert.ok(summary.maximum[key].value<.00001);
});
