// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  imageData: null,
  imgW: 0,
  imgH: 0,
  cols: 100,
  contrastExp: 2.5,
  invert: false,
  charSetKey: 'all',
  fontSize: 11,
  fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
  asciiText: '',
  busy: false,
  pendingRender: false,
}

// ---------------------------------------------------------------------------
// Web Worker — handles all heavy ASCII computation off the main thread
// ---------------------------------------------------------------------------
const worker = new Worker('worker.js')
let renderSeq = 0

worker.onmessage = ({ data }) => {
  if (data.id !== renderSeq) return  // stale result from a superseded render
  state.asciiText = data.text
  state.busy = false
  asciiOutput.textContent = data.text
  statusMsg.textContent =
    `${data.imgW}×${data.imgH}px · ${data.cols}列 × ${data.rows}行 · ${data.ms}ms`
  if (state.pendingRender) {
    state.pendingRender = false
    scheduleRender(false)
  }
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const dropZone       = document.getElementById('drop-zone')
const fileInput      = document.getElementById('file-input')
const asciiOutput    = document.getElementById('ascii-output')
const colsSlider     = document.getElementById('cols-slider')
const colsValue      = document.getElementById('cols-value')
const contrastSlider = document.getElementById('contrast-slider')
const contrastValue  = document.getElementById('contrast-value')
const invertToggle   = document.getElementById('invert-toggle')
const charSetSelect  = document.getElementById('charset-select')
const saveTxtBtn     = document.getElementById('save-txt-btn')
const savePngBtn     = document.getElementById('save-png-btn')
const statusMsg      = document.getElementById('status-msg')
const splitLeft      = document.getElementById('split-left')
const splitRight     = document.getElementById('split-right')
const divider        = document.getElementById('divider')
const fontSizeSlider = document.getElementById('font-size-slider')
const fontSizeValue  = document.getElementById('font-size-value')
const colorSwatches  = document.querySelectorAll('.swatch')

// ---------------------------------------------------------------------------
// Render scheduler — debounces slider changes, queues at most one pending job
// ---------------------------------------------------------------------------
let renderTimer = null
function scheduleRender(immediate = false) {
  if (!state.imageData) return
  clearTimeout(renderTimer)
  renderTimer = setTimeout(() => {
    if (state.busy) { state.pendingRender = true; return }
    state.busy = true
    statusMsg.textContent = '渲染中…'
    renderSeq++
    worker.postMessage({
      id:          renderSeq,
      imageData:   state.imageData,
      imgW:        state.imgW,
      imgH:        state.imgH,
      cols:        state.cols,
      contrastExp: state.contrastExp,
      invert:      state.invert,
      charSetKey:  state.charSetKey,
      fontSize:    state.fontSize,
      fontFamily:  state.fontFamily,
    })
  }, immediate ? 0 : 80)
}

// ---------------------------------------------------------------------------
// Image loading — downscale large images, return raw RGBA bytes for worker
// ---------------------------------------------------------------------------
function loadImageData(src) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight
      const MAX = 2000
      if (w > MAX) { h = Math.round(h * MAX / w); w = MAX }
      if (h > MAX) { w = Math.round(w * MAX / h); h = MAX }
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      resolve({ data: canvas.getContext('2d').getImageData(0, 0, w, h).data, w, h })
    }
    img.src = src
  })
}

async function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) return

  dropZone.classList.add('hidden')
  splitLeft.classList.remove('hidden')
  splitRight.classList.remove('hidden')
  divider.classList.remove('hidden')
  document.getElementById('controls').classList.remove('hidden')
  statusMsg.textContent = '加载图片中…'

  const dataUrl = await new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = e => resolve(e.target.result)
    reader.readAsDataURL(file)
  })

  // Hand the image to p5 for display; extract pixel data for the worker
  previewP5.loadImg(dataUrl)
  const { data, w, h } = await loadImageData(dataUrl)
  state.imageData = data
  state.imgW = w
  state.imgH = h
  scheduleRender(true)
}

// ---------------------------------------------------------------------------
// File input & drag-drop
// ---------------------------------------------------------------------------
document.getElementById('upload-btn').addEventListener('click', () => fileInput.click())
document.getElementById('upload-btn-2').addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => handleFile(fileInput.files[0]))

document.addEventListener('dragover', e => e.preventDefault())
document.addEventListener('drop', e => {
  e.preventDefault()
  handleFile(e.dataTransfer.files[0])
})

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
colsSlider.addEventListener('input', () => {
  state.cols = parseInt(colsSlider.value)
  colsValue.textContent = state.cols
  scheduleRender()
})

contrastSlider.addEventListener('input', () => {
  state.contrastExp = parseFloat(contrastSlider.value)
  contrastValue.textContent = state.contrastExp.toFixed(1)
  scheduleRender()
})

invertToggle.addEventListener('change', () => {
  state.invert = invertToggle.checked
  scheduleRender()
})

charSetSelect.addEventListener('change', () => {
  state.charSetKey = charSetSelect.value
  scheduleRender()
})

fontSizeSlider.addEventListener('input', () => {
  const size = parseInt(fontSizeSlider.value)
  state.fontSize = size
  fontSizeValue.textContent = size
  asciiOutput.style.fontSize   = `${size}px`
  asciiOutput.style.lineHeight = `${size * 1.2}px`
  scheduleRender()
})

