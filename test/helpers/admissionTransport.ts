// Extraction of existing AdmissionTransport from orderedMachines.test.ts.
// Controlled worker identity and admission responses for tests; the actual
// supervisor and receiver still execute unchanged in an isolated local home.
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import type { RemoteProcess } from '../../src/transport/transport.ts';
import { LocalShellTransport } from './localShellTransport.ts';

export class AdmissionTransport extends LocalShellTransport {
  admission: 'normal' | 'busy' | 'uncertain' = 'normal';
  admissions = 0;
  onBusy: (() => void) | undefined;
  fingerprint: string;
  diskFreeKiB: number | undefined;
  readonly preflightValues: Record<string, string> = { cpu_count: '10', load_average: '1 1 1',
    mem_available_bytes: '8589934592', mem_pressure_level: '1' };
  constructor(home: string) {
    super(home);
    this.fingerprint = createHash('sha256').update(home).digest('hex').slice(0, 16);
  }
  override start(command: string): RemoteProcess {
    if (command.includes('fleet-runner-supervisor')) {
      this.admissions += 1;
      if (this.admission === 'busy') {
        const process = super.start("printf '@@FR BUSY fixture\\n'");
        process.stdout.once('data', () => this.onBusy?.());
        return process;
      }
      if (this.admission === 'uncertain') return super.start("printf '@@FR ERROR fixture\\n'");
    }
    const process = super.start(command);
    if (!command.includes('fleet-runner-preflight')) return process;
    let output = '';
    const fingerprint = this.fingerprint;
    const diskFreeKiB = this.diskFreeKiB;
    const values = this.preflightValues;
    const stdout = process.stdout.pipe(new Transform({
      transform(chunk: Buffer, _encoding, callback) { output += chunk.toString('utf8'); callback(); },
      flush(callback) {
        output = output.replace(/^fingerprint=.*$/m, `fingerprint=${fingerprint}`);
        if (diskFreeKiB !== undefined) output = output.replace(/^disk_free_kb=.*$/m, `disk_free_kb=${diskFreeKiB}`);
        for (const [key, value] of Object.entries(values)) output = output.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
        this.push(output); callback();
      },
    }));
    return { ...process, stdout };
  }
}
