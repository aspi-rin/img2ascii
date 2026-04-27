const { ipcRenderer } = require('electron')

// ---------------------------------------------------------------------------
// Character sets
// ---------------------------------------------------------------------------
const CHAR_SETS = {
  all:      Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  classic:  [...' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@'],
  minimal:  [...' .:-=+*#%@'],
  digits:   [...' .,;1234567890!|/\\#@'],
}

// ---------------------------------------------------------------------------
// Sampling circle layout for a cell of size (cW × cH)
// 3 columns × 2 rows, staggered vertically (left col down, right col up)
// ---------------------------------------------------------------------------
function buildCircles(cW, cH) {
  const r = Math.min(cW * 0.44, cH * 0.27)
  const s = cH * 0.08  // stagger offset

  const xs   = [cW * 0.25, cW * 0.5, cW * 0.75]
  const topY = cH * 0.27
  const botY = cH * 0.73

  // left col staggered down, right col staggered up, middle unchanged
  const stagger = [s, 0, -s]

  return [
    { cx: xs[0], cy: topY + stagger[0], r },  // 0: top-left
    { cx: xs[1], cy: topY + stagger[1], r },  // 1: top-mid
    { cx: xs[2], cy: topY + stagger[2], r },  // 2: top-right
    { cx: xs[0], cy: botY + stagger[0], r },  // 3: bot-left
    { cx: xs[1], cy: botY + stagger[1], r },  // 4: bot-mid
    { cx: xs[2], cy: botY + stagger[2], r },  // 5: bot-right
  ]
}

// External circles: each placed outside the cell in the direction of its
// paired internal circle (away from cell center).
function buildExternalCircles(circles, cW, cH) {
  const cxCell = cW / 2
  const cyCell = cH / 2
  return circles.map(({ cx, cy, r }) => {
    const dx = cx - cxCell
    const dy = cy - cyCell
    // step 1.5× further in the same direction from cell center
    return { cx: cx + dx * 1.5, cy: cy + dy * 1.5, r }
  })
}

// ---------------------------------------------------------------------------
// Sample average luminance inside a circle from image RGBA data
// (cx, cy, r are in absolute image pixel coordinates)
// ---------------------------------------------------------------------------
function sampleCircle(data, imgW, imgH, cx, cy, r) {
  const x0 = Math.max(0, Math.floor(cx - r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const x1 = Math.min(imgW - 1, Math.ceil(cx + r))
  const y1 = Math.min(imgH - 1, Math.ceil(cy + r))
  const r2 = r * r
  let sum = 0, count = 0

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy
      if (dx * dx + dy * dy > r2) continue
      const i = (y * imgW + x) * 4
      // Rec.709 luminance
      sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
      count++
    }
  }
  return count > 0 ? sum / count : 0
}

// ---------------------------------------------------------------------------
// Pre-compute and cache shape vectors for all characters in the chosen set
// Key = `${fontSize}|${fontFamily}|${charSetKey}`
// ---------------------------------------------------------------------------
const shapeVectorCache = new Map()

function buildCharShapeVectors(chars, fontSize, fontFamily) {
  const key = `${fontSize}|${fontFamily}|${chars.join('')}`
  if (shapeVectorCache.has(key)) return shapeVectorCache.get(key)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const font = `${fontSize}px ${fontFamily}`

  // Measure cell dimensions using 'M' as reference.
  // rawCW is the true float width; cW is ceiled only for the offscreen canvas size.
  ctx.font = font
  const rawCW = ctx.measureText('M').width
  const cW = Math.ceil(rawCW)
  const cH = Math.ceil(fontSize)
  const circles = buildCircles(cW, cH)

  canvas.width = cW
  canvas.height = cH

  // Compute raw shape vectors by rendering each char onto canvas
  const rawVectors = chars.map(char => {
    if (char === ' ') return new Float32Array(6)

    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, cW, cH)
    ctx.fillStyle = '#fff'
    ctx.font = font
    ctx.textBaseline = 'top'
    ctx.fillText(char, 0, 0)

    const { data } = ctx.getImageData(0, 0, cW, cH)
    const vec = new Float32Array(6)
    for (let i = 0; i < 6; i++) {
      vec[i] = sampleCircle(data, cW, cH, circles[i].cx, circles[i].cy, circles[i].r)
    }
    return vec
  })

  // Normalize per-component so max = 1 across all characters
  const compMax = new Float32Array(6)
  for (const vec of rawVectors) {
    for (let j = 0; j < 6; j++) {
      if (vec[j] > compMax[j]) compMax[j] = vec[j]
    }
  }

  const normalizedVectors = rawVectors.map(vec => {
    const n = new Float32Array(6)
    for (let j = 0; j < 6; j++) {
      n[j] = compMax[j] > 0 ? vec[j] / compMax[j] : 0
    }
    return n
  })

  const result = { chars, normalizedVectors, cW, rawCW, cH, circles }
  shapeVectorCache.set(key, result)
  return result
}

