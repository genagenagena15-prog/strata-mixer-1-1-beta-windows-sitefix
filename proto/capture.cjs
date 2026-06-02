// Headless capture launcher: load CAP_URL, wait for @@DONE@@ in console, capturePage → CAP_OUT png, quit.
// Window is shown OFF-SCREEN (x=-3000) so WebGL actually renders but nothing flashes on the user's display.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
try { app.setPath('userData', path.join(os.tmpdir(), 'strata-cap-' + process.pid)); } catch (e) {}
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
const URL = process.env.CAP_URL;
const OUT = process.env.CAP_OUT;
app.whenReady().then(() => {
  const win = new BrowserWindow({
    x: 80, y: 80, width: 320, height: 540, show: true, frame: false, alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  let done = false;
  const grab = async () => {
    if (done) return; done = true;
    try { const img = await win.webContents.capturePage(); fs.writeFileSync(OUT, img.toPNG()); process.stdout.write('CAPTURED ' + OUT + '\n'); }
    catch (e) { process.stdout.write('CAPERR ' + e + '\n'); }
    app.quit();
  };
  win.webContents.on('console-message', (event, ...rest) => {
    // Electron changed this signature: old (event, level, message, ...) / new (event, {message,...}).
    let msg;
    if (rest.length === 1 && rest[0] && typeof rest[0] === 'object') msg = rest[0].message;
    else msg = rest[1];
    if (msg == null) return;
    process.stdout.write('[page] ' + msg + '\n');
    if (typeof msg === 'string' && msg.indexOf('@@DONE@@') === 0) setTimeout(grab, 250);
    if (typeof msg === 'string' && msg.indexOf('@@ERR@@') === 0) app.quit();
  });
  win.loadURL(URL);
  setTimeout(() => { if (!done) { process.stdout.write('TIMEOUT\n'); app.quit(); } }, 12000);
});
app.on('window-all-closed', () => app.quit());
