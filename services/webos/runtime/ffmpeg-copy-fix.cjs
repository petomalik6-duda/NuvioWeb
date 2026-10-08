const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

const originalSpawnExport = childProcess.spawn;
const originalSpawnSyncExport = childProcess.spawnSync;
const originalChildSpawn = childProcess.ChildProcess.prototype.spawn;
let mediaRuntimeChild = null;

const mediaRuntimeLockPath = path.join(os.tmpdir(), 'nuvioweb-media-runtime.pid');
let ownsMediaRuntimeLock = false;

function isMediaRuntimePath(value) {
  return /(?:^|[\\/])services[\\/]webos[\\/]runtime[\\/]media-http\.cjs$/i.test(
    String(value || '')
  );
}

function isCurrentProcessMediaRuntime() {
  return process.argv.some((arg) => isMediaRuntimePath(arg));
}

function isPidAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLockedPid() {
  try {
    return Number(String(fs.readFileSync(mediaRuntimeLockPath, 'utf8') || '').trim());
  } catch (_) {
    return 0;
  }
}

function removeOwnedRuntimeLock() {
  if (!ownsMediaRuntimeLock) return;
  try {
    const lockedPid = readLockedPid();
    if (lockedPid === process.pid) {
      fs.unlinkSync(mediaRuntimeLockPath);
    }
  } catch (_) {
    // Best effort cleanup. A stale lock is detected on the next process start.
  }
  ownsMediaRuntimeLock = false;
}

function acquireMediaRuntimeLock() {
  if (!isCurrentProcessMediaRuntime()) return;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(mediaRuntimeLockPath, 'wx');
      try {
        fs.writeFileSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      ownsMediaRuntimeLock = true;
      console.log(`[media-runtime-lock] acquired pid=${process.pid}`);
      process.once('exit', removeOwnedRuntimeLock);
      process.once('SIGINT', () => {
        removeOwnedRuntimeLock();
        process.exit(130);
      });
      process.once('SIGTERM', () => {
        removeOwnedRuntimeLock();
        process.exit(143);
      });
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        console.warn(`[media-runtime-lock] lock error: ${error?.message || error}`);
        return;
      }

      const lockedPid = readLockedPid();
      if (lockedPid && lockedPid !== process.pid && isPidAlive(lockedPid)) {
        console.log(
          `[media-runtime-lock] duplicate runtime suppressed pid=${process.pid} owner=${lockedPid}`
        );
        process.exit(0);
      }

      try {
        fs.unlinkSync(mediaRuntimeLockPath);
      } catch (_) {
        // Retry once; if another process won the race it will be handled above.
      }
    }
  }

  console.warn('[media-runtime-lock] could not acquire runtime lock; exiting duplicate process');
  process.exit(0);
}

acquireMediaRuntimeLock();

function isFfmpegCommand(command) {
  const base = path.basename(String(command || '')).toLowerCase();
  return base === 'ffmpeg' || base === 'ffmpeg.exe';
}

function isMediaRuntimeLaunch(command, args) {
  const executable = path.basename(String(command || '')).toLowerCase();
  const isNode =
    executable === 'node' || executable === 'node.exe' || String(command || '') === process.execPath;
  if (!isNode || !Array.isArray(args)) return false;
  return args.some((arg) => isMediaRuntimePath(arg));
}

function hasLiveMediaRuntime() {
  return Boolean(
    mediaRuntimeChild &&
      mediaRuntimeChild.exitCode == null &&
      mediaRuntimeChild.signalCode == null &&
      !mediaRuntimeChild.killed
  );
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? String(args[index + 1] || '') : '';
}

function hasArgValue(args, names, expected) {
  return names.some(
    (name) => String(argValue(args, name)).toLowerCase() === String(expected).toLowerCase()
  );
}

function setOrInsertOption(args, names, preferredName, value, insertAfterIndex = -1) {
  const output = [...args];
  const nameSet = new Set(names);
  for (let i = 0; i < output.length - 1; i += 1) {
    if (nameSet.has(output[i])) {
      output[i + 1] = value;
      return output;
    }
  }
  const insertAt =
    insertAfterIndex >= 0 ? Math.min(output.length, insertAfterIndex + 1) : output.length;
  output.splice(insertAt, 0, preferredName, value);
  return output;
}

