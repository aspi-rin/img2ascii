const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    backgroundColor: '#0d1f2d',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  win.loadFile('src/index.html')
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Open image file dialog
ipcMain.handle('open-image', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Image',
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff'] }],
    properties: ['openFile'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  const data = fs.readFileSync(filePath)
  const ext = path.extname(filePath).slice(1).toLowerCase()
  const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', bmp: 'bmp', webp: 'webp', tiff: 'tiff' }
  const mime = mimeMap[ext] || 'png'
  return `data:image/${mime};base64,${data.toString('base64')}`
})

// Save TXT
ipcMain.handle('save-txt', async (_, text) => {
  const result = await dialog.showSaveDialog({
    title: 'Save ASCII Art as Text',
    defaultPath: 'ascii-art.txt',
    filters: [{ name: 'Text Files', extensions: ['txt'] }],
  })
  if (result.canceled || !result.filePath) return false
  fs.writeFileSync(result.filePath, text, 'utf8')
  return true
})

// Save PNG (receives base64 data URL from renderer canvas)
ipcMain.handle('save-png', async (_, dataUrl) => {
  const result = await dialog.showSaveDialog({
    title: 'Save ASCII Art as Image',
    defaultPath: 'ascii-art.png',
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  })
  if (result.canceled || !result.filePath) return false
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
  fs.writeFileSync(result.filePath, Buffer.from(base64, 'base64'))
  return true
})
