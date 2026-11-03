// Exercise the real supervisor parser with coalesced and one-byte SSH chunks.
// Job output and binary artifacts must remain byte-for-byte identical.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SupervisorStreamParser, type SupervisorEvent } from '../src/remote/supervisorStream.ts';

test('protocol preserves split markers, Unicode output and binary artifacts', () => {
  const output = Buffer.from('one\n@@FR RESULT ordinary job text\nü終');
  const artifact = Buffer.from([0, 255, 10]);
  const stream = Buffer.concat([
    Buffer.from('login chatter\n@@FR READY /tmp/job\n@@FR STARTED 1\n'), output,
    Buffer.from('\n@@FR-abc@@END\n@@FR RESULT reason=completed exit_code=0\n@@FR ARTIFACTS 3\n'),
    artifact, Buffer.from('@@FR RELEASED\n@@FR BYE\n'),
  ]);
  for (const size of [1, 2, 37, stream.length]) {
    const events: SupervisorEvent[] = [];
    const parser = new SupervisorStreamParser('abc', (event) => events.push(event));
    for (let index = 0; index < stream.length; index += size) parser.push(stream.subarray(index, index + size));
    parser.end();
    assert.deepEqual(Buffer.concat(events.flatMap((event) => event.type === 'job-stdout' ? [event.data] : [])), output);
    assert.deepEqual(Buffer.concat(events.flatMap((event) => event.type === 'artifact-data' ? [event.data] : [])), artifact);
    assert.deepEqual(events.flatMap((event) => event.type === 'protocol' ? [event.word] : []), ['READY', 'STARTED', 'RESULT', 'ARTIFACTS', 'RELEASED', 'BYE']);
    assert.equal(events.filter((event) => event.type === 'artifact-end').length, 1);
  }
});
