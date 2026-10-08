const childProcess = require('node:child_process');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

const originalSpawnExport = childProcess.spawn;
const originalSpawnSyncExport = childProcess.spawnSync;
const originalChildSpawn = childProcess.ChildProcess.prototype.spawn;
let mediaRuntimeChild = null;

function isFfmpegCommand(command) {
  const base = path.basename(String(command || '')).toLowerCase();
  return base === 'ffmpeg' || base === 'ffmpeg.exe';
}

function isMediaRuntimeLaunch(command, args) {
  const executable = path.basename(String(command || '')).toLowerCase();
  const isNode = executable === 'node' || executable === 'node.exe' || String(command || '') === process.execPath;
  if (!isNode || !Array.isArray(args)) return false;
  return args.some((arg) => /(?:^|[\\/])services[\\/]webos[\\/]runtime[\\/]media-http\.cjs$/i.test(String(arg || '')));
}

function hasLiveMediaRuntime() {
  return Boolean(
    mediaRuntimeChild &&
    mediaRuntimeChild.exitCode == null &&
    mediaRuntimeChild.signalCode == null &&
    !mediaRuntimeChild.killed
  );
}

function patchArgs(command, args) {
  if (!isFfmpegCommand(command) || !Array.isArray(args)) return args;

  let usesVideoCopy = false;
  for (let i = 0; i < args.length - 1; i += 1) {
    if ((args[i] === '-c:v' || args[i] === '-codec:v') && String(args[i + 1]).toLowerCase() === 'copy') {
      usesVideoCopy = true;
      break;
    }
  }
  if (!usesVideoCopy) return args;

  const patched = [];
  let changed = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-force_key_frames:v' || args[i] === '-force_key_frames') {
      i += 1;
      changed = true;
      continue;
    }
    patched.push(args[i]);
  }
  if (changed) {
    console.log('[ffmpeg-copy-fix] removed force_key_frames from stream-copy remux');
  }
  return patched;
}

childProcess.spawn = function patchedSpawn(command, args, options) {
  if (isMediaRuntimeLaunch(command, args) && hasLiveMediaRuntime()) {
    console.log('[media-runtime-lock] reusing existing media runtime process');
    return mediaRuntimeChild;
  }
  const child = originalSpawnExport.call(this, command, patchArgs(command, args), options);
  if (isMediaRuntimeLaunch(command, args)) {
    mediaRuntimeChild = child;
    child.once('exit', () => {
      if (mediaRuntimeChild === child) mediaRuntimeChild = null;
    });
  }
  return child;
};

childProcess.spawnSync = function patchedSpawnSync(command, args, options) {
  return originalSpawnSyncExport.call(this, command, patchArgs(command, args), options);
};

childProcess.ChildProcess.prototype.spawn = function patchedChildSpawn(options) {
  if (options && Array.isArray(options.args) && options.args.length) {
    const command = options.args[0];
    const args = options.args.slice(1);
    const patchedArgs = patchArgs(command, args);
    if (patchedArgs !== args) {
      options = { ...options, args: [command, ...patchedArgs] };
    }
  }
  return originalChildSpawn.call(this, options);
};

// Ensure ESM named imports from node:child_process see the patched spawn exports.
syncBuiltinESMExports();
