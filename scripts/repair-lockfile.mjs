import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMap, parseDocument } from 'yaml';
import { createReleaseManifest } from './release-manifest.mjs';

export function addTargetIntegrity(text, url, integrity, packageName = 'dsh-plugin-cpuse') {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error('Lockfile is not unambiguous YAML');
  // Aliases/merge tricks are deliberately outside the supported repair shape.
  try { document.toJS({ maxAliasCount: 0 }); }
  catch { throw new Error('Lockfile aliases are not supported by this targeted repair'); }
  const packages = document.get('packages', true);
  if (!isMap(packages)) throw new Error('Lockfile has no packages mapping');
  const matches = packages.items.filter(pair => String(pair.key?.value) === `${packageName}@${url}`);
  if (matches.length !== 1 || !isMap(matches[0].value)) throw new Error('Expected exactly one target package resolution in the lockfile');
  const resolution = matches[0].value.get('resolution', true);
  if (!isMap(resolution) || resolution.get('tarball') !== url) throw new Error('Target resolution does not name the verified tarball URL');
  if (resolution.has('integrity')) {
    if (resolution.get('integrity') === integrity) return { text, changed: false };
    throw new Error('Target already has a different integrity; refusing to replace it');
  }
  const offset = resolution.range?.[0];
  if (!Number.isInteger(offset)) throw new Error('Target resolution has no source location');
  let insertion;
  let position = offset;
  if (resolution.flow) {
    if (text[offset] !== '{') throw new Error('Unsupported flow resolution');
    position += 1; insertion = `integrity: ${integrity}, `;
  } else {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const indent = text.slice(lineStart, offset);
    if (!/^ *$/.test(indent)) throw new Error('Unsupported block resolution indentation');
    insertion = `integrity: ${integrity}${text.includes('\r\n') ? '\r\n' : '\n'}${indent}`;
  }
  const result = text.slice(0, position) + insertion + text.slice(position);
  const checked = parseDocument(result);
  if (checked.errors.length || checked.getIn(['packages', `${packageName}@${url}`, 'resolution', 'integrity']) !== integrity) throw new Error('Repaired YAML validation failed');
  return { text: result, changed: true };
}

/** The caller must stop its DSH profile/package manager before --write. */
export async function repairLockfile({ lockfile, url, tarball, sha256, write = false }) {
  if (!lockfile || !url || !tarball || !/^[a-fA-F0-9]{64}$/.test(sha256 ?? '')) throw new Error('Supply --lockfile, --url, --tarball and a trusted --sha256');
  const path = resolve(lockfile);
  if (basename(path) !== 'pnpm-lock.yaml') throw new Error('The explicit target must be named pnpm-lock.yaml');
  const release = await createReleaseManifest(resolve(tarball));
  if (release.downloadUrl !== url) throw new Error('The tarball package/version does not match the target GitHub Release URL');
  if (release.sha256 !== sha256.toLowerCase()) throw new Error('Downloaded tarball does not match the trusted SHA-256; no lockfile changes made');
  const original = await readFile(path);
  const repaired = addTargetIntegrity(original.toString('utf8'), url, release.integrity);
  const result = { path, url, integrity: release.integrity, changed: repaired.changed, written: false };
  if (!write || !repaired.changed) return result;
  const guardPath = `${path}.cpuse-repair.lock`;
  const temporary = `${path}.cpuse-repair.${randomUUID()}.tmp`;
  const backup = `${path}.cpuse-backup.${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID()}.yaml`;
  const guard = await open(guardPath, 'wx');
  try {
    const same = async () => {
      const now = await readFile(path);
      if (!now.equals(original)) throw new Error('Lockfile changed concurrently; repair cancelled');
    };
    await same();
    const mode = (await stat(path)).mode;
    const saved = await open(backup, 'wx', mode);
    try { await saved.writeFile(original); await saved.sync(); } finally { await saved.close(); }
    const next = await open(temporary, 'wx', mode);
    try { await next.writeFile(repaired.text); await next.sync(); } finally { await next.close(); }
    await same();
    await rename(temporary, path);
    return { ...result, written: true, backup };
  } finally {
    await guard.close();
    await rm(guardPath, { force: true });
    await rm(temporary, { force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--write') { options.write = true; continue; }
    const key = { '--lockfile': 'lockfile', '--url': 'url', '--tarball': 'tarball', '--sha256': 'sha256' }[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Usage: node scripts/repair-lockfile.mjs --lockfile <path> --url <GitHub tgz URL> --tarball <downloaded tgz> --sha256 <trusted SHA-256> [--write]');
    options[key] = args[++index];
  }
  console.log(JSON.stringify(await repairLockfile(options), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
