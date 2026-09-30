/**
 * Builds the Windows bundle into dist/ColonelTallyConnector/:
 *   ColonelTallyConnector.exe, Start-Connector.bat, Diagnose.bat, WINDOWS-TEST-HANDOFF.md
 * and zips it to dist/ColonelTallyConnector.zip (when `zip` is available).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'ColonelTallyConnector');
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// --no-bytecode / --public: ship plain JS instead of V8 bytecode. Bytecode compiled
// on the build machine (macOS arm64) is rejected by the Windows x64 V8 at startup
// ("V8 rejected the bytecode cache"), and the exe dies before any code runs.
execSync(`npx --yes @yao-pkg/pkg@6 . --targets node22-win-x64 --no-bytecode --public-packages "*" --public --output "${path.join(out, 'ColonelTallyConnector.exe')}"`,
  { cwd: root, stdio: 'inherit' });

for (const f of ['windows/Start-Connector.bat', 'windows/Diagnose.bat', 'WINDOWS-TEST-HANDOFF.md']) {
  fs.copyFileSync(path.join(root, f), path.join(out, path.basename(f)));
}

try {
  execSync('zip -qr ColonelTallyConnector.zip ColonelTallyConnector', { cwd: path.join(root, 'dist') });
  console.log(`Built ${path.join(root, 'dist', 'ColonelTallyConnector.zip')}`);
} catch (_) {
  console.log(`Built ${out} (zip not available — zip the folder by hand)`);
}
