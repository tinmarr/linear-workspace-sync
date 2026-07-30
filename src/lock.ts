import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export type RunLock = {
  release(): void;
};

export function tryAcquireRunLock(path: string): RunLock | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existingPid = readExistingPid(path);
      if (existingPid === undefined || isProcessAlive(existingPid)) {
        return undefined;
      }
      unlinkSync(path);
      return tryAcquireRunLock(path);
    }
    throw error;
  }

  writeFileSync(descriptor, `${process.pid}\n`, "utf8");
  let released = false;
  return {
    release(): void {
      if (released) {
        return;
      }
      released = true;
      closeSync(descriptor);
      unlinkSync(path);
    },
  };
}

function readExistingPid(path: string): number | undefined {
  try {
    const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
