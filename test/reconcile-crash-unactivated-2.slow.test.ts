// Disk-PGLite reconciliation survives SIGKILL at crash boundaries, activation=false, half 2 of the boundaries (test/helpers/reconcile-crash-cases.ts).
import { crashBoundaries, reconcileCrashTests } from './helpers/reconcile-crash-cases.ts';

reconcileCrashTests(false, crashBoundaries(2));
