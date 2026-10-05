import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const REQUIRED = ['package/lib/index.js', 'package/lib/client.js', 'package/cordis.patch.yml',
  'package/lib/native/cpuse-windows.exe', 'package/lib/native/cpuse-windows.deps.json',
  'package/lib/native/cpuse-windows.runtimeconfig.json', 'package/lib/native/coreclr.dll',
  'package/lib/native/Microsoft.Windows.SDK.NET.dll'];

// Inspect the npm tarball without extracting or executing its contents.
export function inspectArchive(compressed) {
  const tar = gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 });
  if (tar.length < 1024 || tar.length % 512 !== 0) throw new Error('Truncated tar blocks');
  const files = new Map();
  let nextPath;
  let pendingPax = false;
  let terminated = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (pendingPax || offset + 1024 > tar.length || !tar.subarray(offset).every(byte => byte === 0)) throw new Error('Invalid tar end-of-archive blocks');
      terminated = true;
      break;
    }
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const octal = (start, length, label) => {
      const raw = header.subarray(start, start + length).toString('latin1');
      const match = /^ *([0-7]+)[\0 ]*$/.exec(raw);
      if (!match) throw new Error(`Invalid tar ${label} octal field`);
      const value = parseInt(match[1], 8);
      if (!Number.isSafeInteger(value)) throw new Error(`Invalid tar ${label} octal field`);
      return value;
    };
    const expectedChecksum = octal(148, 8, 'checksum');
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== expectedChecksum) throw new Error('Tar header checksum mismatch');
    const size = octal(124, 12, 'size');
    const nextOffset = offset + 512 + Math.ceil(size / 512) * 512;
    if (nextOffset > tar.length) throw new Error('Truncated tar entry blocks');
    const type = field(156, 1);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    const prefix = field(345, 155);
    const name = nextPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    nextPath = undefined;
    if (type === 'x') {
      if (pendingPax) throw new Error('Unapplied PAX header');
      pendingPax = true;
      let pos = 0;
      while (pos < body.length) {
        const space = body.indexOf(32, pos);
        const digits = space >= pos ? body.subarray(pos, space).toString('latin1') : '';
        const length = /^[1-9][0-9]*$/.test(digits) ? Number(digits) : NaN;
        if (space < pos || !Number.isSafeInteger(length) || length <= space - pos + 2 || pos + length > body.length || body[pos + length - 1] !== 10) throw new Error('Invalid PAX record');
        const record = body.subarray(space + 1, pos + length - 1).toString();
        if (!/^[^=\0\n]+=[^\0\n]*$/.test(record) || record.startsWith('size=') || record.startsWith('linkpath=')) throw new Error('Unsupported PAX record');
        if (record.startsWith('path=')) {
          if (nextPath !== undefined) throw new Error('Duplicate PAX path');
          nextPath = record.slice(5);
        }
        pos += length;
      }
    } else if (type === '' || type === '0') {
      pendingPax = false;
      if (!name.startsWith('package/') || name.includes('\\') || name.split('/').some(part => part === '..') || files.has(name)) throw new Error(`Unsafe or duplicate archive path: ${name}`);
      files.set(name, body);
    } else if (type === '5') pendingPax = false;
    else throw new Error(`Unsupported archive entry: ${name} (${type})`);
    offset = nextOffset;
  }
  if (!terminated) throw new Error('Missing tar end-of-archive blocks');
  for (const path of REQUIRED) if (!files.has(path)) throw new Error(`Release is missing prebuilt runtime: ${path}`);
  const manifest = JSON.parse(files.get('package/package.json')?.toString('utf8') ?? '{}');
  if (manifest.name !== 'dsh-plugin-cpuse' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version ?? '')) throw new Error('Unexpected npm package identity');
  const dependencies = [...Object.entries(manifest.dependencies ?? {}), ...Object.entries(manifest.peerDependencies ?? {})];
  const harness = dependencies.filter(([name]) => name.startsWith('@deepseek-ai/dsh-'));
  if (harness.length === 0 || harness.some(([, version]) => version !== '0.2.0-rc.2')) throw new Error('Release must target dsh 0.2.0-rc.2 exactly');
  for (const [name, version] of [['@deepseek-ai/cordis', '4.0.4'], ['@deepseek-ai/schemastery', '3.18.4']]) {
    const declarations = dependencies.filter(([dependency]) => dependency === name);
    if (declarations.length === 0 || declarations.some(([, declared]) => declared !== version)) throw new Error(`Release must target ${name} ${version} exactly`);
  }
  return { manifest, fileCount: files.size };
}

export async function hashFile(path) {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  let size = 0;
  for await (const bytes of createReadStream(path)) { size += bytes.length; sha256.update(bytes); sha512.update(bytes); }
  return { size, sha256: sha256.digest('hex'), integrity: `sha512-${sha512.digest('base64')}` };
}

export async function createReleaseManifest(path, repository = 'Arialnya/cpuse') {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  const { manifest, fileCount } = inspectArchive(await readFile(path));
  const asset = basename(path);
  if (asset !== `${manifest.name}-${manifest.version}.tgz`) throw new Error('Tarball filename must match its package version');
  return { schema: 1, name: manifest.name, version: manifest.version, harnessVersion: '0.2.0-rc.2',
    repository, tag: `v${manifest.version}`, asset,
    downloadUrl: `https://github.com/${repository}/releases/download/v${manifest.version}/${asset}`,
    ...await hashFile(path), fileCount };
}

async function main() {
  const [path, repository] = process.argv.slice(2);
  if (!path) throw new Error('Usage: node scripts/release-manifest.mjs <package.tgz> [owner/repository]');
  const absolute = resolve(path);
  const result = await createReleaseManifest(absolute, repository);
  await writeFile(`${absolute}.release.json`, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  await writeFile(`${absolute}.sha256`, `${result.sha256}  ${result.asset}\n`, { flag: 'wx' });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