function isPrehrajtoProxyInput(args) {
  return args.some((arg) => /\/api\/media-proxy\/play\//i.test(String(arg || '')));
}

function isPrehrajtoSoftwareH264Transcode(args) {
  return isPrehrajtoProxyInput(args) && hasArgValue(args, ['-c:v', '-codec:v'], 'libx264');
}

function isPrehrajto4kDownscaleTranscode(args) {
  if (!isPrehrajtoSoftwareH264Transcode(args)) return false;
  const filter = argValue(args, '-vf');
  return /(?:^|,)scale=1920:-2(?=[:,]|$)/i.test(filter);
}

function patchPrehrajto4kHevcStreamCopy(args) {
  if (!isPrehrajto4kDownscaleTranscode(args)) return args;

  const dropValueOptions = new Set([
    '-vf',
    '-preset:v',
    '-profile:v',
    '-tune:v',
    '-level',
    '-level:v',
    '-vsync',
    '-r:v',
    '-sc_threshold',
    '-g',
    '-keyint_min',
    '-pix_fmt',
    '-b:v',
    '-maxrate',
    '-bufsize',
    '-force_key_frames',
    '-force_key_frames:v'
  ]);

  const patched = [];
  let insertedTag = false;
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (dropValueOptions.has(value)) {
      i += 1;
      continue;
    }
    if ((value === '-c:v' || value === '-codec:v') && i + 1 < args.length) {
      patched.push(value, 'copy');
      i += 1;
      if (!insertedTag) {
        patched.push('-tag:v', 'hvc1');
        insertedTag = true;
      }
      continue;
    }
    patched.push(value);
  }

  const lowMemory = setOrInsertOption(patched, ['-threads'], '-threads', '1');
  console.log('[ffmpeg-copy-fix] Prehrajto 4K HEVC low-memory stream-copy enabled (hvc1)');
  return lowMemory;
}

function patchPrehrajtoSafariH264(args) {
  if (!isPrehrajtoSoftwareH264Transcode(args)) return args;

  let patched = [...args];
  const codecIndex = patched.findIndex(
    (value, index) =>
      index < patched.length - 1 &&
      (value === '-c:v' || value === '-codec:v') &&
      String(patched[index + 1] || '').toLowerCase() === 'libx264'
  );

  patched = setOrInsertOption(
    patched,
    ['-pix_fmt'],
    '-pix_fmt',
    'yuv420p',
    codecIndex >= 0 ? codecIndex + 1 : -1
  );
  patched = setOrInsertOption(
    patched,
    ['-level', '-level:v'],
    '-level:v',
    '41',
    codecIndex >= 0 ? codecIndex + 1 : -1
  );
  patched = setOrInsertOption(patched, ['-threads'], '-threads', '1');

  console.log('[ffmpeg-copy-fix] Prehrajto H264 Safari output: yuv420p level 4.1 threads=1');
  return patched;
}

function patchPrehrajtoAudioResources(args) {
  if (!isPrehrajtoProxyInput(args)) return args;
  if (!hasArgValue(args, ['-c:a', '-codec:a'], 'aac')) return args;
  if (hasArgValue(args, ['-c:v', '-codec:v'], 'libx264')) return args;
  let patched = setOrInsertOption(args, ['-threads'], '-threads', '1');
  patched = setOrInsertOption(patched, ['-ac:a', '-ac'], '-ac:a', '2');
  console.log('[ffmpeg-copy-fix] Prehrajto AAC audio: stereo threads=1');
  return patched;
}

function patchArgs(command, args) {
  if (!isFfmpegCommand(command) || !Array.isArray(args)) return args;

  let patchedArgs = patchPrehrajto4kHevcStreamCopy(args);
  patchedArgs = patchPrehrajtoSafariH264(patchedArgs);
  patchedArgs = patchPrehrajtoAudioResources(patchedArgs);
  let usesVideoCopy = false;
  for (let i = 0; i < patchedArgs.length - 1; i += 1) {
    if (
      (patchedArgs[i] === '-c:v' || patchedArgs[i] === '-codec:v') &&
      String(patchedArgs[i + 1]).toLowerCase() === 'copy'
    ) {
      usesVideoCopy = true;
      break;
    }
  }
  if (!usesVideoCopy) return patchedArgs;

  const output = [];
  let changed = false;
  for (let i = 0; i < patchedArgs.length; i += 1) {
    if (patchedArgs[i] === '-force_key_frames:v' || patchedArgs[i] === '-force_key_frames') {
      i += 1;
      changed = true;
      continue;
    }
    output.push(patchedArgs[i]);
  }
  if (changed) {
    console.log('[ffmpeg-copy-fix] removed force_key_frames from stream-copy remux');
  }
  return output;
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

syncBuiltinESMExports();
