/**
 * Public host-side surface, re-exported for other code and for tests.
 *
 * The plugin's entry point is `src/index.ts`; this module exists so the
 * capabilities shape and route prefix can be imported without pulling in the
 * cordis context type, which is a peer dependency that may be absent on a
 * machine running only the host half's tests.
 */

export {
  ROUTE_PREFIX,
  CHECK_TTL_MS,
  createRoutes,
  type HostRoute,
  type RouteDeps,
} from './host/routes.js'

export {
  buildCapabilities,
  type Capabilities,
  type CapabilitiesInput,
  type CapabilitiesPayload,
} from './host/capabilities.js'

export {
  OperationStore,
  type Operation,
  type OperationPackage,
  type OperationState,
  type OperationView,
  type PackageState,
} from './host/operations.js'

export {
  checkUpdates,
  checkOne,
  isUpdatablePlugin,
  realDeps,
  type UpdateCheckDeps,
  type UpdateReason,
  type UpdateSource,
  type UpdateStatus,
  type UpdateSummary,
  type UpdatablePackage,
} from './host/updates.js'

export {
  applyUpdate,
  addArgs,
  deliveredUpdate,
  hasLoadableEntry,
  resolvePackageManager,
  runCommand,
  verifyAppliedVersion,
  workspaceArgs,
  type ApplyOutcome,
  type CommandResult,
  type PackageManagerInvocation,
  type UpdatePlan,
  type VersionFailureCode,
} from './host/apply.js'

export {
  argvProfile,
  hostPackageManagerOf,
  isDshProfileName,
  isGitSpec,
  isLocalSpec,
  isNpmSpec,
  readInstalledVersion,
  readManifest,
  resolveDshHome,
  resolveProfile,
  resolvedBundles,
  type HostPackageManager,
  type ProfileContextLike,
  type ResolvedProfile,
} from './host/profile.js'

export {
  compareVersions,
  isUpgrade,
  parseVersion,
  specFloor,
  type ParsedVersion,
} from './host/semver.js'

export {
  detectDebugger,
  detectDesktopRuntime,
  detectRuntime,
  detectSupervisor,
  restartCapability,
  type RestartCapability,
  type RestartManager,
  type Runtime,
} from './host/runtime.js'

export {
  nodeExecutable,
  respawnInvocation,
  restartHelperSource,
  restartLaunch,
  restartSupported,
  scheduleRestart,
  servingPort,
  type RestartResult,
} from './host/restart.js'

export {
  sameOriginMutation,
  sameOriginRead,
  loopbackAuthority,
  loopbackPeer,
  hasForwardingHeaders,
  readJsonBody,
  sendJson,
  MAX_BODY_BYTES,
} from './host/http.js'

export { fetchNpmLatest, resolveRegistry, resolveGitRemoteHead, gitUploadPackUrl, lockCommits } from './host/registry.js'

export { version, PACKAGE_NAME } from './host/version.js'
