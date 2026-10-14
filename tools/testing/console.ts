export const consoleOutput: string[] = [];

export function getConsoleOutput(): string[] {
  return consoleOutput.splice(0);
}
