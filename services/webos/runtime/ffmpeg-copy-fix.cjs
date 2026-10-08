const childProcess = require('node:child_process');

function normalizeArg(value) {
  return String(value ?? '').trim();
}

function hasVideoCopy(args) {
  if (!Array.isArray(args)) return false;
  for (let i = 0; i < args.length - 1; i += 1) {
    const flag = normalizeArg(args[i]);
    const value = normalizeArg(args[i + 1]).toLowerCase();
    if ((flag === '-c:v' || flag === '-codec:v' || flag === '-vcodec') && value === 'copy') {
      return true;
    }
  }
  return false;
}

function stripForceKeyFrames(args) {
  if (!Array.isArray(args) || !hasVideoCopy(args)) return args;
  const patched = [];
  for (let i = 0; i < args.length; i += 1) {
    const flag = normalizeArg(args[i]);
    if (flag === '-force_key_frames:v' || flag === '-force_key_frames') {
      i += 1;
      continue;
    }
    patched.push(args[i]);
  }
  return patched;
}

// Patch the low-level ChildProcess spawn method so this also covers callers
// that captured child_process.spawn/execFile before this preload ran, as well
// as wrapper libraries that ultimately create a ChildProcess instance.
const originalPrototypeSpawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function patchedPrototypeSpawn(options) {
  if (options && Array.isArray(options.args)) {
    const before = options.args;
    const after = stripForceKeyFrames(before);
    if (after !== before) {
      options = { ...options, args: after };
      if (process.env.NUVIO_HLS_DEBUG === '1') {
        console.info('[ffmpeg-copy-fix] removed force_key_frames from stream-copy command');
      }
    }
  }
  return originalPrototypeSpawn.call(this, options);
};

// Also patch direct exported helpers for completeness.
const originalSpawn = childProcess.spawn;
childProcess.spawn = function patchedSpawn(command, args, options) {
  return originalSpawn.call(this, command, stripForceKeyFrames(args), options);
};

const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function patchedSpawnSync(command, args, options) {
  return originalSpawnSync.call(this, command, stripForceKeyFrames(args), options);
};

const originalExecFile = childProcess.execFile;
childProcess.execFile = function patchedExecFile(file, args, options, callback) {
  if (typeof args === 'function') {
    return originalExecFile.call(this, file, args);
  }
  if (!Array.isArray(args)) {
    return originalExecFile.call(this, file, args, options);
  }
  return originalExecFile.call(this, file, stripForceKeyFrames(args), options, callback);
};

const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function patchedExecFileSync(file, args, options) {
  return originalExecFileSync.call(this, file, stripForceKeyFrames(args), options);
};
