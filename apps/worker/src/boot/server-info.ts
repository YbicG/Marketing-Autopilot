import os from "node:os";

export interface ServerInfo {
  cpus: number;
  totalMemGb: number;
  freeMemGb: number;
  platform: string;
  node: string;
}

export function serverInfo(): ServerInfo {
  const gb = (n: number) => Math.round((n / 1024 ** 3) * 10) / 10;
  return {
    cpus: os.availableParallelism(),
    totalMemGb: gb(os.totalmem()),
    freeMemGb: gb(os.freemem()),
    platform: `${os.platform()}-${os.arch()}`,
    node: process.version,
  };
}
