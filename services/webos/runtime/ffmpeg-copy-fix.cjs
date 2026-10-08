const childProcess = require('node:child_process');
const path = require('node:path');

const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;

function isFfmpegCommand(command) {
  const base = path.basename(String(command || '')).toLowerCase();
  return base === 'ffmpeg' || base === 'ffmpeg.exe';
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
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-force_key_frames:v' || args[i] === '-force_key_frames') {
      i += 1;
      continue;
    }
    patched.push(args[i]);
  }
  return patched;
}

childProcess.spawn = function patchedSpawn(command, args, options) {
  return originalSpawn.call(this, command, patchArgs(command, args), options);
};

childProcess.spawnSync = function patchedSpawnSync(command, args, options) {
  return originalSpawnSync.call(this, command, patchArgs(command, args), options);
};
