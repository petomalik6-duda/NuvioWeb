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

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? String(args[index + 1] || '') : '';
}

function hasArgValue(args, names, expected) {
  return names.some((name) => String(argValue(args, name)).toLowerCase() === String(expected).toLowerCase());
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
  const insertAt = insertAfterIndex >= 0 ? Math.min(output.length, insertAfterIndex + 1) : output.length;
  output.splice(insertAt, 0, preferredName, value);
  return output;
}

function isPrehrajtoProxyInput(args) {
  return args.some((arg) => /\/api\/media-proxy\/play\//i.test(String(arg || '')));
}

function isPrehrajtoSoftwareH264Transcode(args) {
  return (
    isPrehrajtoProxyInput(args) &&
    hasArgValue(args, ['-c:v', '-codec:v'], 'libx264')
  );
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
  patched = setOrInsertOption(patched, ['-threads'], '-threads', '2');

  console.log('[ffmpeg-copy-fix] Prehrajto H264 Safari output: yuv420p level 4.1 threads=2');
  return patched;
}

function patchPrehrajtoAudioResources(args) {
  if (!isPrehrajtoProxyInput(args)) return args;
  if (!hasArgValue(args, ['-c:a', '-codec:a'], 'aac')) return args;
  if (hasArgValue(args, ['-c:v', '-codec:v'], 'libx264')) return args;
  const patched = setOrInsertOption(args, ['-threads'], '-threads', '1');
  console.log('[ffmpeg-copy-fix] Prehrajto AAC audio threads=1');
  return patched;
}

function patchArgs(command, args) {
  if (!isFfmpegCommand(command) || !Array.isArray(args)) return args;

  let patchedArgs = patchPrehrajtoSafariH264(args);
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

// Ensure ESM named imports from node:child_process see the patched spawn exports.
syncBuiltinESMExports();
