/**
 * Peer-range contract for the 0.2.1-rc.2 kernel.
 *
 *   node test/peer-ranges.mjs
 *
 * The plugin declares what it needs from the host as peer dependencies. Two
 * things about those ranges are worth keeping true, and neither is visible at
 * runtime — a wrong range still loads, it just misdeclares the contract:
 *
 *   1. every `@deepseek-ai/dsh-*` range admits the kernel this fork targets
 *     (0.2.1-rc.2) AND a later 0.2.x release, so the range stays wide instead
 *     of being narrowed to one exact kernel version;
 *   2. every peer range admits the version the host actually ships. DSH
 *     0.2.1-rc.2 runs pi-ai 1.x (and `dsh-llm-pi-ai@0.2.1-rc.2` itself
 *     requires `^1.1.0`), so a range that stops below 1.0.0 describes a
 *     dependency the host does not have.
 *
 * The host's own packages are read for the expected versions, so the test
 * follows the kernel instead of hardcoding a second copy of the truth.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const APP = '/Applications/DSH Desktop Beta.app/Contents/Resources/app/node_modules';
const REPO = new URL('..', import.meta.url).pathname;

const { satisfies } = await import(`${APP}/semver/index.js`);

const manifest = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'));
const peers = manifest.peerDependencies;

/** The kernel this fork is written against. */
const KERNEL = '0.2.1-rc.2';

/** Peers that ride the kernel's own 0.2.x version line. */
const kernelPeers = Object.entries(peers).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'));
assert.ok(kernelPeers.length > 0, 'the plugin must declare its kernel peers');

for (const [name, range] of kernelPeers) {
  assert.ok(
    satisfies(KERNEL, range, { includePrerelease: true }),
    `${name}@${range} must admit the kernel ${KERNEL}`,
  );
  assert.ok(
    satisfies('0.2.9', range, { includePrerelease: true }),
    `${name}@${range} must stay wide enough for a later 0.2.x kernel`,
  );
  assert.ok(
    !/^\s*[\^~=]?\s*0\.2\.1-rc\.2\s*$/.test(range),
    `${name}@${range} must not be narrowed to the exact kernel version`,
  );
  // No leftover hard reference to a pre-0.2 kernel or an alpha build.
  assert.ok(!/0\.1\./.test(range), `${name}@${range} still references a 0.1.x kernel`);
  assert.ok(!/alpha/i.test(range), `${name}@${range} still references an alpha build`);
}

// ---- the peers the host ships on their own version lines --------------------
// Every one of them must be admitted by the range the plugin declares.
const hostPeers = {
  '@deepseek-ai/cordis': ['@deepseek-ai', 'cordis'],
  '@deepseek-ai/schemastery': ['@deepseek-ai', 'schemastery'],
  'react': ['react'],
  '@earendil-works/pi-ai': ['@earendil-works', 'pi-ai'],
};

for (const [name, path] of Object.entries(hostPeers)) {
  const range = peers[name];
  assert.ok(range !== undefined, `the plugin must declare its ${name} peer`);
  const host = JSON.parse(await readFile(join(APP, ...path, 'package.json'), 'utf8'));
  assert.ok(
    satisfies(host.version, range, { includePrerelease: true }),
    `${name}@${range} must admit the version the host ships (${host.version})`,
  );
}

// pi-ai additionally has to admit the kernel adapter's own floor, because the
// adapter the plugin extends is built against that line.
const piAiRange = peers['@earendil-works/pi-ai'];
const kernelAdapter = JSON.parse(await readFile(join(APP, '@deepseek-ai', 'dsh-llm-pi-ai', 'package.json'), 'utf8'));
const kernelPiAi = kernelAdapter.dependencies?.['@earendil-works/pi-ai'];
assert.ok(kernelPiAi !== undefined, 'the kernel adapter must depend on pi-ai');
const kernelPiAiFloor = kernelPiAi.replace(/^[\^~>=<\s]*/, '');
assert.ok(
  satisfies(kernelPiAiFloor, piAiRange, { includePrerelease: true }),
  `pi-ai@${piAiRange} must admit the kernel adapter's own floor (${kernelPiAiFloor})`,
);

console.log('peer-ranges: OK', {
  kernel: KERNEL,
  kernelPeers: kernelPeers.length,
  piAi: `${piAiRange} (kernel floor ${kernelPiAiFloor})`,
});
