import test from 'node:test';
import assert from 'node:assert/strict';
import { resizeCrop } from '../src/crop.js';
const bounds = { left: 0, top: 0, right: 1000, bottom: 800 };
const rect = { x: 100, y: 100, width: 400, height: 500 };
for (const corner of ['nw', 'ne', 'sw', 'se']) test(`${corner} independently resizes and anchors opposite corner`, () => {
  const next = resizeCrop(rect, corner, 40, 20, bounds);
  assert.equal(corner.includes('w') ? next.x + next.width : next.x, corner.includes('w') ? 500 : 100);
  assert.equal(corner.includes('n') ? next.y + next.height : next.y, corner.includes('n') ? 600 : 100);
  assert.equal(next.width, corner.includes('w') ? 360 : 440);
  assert.equal(next.height, corner.includes('n') ? 480 : 520);
});
test('allows narrow crops, clamps crossings and canvas edges', () => {
  assert.equal(resizeCrop(rect, 'se', -390, 0, bounds).width, 10);
  assert.deepEqual(resizeCrop(rect, 'nw', 1000, 1000, bounds), {x:492,y:592,width:8,height:8});
  assert.deepEqual(resizeCrop(rect, 'se', 1000, 1000, bounds), {x:100,y:100,width:900,height:700});
});