function applyFgColor(color) {
  document.documentElement.style.setProperty('--fg', color)
}

colorSwatches.forEach(swatch => {
  if (swatch.dataset.color) {
    swatch.addEventListener('click', () => {
      colorSwatches.forEach(s => s.classList.remove('active'))
      swatch.classList.add('active')
      applyFgColor(swatch.dataset.color)
    })
  }
})

const colorPicker = document.getElementById('color-picker')
colorPicker.addEventListener('input', () => {
  colorSwatches.forEach(s => s.classList.remove('active'))
  applyFgColor(colorPicker.value)
})

// ---------------------------------------------------------------------------
// Resizable divider — mouse + touch, horizontal on desktop / vertical on mobile
// ---------------------------------------------------------------------------
const mobileQuery = window.matchMedia('(max-width: 640px)')

function applySplit(clientX, clientY) {
  const container = document.getElementById('split-container')
  const rect = container.getBoundingClientRect()
  if (mobileQuery.matches) {
    const pct = Math.max(20, Math.min(80, (clientY - rect.top) / rect.height * 100))
    splitLeft.style.height  = `${pct}%`
    splitRight.style.height = `${100 - pct}%`
  } else {
    const pct = Math.max(20, Math.min(80, (clientX - rect.left) / rect.width * 100))
    splitLeft.style.width  = `${pct}%`
    splitRight.style.width = `${100 - pct}%`
  }
}

let dragging = false

// Mouse
divider.addEventListener('mousedown', e => { dragging = true; e.preventDefault() })
document.addEventListener('mousemove', e => { if (dragging) applySplit(e.clientX, e.clientY) })
document.addEventListener('mouseup',   () => { dragging = false })

// Touch
divider.addEventListener('touchstart', e => { dragging = true; e.preventDefault() }, { passive: false })
document.addEventListener('touchmove',  e => { if (dragging) applySplit(e.touches[0].clientX, e.touches[0].clientY) }, { passive: true })
document.addEventListener('touchend',  () => { dragging = false })

// Reset inline sizes when crossing the breakpoint to avoid stale overrides
mobileQuery.addEventListener('change', () => {
  splitLeft.style.width  = ''
  splitRight.style.width = ''
  splitLeft.style.height  = ''
  splitRight.style.height = ''
})

// ---------------------------------------------------------------------------
// Export — PNG uses offscreen canvas; both trigger <a download> click
// ---------------------------------------------------------------------------
function asciiToCanvas(text, { bgColor, fgColor, fontSize, fontFamily }) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const font = `${fontSize}px ${fontFamily}`
  ctx.font = font
  const charW = ctx.measureText('M').width
  const charH = fontSize * 1.2
  const lines = text.split('\n')
  const maxCols = Math.max(...lines.map(l => l.length))
  canvas.width  = Math.ceil(maxCols * charW)
  canvas.height = Math.ceil(lines.length * charH)
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = fgColor
  ctx.font = font
  ctx.textBaseline = 'top'
  lines.forEach((line, i) => ctx.fillText(line, 0, i * charH))
  return canvas
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

saveTxtBtn.addEventListener('click', () => {
  if (!state.asciiText) return
  triggerDownload(new Blob([state.asciiText], { type: 'text/plain' }), 'ascii.txt')
  statusMsg.textContent = '已保存为 TXT ✓'
})

savePngBtn.addEventListener('click', () => {
  if (!state.asciiText) return
  const style = getComputedStyle(document.documentElement)
  const bgColor = style.getPropertyValue('--bg').trim() || '#0d1f2d'
  const fgColor = style.getPropertyValue('--fg').trim() || '#4da6ff'
  const canvas = asciiToCanvas(state.asciiText, {
    bgColor, fgColor,
    fontSize:   state.fontSize,
    fontFamily: state.fontFamily,
  })
  canvas.toBlob(blob => {
    triggerDownload(blob, 'ascii.png')
    statusMsg.textContent = '已保存为 PNG ✓'
  })
})

// ---------------------------------------------------------------------------
// p5.js preview sketch (instance mode) — right panel image display
// ---------------------------------------------------------------------------
const previewSketch = (p) => {
  let img = null

  p.setup = () => {
    const container = document.getElementById('p5-container')
    const cnv = p.createCanvas(container.clientWidth || 400, container.clientHeight || 400)
    cnv.parent('p5-container')
    p.pixelDensity(1)
    p.noLoop()
    p.imageMode(p.CENTER)
    p.noStroke()
  }

  p.draw = () => {
    p.background(13, 31, 45)
    if (!img) return
    const scale = Math.min(p.width / img.width, p.height / img.height) * 0.94
    p.image(img, p.width / 2, p.height / 2, img.width * scale, img.height * scale)
  }

  p.loadImg = (src) => {
    p.loadImage(src, loaded => {
      img = loaded
      p.redraw()
    })
  }

  p.resize = () => {
    const container = document.getElementById('p5-container')
    if (!container) return
    p.resizeCanvas(container.clientWidth, container.clientHeight)
    p.redraw()
  }
}

const previewP5 = new p5(previewSketch)

// ResizeObserver keeps the p5 canvas in sync with its container
// (handles both window resize and divider drag without polling)
const _ro = new ResizeObserver(() => previewP5.resize())
_ro.observe(document.getElementById('p5-container'))