// ---------------------------------------------------------------------------
// Nearest-neighbor character lookup (squared Euclidean distance in 6D)
// ---------------------------------------------------------------------------
function findBestChar(sampVec, chars, normalizedVectors) {
  let bestIdx = 0
  let bestDist = Infinity

  for (let i = 0; i < normalizedVectors.length; i++) {
    const sv = normalizedVectors[i]
    let dist = 0
    for (let j = 0; j < 6; j++) {
      const d = sv[j] - sampVec[j]
      dist += d * d
    }
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = i
    }
  }
  return chars[bestIdx]
}

// ---------------------------------------------------------------------------
// Contrast enhancement
// ---------------------------------------------------------------------------

// Global: normalizes vector by its own max, applies exponent, denormalizes
function globalContrast(vec, exp) {
  let max = 0
  for (let i = 0; i < 6; i++) if (vec[i] > max) max = vec[i]
  if (max === 0 || exp === 1) return vec
  const out = new Float32Array(6)
  for (let i = 0; i < 6; i++) out[i] = Math.pow(vec[i] / max, exp) * max
  return out
}

// Directional: for each component, use max(internal, external) for normalization
// This "pulls down" components that are darker than their external neighbor
function directionalContrast(vec, extVec, exp) {
  if (exp === 1) return vec
  const out = new Float32Array(6)
  for (let i = 0; i < 6; i++) {
    const maxVal = Math.max(vec[i], extVec[i])
    out[i] = maxVal > 0 ? Math.pow(vec[i] / maxVal, exp) * maxVal : 0
  }
  return out
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------
function renderAscii({ imageData, imgW, imgH, cols, contrastExp, invert, charSetKey, fontSize, fontFamily }) {
  const chars = CHAR_SETS[charSetKey] || CHAR_SETS.all

  // Build (or fetch cached) character shape vectors
  const { chars: charList, normalizedVectors, cW: charCW, rawCW, cH: charCH, circles } =
    buildCharShapeVectors(chars, fontSize, fontFamily)

  // Cell dimensions in the source image.
  // Use rawCW (unceiled measureText) so the aspect ratio calculation isn't skewed by
  // Math.ceil rounding, and use lineH (the full CSS line-height) not just the em-height.
  const cellW = imgW / cols
  const lineH = fontSize * 1.2   // matches `line-height` set in CSS / fontSizeSlider
  const cellH = cellW * (lineH / rawCW)
  const rows  = Math.max(1, Math.floor(imgH / cellH))

  // Scale factors from character canvas space → image cell space.
  // scaleX uses the ceiled canvas width (circles are placed on that integer grid).
  // scaleY = cellH/lineH = cellW/rawCW ≈ scaleX (circles stay nearly circular in image space).
  const extCircles = buildExternalCircles(circles, charCW, charCH)
  const scaleX = cellW / charCW
  const scaleY = cellH / lineH   // was cellH/charCH which introduced a ×1.2 stretch
  const scaledExt = extCircles.map(({ cx, cy, r }) => ({
    cx: cx * scaleX, cy: cy * scaleY,
    r:  Math.min(charCW, charCH) * 0.27 * scaleX,  // keep r proportional
  }))
  const scaledInt = circles.map(({ cx, cy, r }) => ({
    cx: cx * scaleX, cy: cy * scaleY,
    r:  r * scaleX,
  }))

  const lines = []

  for (let row = 0; row < rows; row++) {
    let line = ''
    const originY = row * cellH

    for (let col = 0; col < cols; col++) {
      const originX = col * cellW

      // Internal sampling vector
      const sampVec = new Float32Array(6)
      for (let k = 0; k < 6; k++) {
        const { cx, cy, r } = scaledInt[k]
        sampVec[k] = sampleCircle(imageData, imgW, imgH, originX + cx, originY + cy, r)
      }

      // External sampling vector
      const extVec = new Float32Array(6)
      for (let k = 0; k < 6; k++) {
        const { cx, cy, r } = scaledExt[k]
        extVec[k] = sampleCircle(imageData, imgW, imgH, originX + cx, originY + cy, r)
      }

      // Invert if requested
      let sv = invert ? sampVec.map(v => 1 - v) : sampVec
      let ev = invert ? extVec.map(v => 1 - v) : extVec

      // Apply contrast enhancement (directional first, then global)
      if (contrastExp > 1) {
        sv = directionalContrast(sv, ev, contrastExp)
        sv = globalContrast(sv, contrastExp * 0.6)
      }

      line += findBestChar(sv, charList, normalizedVectors)
    }

    lines.push(line)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Render ASCII text to an offscreen canvas (for PNG export)
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

// ---------------------------------------------------------------------------
// App state
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
  rendering: false,
  pendingRender: false,
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const dropZone       = document.getElementById('drop-zone')
const uploadBtn      = document.getElementById('upload-btn')
const asciiOutput    = document.getElementById('ascii-output')
const originalImg    = document.getElementById('original-img')
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

// ---------------------------------------------------------------------------
// Render scheduler — debounces rapid slider changes
// ---------------------------------------------------------------------------
let renderTimer = null
function scheduleRender(immediate = false) {
  if (!state.imageData) return
  clearTimeout(renderTimer)
  const delay = immediate ? 0 : 80
  renderTimer = setTimeout(() => {
    if (state.rendering) { scheduleRender(false); return }
    state.rendering = true
    statusMsg.textContent = '渲染中…'

    // Run in a macrotask so the status update paints first
    setTimeout(() => {
      const t0 = performance.now()
      state.asciiText = renderAscii({
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
      asciiOutput.textContent = state.asciiText
      const ms = Math.round(performance.now() - t0)
      const rows = state.asciiText.split('\n').length
      statusMsg.textContent =
        `${state.imgW}×${state.imgH}px · ${state.cols}列 × ${rows}行 · ${ms}ms`
      state.rendering = false
    }, 10)
  }, delay)
}

// ---------------------------------------------------------------------------
// Load image into state
// ---------------------------------------------------------------------------
function loadImageData(dataUrl) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      // Downscale very large images for performance
      let w = img.naturalWidth, h = img.naturalHeight
      const MAX = 2000
      if (w > MAX) { h = Math.round(h * MAX / w); w = MAX }
      if (h > MAX) { w = Math.round(w * MAX / h); h = MAX }

      const offscreen = document.createElement('canvas')
      offscreen.width = w; offscreen.height = h
      const ctx = offscreen.getContext('2d')
      ctx.drawImage(img, 0, 0, w, h)
      resolve({ data: ctx.getImageData(0, 0, w, h).data, w, h })
    }
    img.src = dataUrl
  })
}

async function handleImage(dataUrl) {
  dropZone.classList.add('hidden')
  splitLeft.classList.remove('hidden')
  splitRight.classList.remove('hidden')
  divider.classList.remove('hidden')
  document.getElementById('controls').classList.remove('hidden')

  originalImg.src = dataUrl
  statusMsg.textContent = '加载图片中…'

  const { data, w, h } = await loadImageData(dataUrl)
  state.imageData = data
  state.imgW = w
  state.imgH = h
  scheduleRender(true)
}

// ---------------------------------------------------------------------------
// File input
// ---------------------------------------------------------------------------
uploadBtn.addEventListener('click', async () => {
  const dataUrl = await ipcRenderer.invoke('open-image')
  if (dataUrl) handleImage(dataUrl)
})

document.addEventListener('dragover', e => e.preventDefault())
document.addEventListener('drop', e => {
  e.preventDefault()
  const file = e.dataTransfer.files[0]
  if (!file || !file.type.startsWith('image/')) return
  const reader = new FileReader()
  reader.onload = ev => handleImage(ev.target.result)
  reader.readAsDataURL(file)
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
  asciiOutput.style.fontSize  = `${size}px`
  asciiOutput.style.lineHeight = `${size * 1.2}px`
  scheduleRender()
})

// ---------------------------------------------------------------------------
// Resizable divider
// ---------------------------------------------------------------------------
let dragging = false
divider.addEventListener('mousedown', e => { dragging = true; e.preventDefault() })
document.addEventListener('mousemove', e => {
  if (!dragging) return
  const container = document.getElementById('split-container')
  const rect = container.getBoundingClientRect()
  const pct = Math.max(20, Math.min(80, (e.clientX - rect.left) / rect.width * 100))
  splitLeft.style.width  = `${pct}%`
  splitRight.style.width = `${100 - pct}%`
})
document.addEventListener('mouseup', () => { dragging = false })

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
saveTxtBtn.addEventListener('click', async () => {
  if (!state.asciiText) return
  const ok = await ipcRenderer.invoke('save-txt', state.asciiText)
  if (ok) statusMsg.textContent = '已保存为 TXT ✓'
})

savePngBtn.addEventListener('click', async () => {
  if (!state.asciiText) return
  const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0d1f2d'
  const fgColor = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#4da6ff'
  const canvas = asciiToCanvas(state.asciiText, {
    bgColor, fgColor,
    fontSize:   state.fontSize,
    fontFamily: state.fontFamily,
  })
  const ok = await ipcRenderer.invoke('save-png', canvas.toDataURL('image/png'))
  if (ok) statusMsg.textContent = '已保存为 PNG ✓'
})

// "换图片" button in controls bar reuses the hidden upload button
document.getElementById('upload-btn-2').addEventListener('click', () => uploadBtn.click())
