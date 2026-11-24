import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
const out = path.resolve(value('--out', `test-results/platforms-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const report = { startedAt: new Date().toISOString(), platform: value('--platform', 'both'), steps: [], limits: ['編譯通過不代表實機相機、OCR、語音或辨識率已驗證。', 'iOS 真機測試需要已設定簽章及受信任的裝置。'] };
if (!['both', 'android', 'ios'].includes(report.platform)) throw new Error('--platform 必須是 both、android 或 ios');
await mkdir(out, { recursive: true });
async function step(name, command, commandArgs, { timeout = 600000, optional = false } = {}) {
  const started = Date.now();
  const log = path.join(out, `${String(report.steps.length + 1).padStart(2, '0')}-${name.replace(/[^a-z0-9-]/gi, '-')}.log`);
  let output = '';
  let code = -1;
  try {
    const child = spawn(command, commandArgs, { cwd: process.cwd(), env: process.env });
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`逾時 ${timeout}ms`)); }, timeout);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', exit => { clearTimeout(timer); resolve(exit ?? -1); });
    });
  } catch (error) { output += `\n${error.stack || error}\n`; }
  await writeFile(log, output);
  const item = { name, status: code === 0 ? 'pass' : optional ? 'skipped' : 'fail', durationMs: Date.now() - started, log: path.relative(out, log), tail: code === 0 ? '' : output.trim().split('\n').slice(-12).join('\n') };
  report.steps.push(item);
  console.log(`${item.status.toUpperCase()} ${name} (${item.durationMs}ms)`);
  return item.status === 'pass';
}
try {
  const unit = await step('unit-tests', 'npm', ['test']);
  const built = unit && await step('web-build', 'npm', ['run', 'build']);
  if (built && report.platform !== 'ios') {
    await step('android-sync', 'npx', ['cap', 'sync', 'android']);
    await step('android-compile', './android/gradlew', ['-p', 'android', 'assembleDebug'], { timeout: 900000 });
    if (has('--android-device')) await step('android-device', 'node', ['scripts/test-android-device.mjs', '--expect-auto-start', '--out', path.join(out, 'android-device'), ...(value('--serial', '') ? ['--serial', value('--serial', '')] : [])], { timeout: 900000 });
  }
  if (built && report.platform !== 'android') {
    await step('ios-sync', 'npx', ['cap', 'sync', 'ios'], { timeout: 900000 });
    await step('ios-simulator-compile', 'xcodebuild', ['-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', path.join(out, 'ios-derived'), 'CODE_SIGNING_ALLOWED=NO', 'build'], { timeout: 1200000 });
    if (has('--ios-device') && !value('--udid', '')) throw new Error('--ios-device 需要 --udid');
    if (has('--ios-device')) await step('ios-device-compile', 'xcodebuild', ['-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Debug', '-destination', `platform=iOS,id=${value('--udid', '')}`, '-derivedDataPath', path.join(out, 'ios-derived-device'), 'build'], { timeout: 1200000 });
  }
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = report.steps.every(s => s.status === 'pass');
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(out, 'report.md'), `# BusVision 測試摘要\n\n時間：${report.startedAt}\n平台：${report.platform}\n結果：${report.passed ? '通過' : '有失敗'}\n\n| 項目 | 結果 | 耗時 | 日誌 |\n| --- | --- | ---: | --- |\n${report.steps.map(s => `| ${s.name} | ${s.status} | ${(s.durationMs / 1000).toFixed(1)} 秒 | ${s.log} |`).join('\n')}\n\n## 失敗摘要\n\n${report.steps.filter(s => s.status === 'fail').map(s => `### ${s.name}\n\n\`\`\`text\n${s.tail}\n\`\`\``).join('\n\n') || '無'}\n\n## 限制\n\n${report.limits.map(x => `- ${x}`).join('\n')}\n`);
  console.log(`報告：${path.join(out, 'report.md')}`);
}
if (!report.passed) process.exitCode = 1;
