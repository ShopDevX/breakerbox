import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, splitSegments, tokenize, detectLoop } from '../src/parse.js';

test('splits on every top-level separator', () => {
  const segs = splitSegments('a && b || c ; d | e');
  assert.deepEqual(segs, ['a', 'b', 'c', 'd', 'e']);
});

test('does not split inside quotes', () => {
  const segs = splitSegments(`echo "a && b" ; echo 'c ; d'`);
  assert.equal(segs.length, 2);
  assert.equal(segs[0], 'echo "a && b"');
});

test('does not split inside command substitution', () => {
  const segs = splitSegments('echo $(a && b) && c');
  assert.deepEqual(segs, ['echo $(a && b)', 'c']);
});

test('tokenize strips quotes and honours escapes', () => {
  assert.deepEqual(tokenize(`aws s3 cp "my file.txt" s3://b`), ['aws', 's3', 'cp', 'my file.txt', 's3://b']);
  assert.deepEqual(tokenize('a b\\ c'), ['a', 'b c']);
  assert.deepEqual(tokenize(`echo 'no \\escape here'`), ['echo', 'no \\escape here']);
});

test('strips env assignments and sudo so argv[0] is the binary', () => {
  const { invocations } = parseCommand('AWS_PROFILE=prod sudo aws ec2 run-instances');
  assert.equal(invocations[0].argv[0], 'aws');
});

test('counts a brace-range loop', () => {
  assert.equal(detectLoop(tokenize('for i in {1..50}')).iterations, 50);
  assert.equal(detectLoop(tokenize('for i in {0..100..5}')).iterations, 21);
});

test('counts a seq loop in all three forms', () => {
  assert.equal(detectLoop(tokenize('for i in $(seq 5)')).iterations, 5);
  assert.equal(detectLoop(tokenize('for i in $(seq 1 10)')).iterations, 10);
  assert.equal(detectLoop(tokenize('for i in $(seq 0 2 10)')).iterations, 6);
});

test('counts a literal word list', () => {
  assert.equal(detectLoop(tokenize('for r in us-east-1 eu-west-1 ap-south-1')).iterations, 3);
});

test('reports while-true as unbounded, not as one iteration', () => {
  assert.equal(detectLoop(tokenize('while true')).iterations, null);
});

test('attaches loop context to the body invocation', () => {
  const { invocations } = parseCommand('for i in {1..20}; do aws ec2 run-instances --instance-type t3.micro; done');
  const aws = invocations.find((i) => i.argv[0] === 'aws');
  assert.ok(aws, 'expected the aws invocation to be found');
  assert.equal(aws.loop.iterations, 20);
});

test('clears loop context after done', () => {
  const { invocations } = parseCommand('for i in {1..5}; do echo hi; done; aws ec2 run-instances');
  const aws = invocations.find((i) => i.argv[0] === 'aws');
  assert.equal(aws.loop, null);
});

test('multiplies nested loops', () => {
  const { invocations } = parseCommand(
    'for i in {1..3}; do for j in {1..4}; do aws ec2 run-instances; done; done',
  );
  const aws = invocations.find((i) => i.argv[0] === 'aws');
  assert.equal(aws.loop.iterations, 12);
});

test('sees commands hidden inside a substitution', () => {
  const { invocations } = parseCommand('ID=$(aws ec2 run-instances --instance-type t3.micro)');
  const aws = invocations.find((i) => i.argv[0] === 'aws' && i.substituted);
  assert.ok(aws, 'substituted aws invocation should be extracted');
});

test('recurses into subshells', () => {
  const { invocations } = parseCommand('(cd infra && terraform apply -auto-approve)');
  assert.ok(invocations.some((i) => i.argv[0] === 'terraform'));
});

test('handles empty and whitespace input without throwing', () => {
  assert.deepEqual(parseCommand('').invocations, []);
  assert.deepEqual(parseCommand('   \n  ').invocations, []);
  assert.deepEqual(parseCommand(null).invocations, []);
});
