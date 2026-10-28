/**
 * Where the warm CLI socket lives and the filesystem checks around it. The
 * socket is `$GBRAIN_HOME/.gbrain/run/cli.sock`: a Unix domain socket (never
 * TCP) in a directory that is 0700 and owned by the current user, the socket
 * itself 0600. Both the serve (before bind) and the CLI (before connect)
 * lstat the directory and the socket path, so a symlink, a foreign owner or
 * open permissions refuse instead of being followed or repaired. The
 * directories above it, GBRAIN_HOME and `.gbrain`, must be this user's and
 * writable by no one else (a sticky directory excepted), so nobody else can
 * swap a path component.
 */
import { chmodSync, lstatSync, mkdirSync, statSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from '../config.ts';
import { UNIX_SOCKET_PATH_MAX_BYTES } from '../context/ipc-path.ts';

export interface FsGuardDeps {
  lstat: (path: string) => Stats;
  uid: () => number | undefined;
  /** Follows symlinks; used for GBRAIN_HOME and `.gbrain`. Defaults to the real stat. */
  stat?: (path: string) => Stats;
}

const realDeps: FsGuardDeps = { lstat: path => lstatSync(path), stat: path => statSync(path), uid: () => process.getuid?.() };

export type UnsafeReason = 'missing' | 'symlink' | 'not_directory' | 'not_socket' | 'foreign_owner' | 'open_permissions' | 'no_uid';

export function cliSocketDir(home: string = configDir()): string {
  return join(home, 'run');
}

export function cliSocketPath(home: string = configDir()): string {
  return join(cliSocketDir(home), 'cli.sock');
}

/** AF_UNIX addresses are capped (104 bytes on darwin, the stricter of the two); a longer GBRAIN_HOME cannot host the socket. */
export function socketPathFits(path: string): boolean {
  return Buffer.byteLength(path) <= UNIX_SOCKET_PATH_MAX_BYTES;
}

function lstatOrNull(path: string, deps: FsGuardDeps): Stats | null {
  try { return deps.lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** null when `dir` is a real directory owned by this uid with no group or other access. */
export function privateDirProblem(dir: string, deps: FsGuardDeps = realDeps): UnsafeReason | null {
  const uid = deps.uid();
  if (uid === undefined) return 'no_uid';
  const st = lstatOrNull(dir, deps);
  if (!st) return 'missing';
  if (st.isSymbolicLink()) return 'symlink';
  if (!st.isDirectory()) return 'not_directory';
  if (st.uid !== uid) return 'foreign_owner';
  if ((st.mode & 0o077) !== 0) return 'open_permissions';
  return null;
}

/** null when `path` is a socket (not a symlink) owned by this uid with no group or other access. */
export function privateSocketProblem(path: string, deps: FsGuardDeps = realDeps): UnsafeReason | null {
  const uid = deps.uid();
  if (uid === undefined) return 'no_uid';
  const st = lstatOrNull(path, deps);
  if (!st) return 'missing';
  if (st.isSymbolicLink()) return 'symlink';
  if (!st.isSocket()) return 'not_socket';
  if (st.uid !== uid) return 'foreign_owner';
  if ((st.mode & 0o077) !== 0) return 'open_permissions';
  return null;
}

/** null when `dir` (symlinks followed) is a directory this uid owns with no group or other write bit, unless sticky. */
export function trustedAncestorProblem(dir: string, deps: FsGuardDeps = realDeps): UnsafeReason | null {
  const uid = deps.uid();
  if (uid === undefined) return 'no_uid';
  let st: Stats;
  try { st = (deps.stat ?? statSync)(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
  if (!st.isDirectory()) return 'not_directory';
  if (st.uid !== uid) return 'foreign_owner';
  if ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0) return 'open_permissions';
  return null;
}

/** GBRAIN_HOME and `.gbrain` above the run directory, outermost first, with the first that fails its check. */
export function ancestorProblem(dir: string, deps: FsGuardDeps = realDeps): { path: string; reason: UnsafeReason } | null {
  for (const ancestor of [dirname(dirname(dir)), dirname(dir)]) {
    const reason = trustedAncestorProblem(ancestor, deps);
    if (reason) return { path: ancestor, reason };
  }
  return null;
}

/** The CLI's pre-connect check: the directories above, the run directory and the socket must pass, or the CLI never connects. */
export function connectProblem(path: string, dir: string, deps: FsGuardDeps = realDeps): UnsafeReason | null {
  return ancestorProblem(dir, deps)?.reason ?? privateDirProblem(dir, deps) ?? privateSocketProblem(path, deps);
}

/**
 * Right after bind (the serve binds under umask 0177, so the kernel creates
 * the socket 0600): the path must already be a private socket this uid owns,
 * read with lstat and never repaired. Nothing is chmod'ed through a path that
 * could have been swapped. Returns its inode.
 */
export function verifyBoundSocket(path: string, deps: FsGuardDeps = realDeps): number {
  const problem = privateSocketProblem(path, deps);
  if (problem) throw new CliSocketUnsafeError(problem, path);
  return deps.lstat(path).ino;
}

export class CliSocketUnsafeError extends Error {
  constructor(public readonly reason: UnsafeReason, public readonly path: string) {
    super(`refusing the CLI socket: ${path} is unsafe (${reason})`);
    this.name = 'CliSocketUnsafeError';
  }
}

/**
 * The serve's pre-bind step: create the run directory 0700 when it is missing,
 * tighten one this uid already owns, and refuse a symlink, a non-directory, a
 * directory another uid owns, or a GBRAIN_HOME / `.gbrain` above it that is
 * not this user's or that others can write to (never repaired).
 */
export function ensurePrivateDir(dir: string, deps: FsGuardDeps = realDeps, fs: { mkdir: (path: string) => void; chmod: (path: string) => void } = {
  mkdir: path => mkdirSync(path, { recursive: true, mode: 0o700 }),
  chmod: path => chmodSync(path, 0o700),
}): void {
  const initial = privateDirProblem(dir, deps);
  if (initial && initial !== 'missing' && initial !== 'open_permissions') throw new CliSocketUnsafeError(initial, dir);
  if (initial === 'missing') fs.mkdir(dir);
  const above = ancestorProblem(dir, deps);
  if (above) throw new CliSocketUnsafeError(above.reason, above.path);
  let problem = privateDirProblem(dir, deps);
  if (problem === 'open_permissions') { fs.chmod(dir); problem = privateDirProblem(dir, deps); }
  if (problem) throw new CliSocketUnsafeError(problem, dir);
}
