const fs = require('fs');
const path = require('path');
const util = require('util');
const { execFile } = require('child_process');

const execFileAsync = util.promisify(execFile);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function getVideoDuration(videoPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath
  ]);

  return parseFloat(stdout.trim());
}

async function extractFrames(videoPath, outputBaseDir) {
  const duration = await getVideoDuration(videoPath);

  const videoName = path.parse(videoPath).name;
  const outputDir = path.join(outputBaseDir, videoName);

  ensureDir(outputDir);

  // posições do vídeo (percentual)
  const positions = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85];

  const framePaths = [];

  for (let i = 0; i < positions.length; i++) {
    const time = duration * positions[i];
    const outputPath = path.join(outputDir, `frame-${i + 1}.jpg`);

    await execFileAsync('ffmpeg', [
      '-y',
      '-ss', String(time),
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '2',
      '-vf', 'scale=1280:-2',
      outputPath
    ]);

    if (fs.existsSync(outputPath)) {
      framePaths.push(outputPath);
    }
  }

  return framePaths;
}

module.exports = {
  extractFrames
};