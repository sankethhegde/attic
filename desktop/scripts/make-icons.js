// Renders the Attic mark (ui/assets/logo/attic-mark.svg) to PNG at each Windows icon size and packs
// them into build/icon.ico (PNG-compressed entries, valid since Windows Vista). Run: npm run icons
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const SVG = path.join(__dirname, '..', '..', 'ui', 'assets', 'logo', 'attic-mark.svg');
const OUT = path.join(__dirname, '..', 'build');

// Electron's network service can restart while the first page loads; one retry covers it.
async function render(win, size) {
  try { return await renderOnce(win, size); }
  catch (e) { return renderOnce(win, size); }
}

async function renderOnce(win, size) {
  const svg = fs.readFileSync(SVG, 'utf8').replace(/width="24" height="24"/, `width="${size}" height="${size}"`);
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 120));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.resize({ width: size, height: size }).toPNG();
}

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt16LE(1, o + 4);   // colour planes
    dir.writeUInt16LE(32, o + 6);  // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map(p => p.data)]);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true, zoomFactor: 1 } });
  const pngs = [];
  for (const size of SIZES) pngs.push({ size, data: await render(win, size) });
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(pngs));
  fs.writeFileSync(path.join(OUT, 'icon.png'), await render(win, 512));
  console.log('Wrote build/icon.ico (' + SIZES.join(', ') + ' px) and build/icon.png (512 px)');
  app.quit();
});
