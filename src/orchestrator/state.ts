/**
 * Run/gate state public facade.
 * Implementation is split by responsibility:
 * - stateTypes: public types, constants, errors
 * - stateTransitions: pure gate/run transitions and invariants
 * - statePersistence: state read/write/parse
 * - stateRunLockIdentity: stateDir O_NOFOLLOW pin / lstat / realpath / device-inode
 * - stateRunLockPathGuard: runDir/lock-leaf guards and ownership-safe cleanup
 * - stateRunLock: lock acquire, inherit, release, stale recovery
 */
export type {
  GateId,
  GateDecision,
  GateStatus,
  RunStatus,
  GateDecisionSource,
  GateState,
  RunState,
  RunLock,
  ExpectedStateDirIdentity,
  AcquireRunLockOptions,
  AcquireRunLockTestHooks
} from "./stateTypes.js";

export {
  RunLockBoundaryError,
  RunLockedError,
  RUN_LOCK_INHERIT_ENV,
  LAUNCHER_EXPECTED_APPROVAL_DIGEST_ENV
} from "./stateTypes.js";

export {
  createPlannedState,
  markGateAwaiting,
  recordGateDecision
} from "./stateTransitions.js";

export {
  writeState,
  readState
} from "./statePersistence.js";

export { acquireRunLock } from "./stateRunLock.js";
