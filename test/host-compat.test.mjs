import test from 'node:test';
import assert from 'node:assert/strict';
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai';
import { profileDefaults, hostOptions } from '../lib/host-compat.js';

test('image limits follow the installed host and retries are resolved', () => {
  const expected = PiAiConfig({ providers: { minimax: {} } }).providers.get().minimax;
  const actual = profileDefaults();
  for (const key of ['maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes']) {
    assert.equal(actual[key], expected[key]);
    assert.ok(actual[key] > 0);
  }
  assert.equal(actual.retryPolicy.mode, 'normal');
  assert.ok(Number.isInteger(actual.retryPolicy.maxRetries));
});

test('host service changes are picked up at request time', () => {
  const ref = { attachmentId: 'fixture' };
  let attachments = { imageHostPath: value => value === ref ? 'C:/fixture.png' : undefined };
  let fs = { processPathFromHostPath: value => value === 'C:/fixture.png' ? '/fixture.png' : undefined };
  const options = hostOptions({ get: key => ({ attachments, fs })[key] });
  assert.equal(options.resolveAttachments(), attachments);
  assert.deepEqual(options.resolveImageAccess(attachments, ref), { readonlyPath: '/fixture.png' });
  fs = undefined;
  assert.equal(options.resolveImageAccess(attachments, ref), undefined);
  attachments = undefined;
  assert.equal(options.resolveAttachments(), undefined);
});

test('pi-ai cannot overwrite the MiniMax Code login or use unrelated ambient credentials', async () => {
  const { auth } = hostOptions({ get: () => undefined });
  assert.equal(await auth.credentials.read('minimax'), undefined);
  assert.deepEqual(await auth.credentials.list(), []);
  await assert.rejects(auth.credentials.modify('minimax', () => ({})), /MiniMax Code owns/);
  await assert.rejects(auth.credentials.delete('minimax'), /MiniMax Code owns/);
  assert.equal(await auth.authContext.env('ANTHROPIC_API_KEY'), undefined);
  assert.equal(await auth.authContext.fileExists('~/.unrelated-auth'), false);
});
