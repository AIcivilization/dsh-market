/** Copy dictionaries for the top-row update + restart controls. */

/**
 * Simplified Chinese dictionary and key source of truth.
 *
 * Keys are grouped by surface: `update*` (the update button and its popover),
 * `restart*` (the restart button), and `unavailable*` (why a control is
 * disabled). Every key here MUST have an English counterpart below.
 */
export const zh = {
  // --- Shared / generic ---
  badgeNew: '{count} 个可更新',
  checkedJustNow: '刚刚检查',
  checkedMinutesAgo: '{minutes} 分钟前检查',
  retry: '重试',
  dismiss: '关闭',

  // --- Update button ---
  updateLabel: '更新',
  updateAria: '检查并更新插件',
  updateIdle: '更新',
  updateChecking: '正在检查更新…',
  updateUpToDate: '已是最新版本',
  /* A finished check that could not examine everything. Kept distinct from
     `updateUpToDate` (which must only ever mean "examined, nothing to install")
     and from `updateChecking` (which must only ever mean "still running"). */
  updatePartialCheck: '已检查 {checked}/{total} 个，{failed} 个查询失败',
  updateCheckFailed: '检查失败，点击重试',
  updateNeverChecked: '尚未检查更新',
  updateAvailable: '发现 {count} 个插件可更新',
  updateRunning: '正在更新 {done}/{total}…',
  updateStarting: '正在开始更新…',
  updateDone: '已更新 {count} 个插件',
  updateDoneNoop: '没有需要更新的插件',
  updateFailed: '更新失败',
  updatePartial: '{ok} 个已更新，{failed} 个失败',
  updateRestartRequired: '更新完成，需要重启 DSH',
  updateNow: '立即更新',
  updateRetry: '重新检查',

  // --- Update popover ---
  panelTitle: '插件更新',
  panelUpToDate: '所有插件都是最新版本。',
  panelNoPlugins: '没有找到可更新的插件。',
  panelChecking: '正在检查已安装插件的更新…',
  panelFailed: '无法检查更新。',
  panelUpdating: '正在更新插件，请不要关闭此页面。',
  panelUpdatedAt: '{time} 更新',
  packageColumn: '插件',
  versionColumn: '版本',
  statusColumn: '状态',
  versionArrow: '{from} → {to}',
  statusPending: '等待中',
  statusRunning: '更新中',
  statusDone: '已更新',
  statusFailed: '失败',
  statusSkipped: '已跳过',

  // --- Restart button ---
  restartLabel: '重启 DSH',
  restartAria: '重启 DSH 服务',
  restartConfirmHint: '点击重启 DSH，页面将在服务恢复后自动刷新。',
  restartConfirmTitle: '重启 DSH？',
  restartConfirm: '重启',
  restartCancel: '取消',
  restartCheckingTasks: '正在检查有没有任务在跑…',
  restartTasksRunning: '⚠️ 有任务正在运行。现在重启会立即中断它们，未完成的工作会丢失。',
  restartNoTasks: '当前没有正在运行的任务。',
  restartTasksUnknown: '⚠️ 无法确认是否还有任务在运行，请自行确认后再重启。',
  restarting: '正在重启…',
  restartWaiting: '等待服务恢复…',
  restartReloading: '服务已恢复，正在刷新页面…',
  restartFailed: '重启失败',
  restartTimeout: '重启超时，请手动刷新页面。',

  // --- Disabled / unavailable reasons (graceful degradation) ---
  unsupportedHost: '当前 DSH 版本不支持此功能。',
  unsupportedUpdate: '当前 DSH 版本不支持插件更新。',
  unsupportedRestart: '当前 DSH 版本不支持重启。',
  hostUnreachable: '无法连接 DSH 服务。',
  // Desktop restart is normally available, so this only shows on a build where
  // the relaunch could not be set up. There is no one-click menu restart in the
  // packaged app — that item exists only in development builds — so the honest
  // instruction is to quit and reopen.
  desktopRestartUnsupported: '桌面版由应用外壳管理生命周期，请退出并重新打开 DSH 。',
  busyUpdate: '正在更新插件，请稍候。',
  busyRestart: 'DSH 正在重启。',
} satisfies Record<string, string>

/** Locale key union owned by this plugin. */
export type TopRowControlsLocaleKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  // --- Shared / generic ---
  badgeNew: '{count} update(s)',
  checkedJustNow: 'Checked just now',
  checkedMinutesAgo: 'Checked {minutes}m ago',
  retry: 'Retry',
  dismiss: 'Dismiss',

  // --- Update button ---
  updateLabel: 'Update',
  updateAria: 'Check for and install plugin updates',
  updateIdle: 'Update',
  updateChecking: 'Checking for updates…',
  updateUpToDate: 'Everything is up to date',
  updatePartialCheck: 'Checked {checked}/{total}: {failed} could not be queried',
  updateCheckFailed: 'Check failed — click to retry',
  updateNeverChecked: 'Not checked for updates yet',
  updateAvailable: '{count} plugin(s) can be updated',
  updateRunning: 'Updating {done}/{total}…',
  updateStarting: 'Starting update…',
  updateDone: 'Updated {count} plugin(s)',
  updateDoneNoop: 'Nothing needed updating',
  updateFailed: 'Update failed',
  updatePartial: '{ok} updated, {failed} failed',
  updateRestartRequired: 'Updated — restart DSH to apply',
  updateNow: 'Update now',
  updateRetry: 'Check again',

  // --- Update popover ---
  panelTitle: 'Plugin updates',
  panelUpToDate: 'All plugins are up to date.',
  panelNoPlugins: 'No updatable plugins were found.',
  panelChecking: 'Checking installed plugins for updates…',
  panelFailed: 'Could not check for updates.',
  panelUpdating: 'Updating plugins — please keep this page open.',
  panelUpdatedAt: 'Updated {time}',
  packageColumn: 'Plugin',
  versionColumn: 'Version',
  statusColumn: 'Status',
  versionArrow: '{from} → {to}',
  statusPending: 'Waiting',
  statusRunning: 'Updating',
  statusDone: 'Updated',
  statusFailed: 'Failed',
  statusSkipped: 'Skipped',

  // --- Restart button ---
  restartLabel: 'Restart DSH',
  restartAria: 'Restart the DSH server',
  restartConfirmHint: 'Restart DSH; this page reloads automatically once the server is back.',
  restartConfirmTitle: 'Restart DSH?',
  restartConfirm: 'Restart',
  restartCancel: 'Cancel',
  restartCheckingTasks: 'Checking for running tasks…',
  restartTasksRunning: '⚠️ Tasks are running. Restarting now interrupts them immediately and unfinished work is lost.',
  restartNoTasks: 'No tasks are running right now.',
  restartTasksUnknown: '⚠️ Could not confirm whether tasks are running. Check before restarting.',
  restarting: 'Restarting…',
  restartWaiting: 'Waiting for the server…',
  restartReloading: 'Server is back — reloading…',
  restartFailed: 'Restart failed',
  restartTimeout: 'Restart timed out. Please reload the page manually.',

  // --- Disabled / unavailable reasons (graceful degradation) ---
  unsupportedHost: 'This DSH version does not support this feature.',
  unsupportedUpdate: 'This DSH version does not support plugin updates.',
  unsupportedRestart: 'This DSH version does not support restarting.',
  hostUnreachable: 'Cannot reach the DSH server.',
  desktopRestartUnsupported: 'The desktop app owns this process — quit and reopen DSH.',
  busyUpdate: 'An update is already running.',
  busyRestart: 'DSH is restarting.',
} satisfies Record<TopRowControlsLocaleKey, string>
