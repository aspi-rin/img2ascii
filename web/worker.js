const CHAR_SETS = {
  all:     Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  classic: [...' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@'],
  minimal: [...' .:-=+*#%@'],
  digits:  [...' .,;1234567890!|/\\#@'],
}

function buildCircles(cW, cH) {
  const r = Math.min(cW * 0.44, cH * 0.27)
  const s = cH * 0.08
  const xs = [cW * 0.25, cW * 0.5, cW * 0.75]
  const topY = cH * 0.27
  const botY = cH * 0.73
  const stagger = [s, 0, -s]
  return [
    { cx: xs[0], cy: topY + stagger[0], r },
    { cx: xs[1], cy: topY + stagger[1], r },
    { cx: xs[2], cy: topY + stagger[2], r },
    { cx: xs[0], cy: botY + stagger[0], r },
    { cx: xs[1], cy: botY + stagger[1], r },
    { cx: xs[2], cy: botY + stagger[2], r },
  ]
}

function buildExternalCircles(circles, cW, cH) {
  const cxCell = cW / 2
  const cyCell = cH / 2
  return circles.map(({ cx, cy, r }) => {
    const dx = cx - cxCell
    const dy = cy - cyCell
    return { cx: cx + dx * 1.5, cy: cy + dy * 1.5, r }
  })
}

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
      sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
      count++
    }
  }
  return count > 0 ? sum / count : 0
}

const shapeVectorCache = new Map()

function buildCharShapeVectors(chars, fontSize, fontFamily) {
  const key = `${fontSize}|${fontFamily}|${chars.join('')}`
  if (shapeVectorCache.has(key)) return shapeVectorCache.get(key)

  const canvas = new OffscreenCanvas(1, 1)
  const ctx = canvas.getContext('2d')
  const font = `${fontSize}px ${fontFamily}`

  ctx.font = font
  const rawCW = ctx.measureText('M').width
  const cW = Math.ceil(rawCW)
  const cH = Math.ceil(fontSize)
  const circles = buildCircles(cW, cH)

  canvas.width = cW
  canvas.height = cH

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

  const compMax = new Float32Array(6)
  for (const vec of rawVectors) {
    for (let j = 0; j < 6; j++) if (vec[j] > compMax[j]) compMax[j] = vec[j]
  }

  const normalizedVectors = rawVectors.map(vec => {
    const n = new Float32Array(6)
    for (let j = 0; j < 6; j++) n[j] = compMax[j] > 0 ? vec[j] / compMax[j] : 0
    return n
  })

  const result = { chars, normalizedVectors, cW, rawCW, cH, circles }
  shapeVectorCache.set(key, result)
  return result
}

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
    if (dist < bestDist) { bestDist = dist; bestIdx = i }
  }
  return chars[bestIdx]
}

function globalContrast(vec, exp) {
  let max = 0
  for (let i = 0; i < 6; i++) if (vec[i] > max) max = vec[i]
  if (max === 0 || exp === 1) return vec
  const out = new Float32Array(6)
  for (let i = 0; i < 6; i++) out[i] = Math.pow(vec[i] / max, exp) * max
  return out
}

function directionalContrast(vec, extVec, exp) {
  if (exp === 1) return vec
  const out = new Float32Array(6)
  for (let i = 0; i < 6; i++) {
    const maxVal = Math.max(vec[i], extVec[i])
    out[i] = maxVal > 0 ? Math.pow(vec[i] / maxVal, exp) * maxVal : 0
  }
  return out
}

function renderAscii({ imageData, imgW, imgH, cols, contrastExp, invert, charSetKey, fontSize, fontFamily }) {
  const chars = CHAR_SETS[charSetKey] || CHAR_SETS.all
  const { chars: charList, normalizedVectors, cW: charCW, rawCW, cH: charCH, circles } =
    buildCharShapeVectors(chars, fontSize, fontFamily)

  const cellW = imgW / cols
  const lineH = fontSize * 1.2
  const cellH = cellW * (lineH / rawCW)
  const rows  = Math.max(1, Math.floor(imgH / cellH))

  const extCircles = buildExternalCircles(circles, charCW, charCH)
  const scaleX = cellW / charCW
  const scaleY = cellH / lineH
  const scaledExt = extCircles.map(({ cx, cy, r }) => ({
    cx: cx * scaleX, cy: cy * scaleY,
    r:  Math.min(charCW, charCH) * 0.27 * scaleX,
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
      const sampVec = new Float32Array(6)
      for (let k = 0; k < 6; k++) {
        const { cx, cy, r } = scaledInt[k]
        sampVec[k] = sampleCircle(imageData, imgW, imgH, originX + cx, originY + cy, r)
      }
      const extVec = new Float32Array(6)
      for (let k = 0; k < 6; k++) {
        const { cx, cy, r } = scaledExt[k]
        extVec[k] = sampleCircle(imageData, imgW, imgH, originX + cx, originY + cy, r)
      }
      let sv = invert ? sampVec.map(v => 1 - v) : sampVec
      let ev = invert ? extVec.map(v => 1 - v) : extVec
      if (contrastExp > 1) {
        sv = directionalContrast(sv, ev, contrastExp)
        sv = globalContrast(sv, contrastExp * 0.6)
      }
      line += findBestChar(sv, charList, normalizedVectors)
    }
    lines.push(line)
  }
  return { text: lines.join('\n'), rows }
}

self.onmessage = (e) => {
  const { id, ...params } = e.data
  const t0 = performance.now()
  const { text, rows } = renderAscii(params)
  const ms = Math.round(performance.now() - t0)
  self.postMessage({ id, text, ms, rows, cols: params.cols, imgW: params.imgW, imgH: params.imgH })
}
