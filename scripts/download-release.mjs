import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { link, mkdir, mkdtemp, open, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

export function releaseRequest(version, repository = 'Arialnya/cpuse') {
  version = version?.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? '')) throw new Error('Specify an exact release version, for example --version 0.1.1');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  const asset = `dsh-plugin-cpuse-${version}.tgz`;
  return { version, repository, tag: `v${version}`, asset,
    apiUrl: `https://api.github.com/repos/${repository}/releases/tags/v${version}`,
    downloadUrl: `https://github.com/${repository}/releases/download/v${version}/${asset}` };
}

export function selectAsset(release, request, suppliedSha256) {
  if (release.tag_name !== request.tag || release.draft) throw new Error('GitHub returned a different release or a draft');
  const assets = (release.assets ?? []).filter(asset => asset.name === request.asset);
  if (assets.length !== 1 || assets[0].browser_download_url !== request.downloadUrl) throw new Error('Release does not contain the expected package asset');
  const asset = assets[0];
  const digest = suppliedSha256?.toLowerCase() ?? asset.digest?.match(/^sha256:([a-fA-F0-9]{64})$/)?.[1]?.toLowerCase();
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('This asset has no GitHub SHA-256 digest. Supply --sha256 from a trusted release checksum; do not skip verification.');
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 256 * 1024 * 1024) throw new Error('Unexpected release asset size');
  if (suppliedSha256 && asset.digest?.startsWith('sha256:') && asset.digest.slice(7).toLowerCase() !== digest) throw new Error('Supplied checksum disagrees with the GitHub asset digest');
  return { ...asset, sha256: digest };
}

// Windows PowerShell uses the Windows HTTPS/proxy settings, unlike Node's bare fetch.
// JSON is passed over stdin; user-supplied paths are never interpolated into shell code.
const WINDOWS_REQUEST = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=New-Object Text.UTF8Encoding($false); [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $r=[Console]::In.ReadToEnd()|ConvertFrom-Json; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; if($r.kind -eq 'json'){ $v=Invoke-RestMethod -Uri $r.url -Headers @{'User-Agent'='cpuse-verified-release-download';'Accept'='application/vnd.github+json'} -TimeoutSec 30; [Console]::Out.Write(($v|ConvertTo-Json -Depth 20 -Compress)) }else{ Invoke-WebRequest -UseBasicParsing -Uri $r.url -OutFile $r.path -TimeoutSec 180; [Console]::Out.Write('{}') }`;
function windowsRequest(data, signal) {
  return new Promise((resolveRequest, reject) => {
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_REQUEST], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal });
    const chunks = [];
    let length = 0;
    let failure;
    child.stdout.on('data', bytes => { length += bytes.length; if (length > 512 * 1024) child.kill(); else chunks.push(bytes); });
    child.stderr.resume();
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      if (failure) { reject(failure); return; }
      if (code !== 0 || length > 512 * 1024) { reject(new Error(`Windows HTTPS request failed (exit ${code}); check GitHub access and system proxy settings`)); return; }
      try { resolveRequest(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid GitHub API response')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(data));
  });
}
export async function windowsFetcher(url, options) {
  if (options.headers?.accept) {
    const value = await windowsRequest({ kind: 'json', url }, options.signal);
    return { ok: true, status: 200, json: async () => value };
  }
  const temporary = await mkdtemp(join(tmpdir(), 'cpuse-release-transfer-'));
  const path = join(temporary, 'asset.tgz');
  const cleanup = async () => {
    await rm(path, { force: true });
    // Delete only this known asset and its empty generated directory. Preserve unexpected files.
    try { await rmdir(temporary); } catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error; }
  };
  try { await windowsRequest({ kind: 'file', url, path }, options.signal); }
  catch (error) { await cleanup(); throw error; }
  return { ok: true, status: 200, body: (async function* () {
    try { yield* createReadStream(path); }
    finally { await cleanup(); }
  })() };
}

/** Download only: never edit a DSH profile or execute downloaded package code. */
export async function downloadRelease({ version, repository, outDir, sha256, fetcher = process.platform === 'win32' ? windowsFetcher : fetch }) {
  const request = releaseRequest(version, repository);
  const headers = { 'user-agent': 'cpuse-verified-release-download', accept: 'application/vnd.github+json' };
  const api = await fetcher(request.apiUrl, { headers, signal: AbortSignal.timeout(30_000) });
  if (!api.ok) throw new Error(`GitHub release lookup failed: HTTP ${api.status}`);
  const asset = selectAsset(await api.json(), request, sha256);
  const output = resolve(outDir ?? './cpuse-downloads');
  await mkdir(output, { recursive: true });
  const destination = join(output, request.asset);
  const temporary = `${destination}.${process.pid}.${Date.now()}.part`;
  let handle;
  try {
    const response = await fetcher(request.downloadUrl, { headers: { 'user-agent': headers['user-agent'] }, signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`GitHub package download failed: HTTP ${response.status}`);
    const digest = createHash('sha256');
    let size = 0;
    handle = await open(temporary, 'wx');
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > asset.size) throw new Error('Downloaded package exceeds its declared size');
      digest.update(chunk);
      await handle.writeFile(chunk);
    }
    await handle.close(); handle = undefined;
    if (size !== asset.size || !timingSafeEqual(digest.digest(), Buffer.from(asset.sha256, 'hex'))) throw new Error('Release checksum or size mismatch; installation stopped');
    // Refuse to overwrite another download. A verified package can then be retained for reinstall.
    await link(temporary, destination);
    return { path: destination, version: request.version, sha256: asset.sha256, size };
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--version': 'version', '--repository': 'repository', '--out-dir': 'outDir', '--sha256': 'sha256' }[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Usage: node scripts/download-release.mjs --version <version> [--out-dir <directory>] [--sha256 <trusted checksum>]');
    options[key] = args[index + 1];
  }
  const result = await downloadRelease(options);
  console.log(`Verified SHA-256: ${result.sha256}\nPaste this absolute path into DSH Plugins → Install:\n${result.path}\nKeep this file while the profile refers to it.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
