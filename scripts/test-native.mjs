import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const executable = fileURLToPath(new URL('../lib/native/cpuse-windows.exe', import.meta.url));
const args = [process.argv.includes('--desktop') ? '--integration-test' : '--self-test'];
const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
