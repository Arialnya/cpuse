import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { downloadRelease, releaseRequest, selectAsset } from '../scripts/download-release.mjs';
import { createReleaseManifest, inspectArchive } from '../scripts/release-manifest.mjs';
import { addTargetIntegrity, repairLockfile } from '../scripts/repair-lockfile.mjs';

const body = Buffer.from('verified release bytes');
const sha256 = createHash('sha256').update(body).digest('hex');
const request = releaseRequest('0.1.2');
const metadata = () => ({ tag_name: request.tag, draft: false, assets: [{ name: request.asset,
  browser_download_url: request.downloadUrl, size: body.length, digest: `sha256:${sha256}` }] });
function fetchFixture(release = metadata(), bytes = body) {
  return async url => url === request.apiUrl ? Response.json(release) : new Response(bytes);
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'cpuse-install-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('release downloads require pinned versions and unambiguous GitHub identities', () => {
  assert.equal(releaseRequest('v0.1.2').version, '0.1.2');
  for (const version of ['latest', '../v0.1.2', undefined, '0.1']) assert.throws(() => releaseRequest(version));
  assert.throws(() => releaseRequest('0.1.2', 'owner/repo/../other'));
  assert.throws(() => selectAsset({ ...metadata(), tag_name: 'v0.1.1' }, request));
  assert.throws(() => selectAsset({ ...metadata(), assets: [...metadata().assets, ...metadata().assets] }, request));
  const redirected = metadata(); redirected.assets[0].browser_download_url = 'https://other.example/package.tgz';
  assert.throws(() => selectAsset(redirected, request));
});

test('asset digest is mandatory and supplied checksums must agree with GitHub', () => {
  const missing = metadata(); delete missing.assets[0].digest;
  assert.throws(() => selectAsset(missing, request), /no GitHub SHA-256/);
  assert.equal(selectAsset(missing, request, sha256).sha256, sha256);
  assert.throws(() => selectAsset(metadata(), request, 'a'.repeat(64)), /disagrees/);
  assert.throws(() => selectAsset(missing, request, 'invalid'));
});

test('verified download produces identical bytes and no partial files', async t => {
  const outDir = await directory(t);
  const result = await downloadRelease({ version: request.version, outDir, fetcher: fetchFixture() });
  assert.deepEqual(await readFile(result.path), body);
  assert.equal(result.sha256, sha256);
  assert.deepEqual(await readdir(outDir), [request.asset]);
});

test('tampering and truncated downloads fail closed and discard partial files', async t => {
  const outDir = await directory(t);
  for (const bytes of [Buffer.alloc(body.length, 1), body.subarray(0, 5), Buffer.concat([body, body])]) {
    await assert.rejects(downloadRelease({ version: request.version, outDir, fetcher: fetchFixture(metadata(), bytes) }), /checksum|size|exceeds/);
    assert.deepEqual(await readdir(outDir), []);
  }
});

test('download never overwrites a prior package or starts a package manager', async t => {
  const outDir = await directory(t);
  const path = join(outDir, request.asset);
  await writeFile(path, 'existing download');
  await assert.rejects(downloadRelease({ version: request.version, outDir, fetcher: fetchFixture() }), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), 'existing download');
  assert.deepEqual(await readdir(outDir), [request.asset]);
});

test('GitHub API and asset HTTP failures produce actionable errors', async t => {
  const outDir = await directory(t);
  await assert.rejects(downloadRelease({ version: request.version, outDir, fetcher: async () => new Response('', { status: 404 }) }), /lookup failed: HTTP 404/);
  await assert.rejects(downloadRelease({ version: request.version, outDir, fetcher: async url => url === request.apiUrl ? Response.json(metadata()) : new Response('', { status: 503 }) }), /download failed: HTTP 503/);
  assert.deepEqual(await readdir(outDir), []);
});

