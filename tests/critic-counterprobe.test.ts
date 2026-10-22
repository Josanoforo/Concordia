import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeCounterprobe } from '../src/critic/adversarial.ts';
import { encodeDecisionCsv } from '../src/decisions.ts';

const thresholds={criticOverlapFloor:0.8,criticLabelAgreementFloor:0.8};

test('bounded critic distinguishes duplicate keys, missing coverage and unavailable source',()=>{
  assert.equal(judgeCounterprobe({duplicateKeys:[{key:'1',rows:2}],seedKeys:1,matchedKeys:1,overlap:1},thresholds).status,'DEGRADED');
  assert.equal(judgeCounterprobe({seedKeys:2,matchedKeys:1,targetTruncated:true,overlap:0.5},thresholds).status,'INSUFFICIENT');
  assert.equal(judgeCounterprobe({seedKeys:1,matchedKeys:1,targetTruncated:true,overlap:1},thresholds).status,'CONFIRMED');
  assert.equal(judgeCounterprobe({seedKeys:1,matchedKeys:1,overlap:1,sourceError:{code:'HTTP_ERROR'}},thresholds).status,'INSUFFICIENT');
});

test('decision CSV quotes delimiters and line breaks without losing metadata',()=>{
  const serialized=encodeDecisionCsv(['entity','source'],[['zone:1','SEC_DATA,table\nrow']]);
  assert.equal(serialized,'"entity","source"\r\n"zone:1","SEC_DATA,table\nrow"\r\n');
});
