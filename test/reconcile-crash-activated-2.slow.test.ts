// Disk-PGLite reconciliation survives SIGKILL at crash boundaries, activation=true, half 2 of the boundaries (test/helpers/reconcile-crash-cases.ts).
import { crashBoundaries, reconcileCrashTests } from './helpers/reconcile-crash-cases.ts';

reconcileCrashTests(true, crashBoundaries(2));
