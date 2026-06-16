import { exec } from "node:child_process";

export const isMtgaRunning = async (): Promise<boolean> =>
  new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq MTGA.exe"', (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      resolve(stdout.toLowerCase().includes("mtga.exe"));
    });
  });
