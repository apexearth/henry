// What `@xterm/addon-serialize` is, as far as the daemon is concerned. screen.ts imports the
// package's ESM file directly and this declares it, so the package's own typings never load:
// those open with `import ... from '@xterm/xterm'`, whose declaration carries
// `/// <reference lib="dom"/>`, and skipLibCheck does not stop a lib reference. Pulling lib.dom
// into the daemon's program shadows Bun's ReadableStream with the DOM one, and every
// `for await (const chunk of proc.stdout)` in the tests stops compiling.
//
// A tsconfig `paths` entry is the obvious way to do this and the wrong one: Bun honours `paths`
// at *runtime* too, so the mapping sent the real import at this file and the daemon died on
// startup with "Export named 'SerializeAddon' not found".
declare module "@xterm/addon-serialize/lib/addon-serialize.mjs" {
  export class SerializeAddon {
    activate(terminal: unknown): void;
    /** Escape sequences that rebuild the terminal's state: scrollback, screen, cursor, modes. */
    serialize(options?: { scrollback?: number; excludeModes?: boolean; excludeAltBuffer?: boolean }): string;
    dispose(): void;
  }
}