const packageManifest = (overrides = {}) => ({ name: 'dsh-plugin-cpuse', version: '0.1.2',
  dependencies: { '@deepseek-ai/schemastery': '3.18.4' },
  peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.0-rc.2', '@deepseek-ai/cordis': '4.0.4' }, ...overrides });
function checksumHeader(header) {
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return header;
}
function tarEntry(name, content, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name); header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write(type, 156); header.write('ustar\0', 257);
  return Buffer.concat([checksumHeader(header), content, Buffer.alloc((512 - content.length % 512) % 512)]);
}
function archive(overrides = {}) {
  const entries = {
    'package/package.json': JSON.stringify(packageManifest()),
    'package/lib/index.js': '// compiled', 'package/lib/client.js': '// compiled', 'package/cordis.patch.yml': '- insert: []',
    'package/lib/native/cpuse-windows.exe': 'MZ', 'package/lib/native/cpuse-windows.deps.json': '{}',
    'package/lib/native/cpuse-windows.runtimeconfig.json': '{}', 'package/lib/native/coreclr.dll': 'MZ',
    'package/lib/native/Microsoft.Windows.SDK.NET.dll': 'MZ', ...overrides,
  };
  const chunks = [];
  for (const [name, value] of Object.entries(entries)) {
    if (value === null) continue;
    const content = Buffer.from(value);
    chunks.push(tarEntry(name, content));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

test('release packaging rejects source-only tarballs, unsafe paths and wrong Harness targets', () => {
  assert.equal(inspectArchive(archive()).manifest.version, '0.1.2');
  assert.throws(() => inspectArchive(archive({ 'package/lib/native/cpuse-windows.exe': null })), /missing prebuilt runtime/);
  assert.throws(() => inspectArchive(archive({ 'package/../escape': 'bad' })), /Unsafe/);
  assert.throws(() => inspectArchive(archive({ 'package/package.json': JSON.stringify({ name: 'dsh-plugin-cpuse', version: '0.1.2', dependencies: { '@deepseek-ai/dsh-tools': '^0.2' } }) })), /target dsh/);
});

test('release packaging rejects invalid header checksums and non-octal or truncated sizes', () => {
  const valid = gunzipSync(archive());
  const corruptHeader = Buffer.from(valid); corruptHeader[1] ^= 1;
  assert.throws(() => inspectArchive(gzipSync(corruptHeader)), /checksum mismatch/);
  for (const size of ['0000000019\0 ', '000000001x\0 ', '00001\0x0000\0', '\xB00000000000\0']) {
    const invalid = Buffer.from(valid); invalid.fill(0, 124, 136); invalid.write(size, 124, 'latin1');
    checksumHeader(invalid.subarray(0, 512));
    assert.throws(() => inspectArchive(gzipSync(invalid)), /size octal field/);
  }
  const tooLarge = Buffer.from(valid); tooLarge.write('77777777777\0', 124); checksumHeader(tooLarge.subarray(0, 512));
  assert.throws(() => inspectArchive(gzipSync(tooLarge)), /Truncated tar entry blocks/);
});

test('release packaging requires full blocks and two zero end blocks with no trailing data', () => {
  const valid = gunzipSync(archive());
  assert.throws(() => inspectArchive(gzipSync(valid.subarray(0, -1))), /Truncated tar blocks/);
  assert.throws(() => inspectArchive(gzipSync(valid.subarray(0, -1024))), /Missing tar end/);
  assert.throws(() => inspectArchive(gzipSync(valid.subarray(0, -512))), /Invalid tar end/);
  const trailing = Buffer.from(valid); trailing[trailing.length - 1] = 1;
  assert.throws(() => inspectArchive(gzipSync(trailing)), /Invalid tar end/);
});

test('PAX records require their complete decimal length and final newline', () => {
  const valid = gunzipSync(archive());
  const record = Buffer.from('22 comment=valid-pax\n');
  const pax = tarEntry('package/PaxHeader', record, 'x');
  // Build an exact self-inclusive length, as npm tar does.
  const value = 'comment=valid-pax\n';
  let length = value.length + 2;
  while (length !== `${length} ${value}`.length) length = `${length} ${value}`.length;
  const good = Buffer.from(`${length} ${value}`);
  assert.equal(inspectArchive(gzipSync(Buffer.concat([tarEntry('package/PaxHeader', good, 'x'), valid]))).fileCount, 9);
  const noNewline = Buffer.from(good); noNewline[noNewline.length - 1] = 32;
  assert.throws(() => inspectArchive(gzipSync(Buffer.concat([tarEntry('package/PaxHeader', noNewline, 'x'), valid]))), /Invalid PAX record/);
  const badLength = Buffer.from(good); badLength[0] = 120;
  assert.throws(() => inspectArchive(gzipSync(Buffer.concat([tarEntry('package/PaxHeader', badLength, 'x'), valid]))), /Invalid PAX record/);
  assert.throws(() => inspectArchive(gzipSync(Buffer.concat([pax, valid]))), /Invalid PAX record/);
});

test('release packaging pins Cordis and Schemastery without accepting shadowed ranges', () => {
  for (const override of [
    { peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.0-rc.2', '@deepseek-ai/cordis': '^4.0.4' } },
    { dependencies: { '@deepseek-ai/schemastery': '3.18.5' } },
    { dependencies: { '@deepseek-ai/schemastery': '3.18.4', '@deepseek-ai/cordis': '^4.0.4' } },
    { dependencies: {} },
  ]) assert.throws(() => inspectArchive(archive({ 'package/package.json': JSON.stringify(packageManifest(override)) })), /must target @deepseek-ai\/(cordis|schemastery)/);
});

test('release manifest pins the exact tarball URL, SHA-256 and SHA-512 integrity', async t => {
  const outDir = await directory(t);
  const path = join(outDir, request.asset);
  const bytes = archive();
  await writeFile(path, bytes);
  const result = await createReleaseManifest(path);
  assert.equal(result.downloadUrl, request.downloadUrl);
  assert.equal(result.harnessVersion, '0.2.0-rc.2');
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  assert.equal(result.size, bytes.length);
  assert.equal(result.fileCount, 9);
});

const lock = (resolution = `{tarball: ${request.downloadUrl}}`) => `# Preserve comments and other resolutions\nlockfileVersion: '9.0'\npackages:\n  other@1.0.0:\n    resolution: {integrity: sha512-preserved}\n  dsh-plugin-cpuse@${request.downloadUrl}:\n    resolution: ${resolution}\n    version: 0.1.2\n`;

test('targeted repair preserves all unrelated bytes, including comments and CRLF', () => {
  const integrity = 'sha512-trusted';
  for (const original of [lock(), lock().replaceAll('\n', '\r\n'), lock(`\n      tarball: ${request.downloadUrl}`)]) {
    const repaired = addTargetIntegrity(original, request.downloadUrl, integrity);
    assert.equal(repaired.changed, true);
    const removed = repaired.text.replace('integrity: sha512-trusted, ', '').replace(/integrity: sha512-trusted\r?\n      /, '');
    assert.equal(removed, original);
    assert.equal(addTargetIntegrity(repaired.text, request.downloadUrl, integrity).changed, false);
  }
});

test('repair refuses different recorded integrity, ambiguous YAML and a different target', () => {
  assert.throws(() => addTargetIntegrity(lock(`{tarball: ${request.downloadUrl}, integrity: sha512-other}`), request.downloadUrl, 'sha512-trusted'), /different integrity/);
  assert.throws(() => addTargetIntegrity(lock(), request.downloadUrl + '?different', 'sha512-trusted'), /exactly one/);
  assert.throws(() => addTargetIntegrity(lock(`{tarball: https://other.example/file.tgz}`), request.downloadUrl, 'sha512-trusted'), /verified tarball URL/);
  assert.throws(() => addTargetIntegrity(lock() + 'packages: {}\n', request.downloadUrl, 'sha512-trusted'), /unambiguous YAML/);
});

test('repair defaults to dry-run, requires trusted archive checksum and backs up exact original bytes before writing', async t => {
  const outDir = await directory(t);
  const tarball = join(outDir, request.asset);
  const lockfile = join(outDir, 'pnpm-lock.yaml');
  const bytes = archive();
  const trusted = createHash('sha256').update(bytes).digest('hex');
  const original = lock();
  await writeFile(tarball, bytes); await writeFile(lockfile, original);
  const options = { lockfile, tarball, url: request.downloadUrl, sha256: trusted };
  const preview = await repairLockfile(options);
  assert.equal(preview.changed, true); assert.equal(preview.written, false);
  assert.equal(await readFile(lockfile, 'utf8'), original);
  await assert.rejects(repairLockfile({ ...options, sha256: 'a'.repeat(64), write: true }), /trusted SHA-256/);
  assert.equal(await readFile(lockfile, 'utf8'), original);
  const fixed = await repairLockfile({ ...options, write: true });
  assert.equal(fixed.written, true);
  assert.equal(await readFile(fixed.backup, 'utf8'), original);
  assert.match(await readFile(lockfile, 'utf8'), /resolution: \{integrity: sha512-/);
  assert.equal((await repairLockfile({ ...options, write: true })).written, false);
  assert.equal((await readdir(outDir)).filter(name => name.includes('.cpuse-backup.')).length, 1);
});

test('repair refuses a concurrent repair guard and does not alter lockfile', async t => {
  const outDir = await directory(t);
  const tarball = join(outDir, request.asset);
  const lockfile = join(outDir, 'pnpm-lock.yaml');
  const bytes = archive();
  await writeFile(tarball, bytes); await writeFile(lockfile, lock());
  await writeFile(`${lockfile}.cpuse-repair.lock`, 'another repair');
  await assert.rejects(repairLockfile({ lockfile, tarball, url: request.downloadUrl, sha256: createHash('sha256').update(bytes).digest('hex'), write: true }), { code: 'EEXIST' });
  assert.equal(await readFile(lockfile, 'utf8'), lock());
  assert.equal(await readFile(`${lockfile}.cpuse-repair.lock`, 'utf8'), 'another repair');
});
