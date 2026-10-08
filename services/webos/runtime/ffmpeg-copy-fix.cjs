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

function removeOptionPair(args, names) {
  const nameSet = new Set(names);
  const output = [];
  for (let i = 0; i < args.length; i += 1) {
    if (nameSet.has(args[i])) {
      i += 1;
      continue;
    }
    output.push(args[i]);
  }
  return output;
}

function replaceOptionValue(args, names, value) {
  const nameSet = new Set(names);
  const output = [...args];
  for (let i = 0; i < output.length - 1; i += 1) {
    if (nameSet.has(output[i])) {
      output[i + 1] = value;
      return output;
    }
  }
  return output;
}

function isPrehrajtoProxyInput(args) {
  return args.some((arg) => /\/api\/media-proxy\/play\//i.test(String(arg || '')));
}

function looksLikePrehrajto4kSoftwareTranscode(args) {
  if (!isPrehrajtoProxyInput(args)) return false;
  if (!hasArgValue(args, ['-c:v', '-codec:v'], 'libx264')) return false;
  const filter = String(argValue(args, '-vf') || '');
  return /(?:^|,)scale=1920:-2(?::|,|$)/i.test(filter);
}

function patchPrehrajto4kVideoRemux(args) {
  if (!looksLikePrehrajto4kSoftwareTranscode(args)) return args;

  let patched = [...args];
  patched = removeOptionPair(patched, ['-vf']);
  patched = replaceOptionValue(patched, ['-c:v', '-codec:v'], 'copy');
  patched = removeOptionPair(patched, [
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
    '-force_key_frames:v',
    '-force_key_frames'
  ]);

  const codecIndex = patched.findIndex((value, index) =>
    index < patched.length - 1 &&
    (value === '-c:v' || value === '-codec:v') &&
    String(patched[index + 1] || '').toLowerCase() === 'copy'
  );
  if (codecIndex >= 0) {
    patched.splice(codecIndex + 2, 0, '-tag:v', 'hvc1');
  }

  console.log('[ffmpeg-copy-fix] Prehrajto 4K video remux enabled: HEVC copy + hvc1');
  return patched;
}

function patchArgs(command, args) {
  if (!isFfmpegCommand(command) || !Array.isArray(args)) return args;

  let patchedArgs = patchPrehrajto4kVideoRemux(args);
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
