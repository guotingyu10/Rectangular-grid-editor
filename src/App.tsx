import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type ProjectFileEntry = {
  path: string
  handle: FileSystemFileHandle
}

type OpenFolderState =
  | { status: 'idle' }
  | { status: 'opening' }
  | {
      status: 'ready'
      directoryHandle: FileSystemDirectoryHandle
      directoryName: string
      files: ProjectFileEntry[]
      elementPositionFile: FileSystemFileHandle
      elementPositionJson: unknown
    }
  | { status: 'error'; message: string }

async function listFilesRecursively(
  dirHandle: FileSystemDirectoryHandle,
  basePath: string,
): Promise<ProjectFileEntry[]> {
  const results: ProjectFileEntry[] = []
  const entries = (
    dirHandle as unknown as {
      entries: () => AsyncIterable<[string, FileSystemHandle]>
    }
  ).entries()

  for await (const [name, handle] of entries) {
    const path = basePath ? `${basePath}/${name}` : name
    if (handle.kind === 'file') {
      results.push({ path, handle: handle as FileSystemFileHandle })
      continue
    }

    results.push(...(await listFilesRecursively(handle as FileSystemDirectoryHandle, path)))
  }
  return results
}

async function writeJsonFile(
  handle: FileSystemFileHandle,
  data: unknown,
): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(JSON.stringify(data, null, 2))
  await writable.close()
}

async function ensureElementPositionJsonFile(
  directoryHandle: FileSystemDirectoryHandle,
): Promise<{
  fileHandle: FileSystemFileHandle
  json: unknown
  created: boolean
}> {
  const dirApi = directoryHandle as unknown as {
    getFileHandle: (
      name: string,
      options?: { create?: boolean },
    ) => Promise<FileSystemFileHandle>
  }

  const initial = { elements: [] as unknown[] }

  let created = false
  let fileHandle: FileSystemFileHandle

  try {
    fileHandle = await dirApi.getFileHandle('Element_position.json')
  } catch {
    created = true
    fileHandle = await dirApi.getFileHandle('Element_position.json', {
      create: true,
    })
  }

  const file = await fileHandle.getFile()
  const text = await file.text()

  if (created || text.trim().length === 0) {
    await writeJsonFile(fileHandle, initial)
    return { fileHandle, json: initial, created: true }
  }

  try {
    return { fileHandle, json: JSON.parse(text), created: false }
  } catch {
    await writeJsonFile(fileHandle, initial)
    return { fileHandle, json: initial, created: false }
  }
}

function App() {
  const [openFolderState, setOpenFolderState] = useState<OpenFolderState>({
    status: 'idle',
  })
  const baseGridCols = 21
  const baseGridRows = 21
  const [viewTopLeft, setViewTopLeft] = useState<{ x: number; y: number }>({
    x: -10,
    y: -10,
  })
  const viewTopLeftRef = useRef(viewTopLeft)
  const [cursor, setCursor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const cursorRef = useRef(cursor)
  const gridRootRef = useRef<HTMLDivElement | null>(null)
  const gridCanvasRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const composingRef = useRef(false)
  const rightDragRef = useRef<{
    active: boolean
    pointerId: number
    startClientX: number
    startClientY: number
    startTopLeft: { x: number; y: number }
    cursorAtStart: { x: number; y: number }
    cellWidth: number
    cellHeight: number
  } | null>(null)
  const [isRightDragging, setIsRightDragging] = useState(false)
  const baseDprRef = useRef<number | null>(null)
  const [uiScale, setUiScale] = useState(1)
  const [gridZoom, setGridZoom] = useState(1)
  const gridZoomRef = useRef(gridZoom)
  const [gridSize, setGridSize] = useState<{ cols: number; rows: number }>({
    cols: baseGridCols,
    rows: baseGridRows,
  })
  const gridSizeRef = useRef(gridSize)
  const [cells, setCells] = useState<Record<string, string>>({})
  const cellsRef = useRef(cells)
  const [imeBox, setImeBox] = useState<{
    left: number
    top: number
    width: number
    height: number
  }>({ left: 0, top: 0, width: 0, height: 0 })
  const [gridOffset, setGridOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [gridCellSize, setGridCellSize] = useState(1)
  const gridCellSizeRef = useRef(gridCellSize)
  const [gridCellFontSize, setGridCellFontSize] = useState(14)
  const gridCellFontSizeRef = useRef(gridCellFontSize)
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const cellKey = useCallback((x: number, y: number) => `${x},${y}`, [])

  const focusInput = useCallback(() => {
    inputRef.current?.focus()
  }, [])

  const canOpenFolder = useMemo(() => {
    return 'showDirectoryPicker' in window
  }, [])

  const openFolder = useCallback(async () => {
    if (!('showDirectoryPicker' in window)) {
      setOpenFolderState({
        status: 'error',
        message:
          '当前浏览器不支持打开文件夹（需要 File System Access API）。请使用 Chromium 系浏览器，并在 https 或 localhost 下运行。',
      })
      return
    }

    try {
      setOpenFolderState({ status: 'opening' })
      setViewTopLeft({ x: -10, y: -10 })
      setCursor({ x: 0, y: 0 })
      setGridZoom(1)
      setCells({})
      const directoryHandle = await (
        window as unknown as {
          showDirectoryPicker: (options?: {
            mode?: 'read' | 'readwrite'
          }) => Promise<FileSystemDirectoryHandle>
        }
      ).showDirectoryPicker({ mode: 'readwrite' })

      const files = await listFilesRecursively(directoryHandle, '')
      const ensured = await ensureElementPositionJsonFile(directoryHandle)
      const elementPositionEntry = files.find((f) => f.path === 'Element_position.json')
      const nextFiles = elementPositionEntry
        ? files
        : [...files, { path: 'Element_position.json', handle: ensured.fileHandle }]

      setOpenFolderState({
        status: 'ready',
        directoryHandle,
        directoryName: directoryHandle.name,
        files: nextFiles,
        elementPositionFile: ensured.fileHandle,
        elementPositionJson: ensured.json,
      })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : '打开文件夹失败（未知错误）'
      setOpenFolderState({ status: 'error', message })
    }
  }, [])

  useEffect(() => {
    viewTopLeftRef.current = viewTopLeft
  }, [viewTopLeft])

  useEffect(() => {
    cursorRef.current = cursor
  }, [cursor])

  useEffect(() => {
    cellsRef.current = cells
  }, [cells])

  useEffect(() => {
    gridZoomRef.current = gridZoom
  }, [gridZoom])

  useEffect(() => {
    gridSizeRef.current = gridSize
  }, [gridSize])

  useEffect(() => {
    gridCellSizeRef.current = gridCellSize
  }, [gridCellSize])

  useEffect(() => {
    gridCellFontSizeRef.current = gridCellFontSize
  }, [gridCellFontSize])

  useEffect(() => {
    measureCanvasRef.current = document.createElement('canvas')
    return () => {
      measureCanvasRef.current = null
    }
  }, [])

  useEffect(() => {
    if (openFolderState.status !== 'ready') return
    const id = requestAnimationFrame(() => focusInput())
    return () => cancelAnimationFrame(id)
  }, [focusInput, openFolderState.status])

  const gridRange = useMemo(() => {
    const baseX = Math.floor(viewTopLeft.x)
    const baseY = Math.floor(viewTopLeft.y)
    const xs = Array.from({ length: gridSize.cols }, (_, i) => baseX + i)
    const ys = Array.from({ length: gridSize.rows }, (_, i) => baseY + i)
    return { xs, ys }
  }, [gridSize.cols, gridSize.rows, viewTopLeft.x, viewTopLeft.y])

  const panX = useCallback((steps: number) => {
    if (steps === 0) return
    setViewTopLeft((prev) => ({ x: prev.x + steps, y: prev.y }))
  }, [])

  const panY = useCallback((steps: number) => {
    if (steps === 0) return
    setViewTopLeft((prev) => ({ x: prev.x, y: prev.y + steps }))
  }, [])

  const updateGridCellFontSize = useCallback(() => {
    if (openFolderState.status !== 'ready') return
    const cellSize = gridCellSizeRef.current
    if (!Number.isFinite(cellSize) || cellSize <= 0) return

    const canvas = measureCanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx) return

    const mono =
      getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace'

    const probeSize = 100
    ctx.font = `${probeSize}px ${mono}`

    const chars = new Set<string>()
    for (const v of Object.values(cellsRef.current)) {
      if (!v || v === ' ' || v === '\n') continue
      chars.add(v)
      if (chars.size >= 256) break
    }

    if (chars.size === 0) {
      const fallback = Math.max(1, cellSize * 0.9)
      if (gridCellFontSizeRef.current !== fallback) setGridCellFontSize(fallback)
      return
    }

    const target = cellSize * 0.96
    let next = Number.POSITIVE_INFINITY
    for (const ch of chars) {
      const m = ctx.measureText(ch)
      const w =
        Number.isFinite(m.actualBoundingBoxLeft) && Number.isFinite(m.actualBoundingBoxRight)
          ? m.actualBoundingBoxLeft + m.actualBoundingBoxRight
          : Math.max(1, m.width)
      const h =
        Number.isFinite(m.actualBoundingBoxAscent) && Number.isFinite(m.actualBoundingBoxDescent)
          ? m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
          : probeSize
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue
      const scale = Math.min(target / w, target / h)
      const fit = probeSize * scale
      if (fit < next) next = fit
    }

    if (!Number.isFinite(next) || next <= 0) return
    const clamped = Math.max(1, Math.min(cellSize, next))
    if (gridCellFontSizeRef.current !== clamped) setGridCellFontSize(clamped)
  }, [openFolderState.status])

  const updateImeBox = useCallback(() => {
    const root = gridRootRef.current
    const canvas = gridCanvasRef.current
    if (!root || !canvas) return

    const rootRect = root.getBoundingClientRect()
    const canvasRect = canvas.getBoundingClientRect()
    const zoom = gridZoomRef.current
    const baseCellSize = Math.min(
      canvasRect.width / baseGridCols,
      canvasRect.height / baseGridRows,
    )
    if (!Number.isFinite(baseCellSize) || baseCellSize <= 0) return
    if (gridCellSizeRef.current !== baseCellSize) {
      gridCellSizeRef.current = baseCellSize
      setGridCellSize(baseCellSize)
    }
    updateGridCellFontSize()

    const screenCell = baseCellSize * zoom
    if (!Number.isFinite(screenCell) || screenCell <= 0) return

    const nextCols = Math.max(1, Math.ceil(canvasRect.width / screenCell) + 2)
    const nextRows = Math.max(1, Math.ceil(canvasRect.height / screenCell) + 2)
    const prevSize = gridSizeRef.current
    if (prevSize.cols !== nextCols || prevSize.rows !== nextRows) {
      const nextSize = { cols: nextCols, rows: nextRows }
      gridSizeRef.current = nextSize
      setGridSize(nextSize)
    }

    const topLeft = viewTopLeftRef.current
    const cursorPos = cursorRef.current

    const minX = Math.floor(topLeft.x)
    const minY = Math.floor(topLeft.y)
    const maxX = minX + nextCols - 1
    const maxY = minY + nextRows - 1
    const visible =
      cursorPos.x >= minX &&
      cursorPos.x <= maxX &&
      cursorPos.y >= minY &&
      cursorPos.y <= maxY

    if (!visible) {
      setImeBox({ left: -9999, top: -9999, width: 0, height: 0 })
      return
    }

    const relX = (cursorPos.x - topLeft.x) * baseCellSize * zoom
    const relY = (cursorPos.y - topLeft.y) * baseCellSize * zoom

    const fracX = topLeft.x - Math.floor(topLeft.x)
    const fracY = topLeft.y - Math.floor(topLeft.y)
    setGridOffset({
      x: -fracX * baseCellSize * zoom,
      y: -fracY * baseCellSize * zoom,
    })

    const padding = 2
    setImeBox({
      left: canvasRect.left - rootRect.left + relX + padding,
      top: canvasRect.top - rootRect.top + relY + padding,
      width: Math.max(0, baseCellSize * zoom - padding * 2),
      height: Math.max(0, baseCellSize * zoom - padding * 2),
    })
  }, [baseGridCols, baseGridRows, updateGridCellFontSize])

  useEffect(() => {
    if (openFolderState.status !== 'ready') return
    const raf = requestAnimationFrame(() => updateImeBox())
    return () => cancelAnimationFrame(raf)
  }, [cursor, viewTopLeft, gridZoom, openFolderState.status, updateImeBox])

  useEffect(() => {
    if (openFolderState.status !== 'ready') return
    const raf = requestAnimationFrame(() => updateGridCellFontSize())
    return () => cancelAnimationFrame(raf)
  }, [cells, gridCellSize, openFolderState.status, updateGridCellFontSize])

  const summary = useMemo(() => {
    if (openFolderState.status !== 'ready') return null
    const txtCount = openFolderState.files.filter((f) =>
      f.path.toLowerCase().endsWith('.txt'),
    ).length
    const jsonCount = openFolderState.files.filter((f) =>
      f.path.toLowerCase().endsWith('.json'),
    ).length
    const imageCount = openFolderState.files.filter((f) =>
      /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f.path),
    ).length
    return { txtCount, jsonCount, imageCount, total: openFolderState.files.length }
  }, [openFolderState])

  useEffect(() => {
    if (baseDprRef.current === null) baseDprRef.current = window.devicePixelRatio || 1

    const updateScale = () => {
      const base = baseDprRef.current ?? 1
      const current = window.devicePixelRatio || 1
      setUiScale(base / current)
    }

    updateScale()
    window.addEventListener('resize', updateScale)
    window.visualViewport?.addEventListener('resize', updateScale)
    return () => {
      window.removeEventListener('resize', updateScale)
      window.visualViewport?.removeEventListener('resize', updateScale)
    }
  }, [])

  useEffect(() => {
    if (openFolderState.status !== 'ready') return

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const raw = e.deltaY
      if (raw === 0) return
      const canvas = gridCanvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return

      const oldZoom = gridZoomRef.current
      const topLeft = viewTopLeftRef.current
      const cursorPos = cursorRef.current

      const cellSize = gridCellSizeRef.current
      if (!Number.isFinite(cellSize) || cellSize <= 0) return
      const anchorWorldX = cursorPos.x + 0.5
      const anchorWorldY = cursorPos.y + 0.5
      const anchorCanvasX = (anchorWorldX - topLeft.x) * cellSize * oldZoom
      const anchorCanvasY = (anchorWorldY - topLeft.y) * cellSize * oldZoom

      const factor = Math.pow(1.12, -raw / 100)
      const nextZoom = Math.max(0.25, Math.min(4, oldZoom * factor))
      gridZoomRef.current = nextZoom
      setGridZoom(nextZoom)

      const nextTopLeftRaw = {
        x: anchorWorldX - anchorCanvasX / (cellSize * nextZoom),
        y: anchorWorldY - anchorCanvasY / (cellSize * nextZoom),
      }
      const fracX = nextTopLeftRaw.x - Math.floor(nextTopLeftRaw.x)
      const fracY = nextTopLeftRaw.y - Math.floor(nextTopLeftRaw.y)
      setGridOffset({
        x: -fracX * cellSize * nextZoom,
        y: -fracY * cellSize * nextZoom,
      })
      viewTopLeftRef.current = nextTopLeftRaw
      setViewTopLeft(nextTopLeftRaw)
    }

    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => {
      window.removeEventListener('wheel', onWheel, true)
    }
  }, [openFolderState.status])

  useEffect(() => {
    if (openFolderState.status !== 'ready') return

    const raf = requestAnimationFrame(() => updateImeBox())

    const ro =
      'ResizeObserver' in window
        ? new ResizeObserver(() => updateImeBox())
        : null

    if (ro && gridCanvasRef.current) ro.observe(gridCanvasRef.current)

    const onViewportChange = () => updateImeBox()
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    window.visualViewport?.addEventListener('resize', onViewportChange)
    window.visualViewport?.addEventListener('scroll', onViewportChange)

    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
      window.visualViewport?.removeEventListener('resize', onViewportChange)
      window.visualViewport?.removeEventListener('scroll', onViewportChange)
    }
  }, [openFolderState.status, updateImeBox])

  if (openFolderState.status === 'ready') {
    return (
      <div className="gridRoot" ref={gridRootRef}>
        <textarea
          ref={inputRef}
          className="gridImeInput"
          style={{
            left: imeBox.left,
            top: imeBox.top,
            width: imeBox.width,
            height: imeBox.height,
          }}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false
            const value = e.currentTarget.value
            if (value.length === 0) return

            e.currentTarget.value = ''
            let nextCursor = cursorRef.current
            const nextCells = { ...cellsRef.current }

            for (const char of value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')) {
              if (char === '\n') {
                nextCells[cellKey(nextCursor.x, nextCursor.y)] = '\n'
                nextCursor = { x: 0, y: nextCursor.y + 1 }
                continue
              }
              nextCells[cellKey(nextCursor.x, nextCursor.y)] = char
              nextCursor = { x: nextCursor.x + 1, y: nextCursor.y }
            }

            cellsRef.current = nextCells
            cursorRef.current = nextCursor
            setCells(nextCells)
            setCursor(nextCursor)
          }}
          onInput={(e) => {
            if (composingRef.current) return
            const value = e.currentTarget.value
            if (value.length === 0) return

            e.currentTarget.value = ''
            let nextCursor = cursorRef.current
            const nextCells = { ...cellsRef.current }

            for (const char of value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')) {
              if (char === '\n') {
                nextCells[cellKey(nextCursor.x, nextCursor.y)] = '\n'
                nextCursor = { x: 0, y: nextCursor.y + 1 }
                continue
              }
              nextCells[cellKey(nextCursor.x, nextCursor.y)] = char
              nextCursor = { x: nextCursor.x + 1, y: nextCursor.y }
            }

            cellsRef.current = nextCells
            cursorRef.current = nextCursor
            setCells(nextCells)
            setCursor(nextCursor)
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || composingRef.current) return
            if (e.ctrlKey || e.metaKey || e.altKey) return

            const current = cursorRef.current

            if (e.key === 'ArrowUp') {
              e.preventDefault()
              const next = { x: current.x, y: current.y - 1 }
              cursorRef.current = next
              setCursor(next)
              return
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              const next = { x: current.x, y: current.y + 1 }
              cursorRef.current = next
              setCursor(next)
              return
            }
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              const next = { x: current.x - 1, y: current.y }
              cursorRef.current = next
              setCursor(next)
              return
            }
            if (e.key === 'ArrowRight') {
              e.preventDefault()
              const next = { x: current.x + 1, y: current.y }
              cursorRef.current = next
              setCursor(next)
              return
            }
            if (e.key === 'Backspace') {
              e.preventDefault()
              const nextCursor = { x: current.x - 1, y: current.y }
              const nextCells = { ...cellsRef.current }
              delete nextCells[cellKey(nextCursor.x, nextCursor.y)]
              cellsRef.current = nextCells
              cursorRef.current = nextCursor
              setCells(nextCells)
              setCursor(nextCursor)
              return
            }
            if (e.key === 'Delete') {
              e.preventDefault()
              const nextCells = { ...cellsRef.current }
              delete nextCells[cellKey(current.x, current.y)]
              cellsRef.current = nextCells
              setCells(nextCells)
              return
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              const nextCells = { ...cellsRef.current }
              nextCells[cellKey(current.x, current.y)] = '\n'
              const nextCursor = { x: 0, y: current.y + 1 }
              cellsRef.current = nextCells
              cursorRef.current = nextCursor
              setCells(nextCells)
              setCursor(nextCursor)
              return
            }
            if (e.key === 'Tab') {
              e.preventDefault()
            }
          }}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <div className="gridHeader" style={{ zoom: uiScale / 3 }}>
          <div>
            已打开：<code>{openFolderState.directoryName}</code>
          </div>
          <div>
            光标：<code>({cursor.x}, {cursor.y})</code>
          </div>
          {summary ? (
            <div>
              文件：<code>{summary.total}</code>（txt <code>{summary.txtCount}</code>，图片{' '}
              <code>{summary.imageCount}</code>，json <code>{summary.jsonCount}</code>）
            </div>
          ) : null}
          <div>
            Element_position.json：<code>已就绪</code>
          </div>
          <button
            className="counter"
            onClick={openFolder}
            disabled={!canOpenFolder}
            style={{ marginBottom: 0 }}
          >
            重新打开文件夹
          </button>
        </div>

        <div
          className="gridCanvas"
          style={{
            cursor: isRightDragging ? 'grabbing' : undefined,
            ['--grid-cell-font-size' as never]: `${gridCellFontSize}px`,
          }}
          ref={gridCanvasRef}
          onContextMenu={(e) => {
            e.preventDefault()
          }}
          onWheel={(e) => {
            e.preventDefault()

            if (e.ctrlKey) return

            const magnitude = Math.abs(e.deltaY)
            const sign = Math.sign(e.deltaY)
            if (magnitude === 0 || sign === 0) return
            const steps = sign * Math.max(1, Math.round(magnitude / 100))

            if (e.shiftKey) {
              panX(steps)
              return
            }

            panY(steps)
          }}
          onPointerDown={(e) => {
            if (e.button === 2) {
              e.preventDefault()
              const canvas = gridCanvasRef.current
              if (!canvas) return
              const rect = canvas.getBoundingClientRect()
              if (rect.width <= 0 || rect.height <= 0) return
              const baseCell = gridCellSizeRef.current
              const zoom = gridZoomRef.current
              const cellWidth = baseCell * zoom
              const cellHeight = baseCell * zoom
              if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight)) return

              rightDragRef.current = {
                active: true,
                pointerId: e.pointerId,
                startClientX: e.clientX,
                startClientY: e.clientY,
                startTopLeft: viewTopLeftRef.current,
                cursorAtStart: cursorRef.current,
                cellWidth,
                cellHeight,
              }
              setIsRightDragging(true)
              e.currentTarget.setPointerCapture(e.pointerId)
              return
            }

            if (e.button !== 0) return
            if (e.target === e.currentTarget) {
              e.preventDefault()
              focusInput()
            }
          }}
          onPointerMove={(e) => {
            const state = rightDragRef.current
            if (!state?.active || state.pointerId !== e.pointerId) return
            e.preventDefault()
            const dx = e.clientX - state.startClientX
            const dy = e.clientY - state.startClientY
            const stepX = dx / state.cellWidth
            const stepY = dy / state.cellHeight
            const next = { x: state.startTopLeft.x - stepX, y: state.startTopLeft.y - stepY }
            const baseCell = gridCellSizeRef.current
            const zoom = gridZoomRef.current
            const fracX = next.x - Math.floor(next.x)
            const fracY = next.y - Math.floor(next.y)
            setGridOffset({
              x: -fracX * baseCell * zoom,
              y: -fracY * baseCell * zoom,
            })
            viewTopLeftRef.current = next
            setViewTopLeft(next)
          }}
          onPointerUp={(e) => {
            const state = rightDragRef.current
            if (!state?.active || state.pointerId !== e.pointerId) return
            e.preventDefault()
            rightDragRef.current = null
            setIsRightDragging(false)
          }}
          onPointerCancel={(e) => {
            const state = rightDragRef.current
            if (!state?.active || state.pointerId !== e.pointerId) return
            e.preventDefault()
            rightDragRef.current = null
            setIsRightDragging(false)
          }}
        >
          <div
            className="gridCanvasInner"
            style={{
              width: gridRange.xs.length * gridCellSize,
              height: gridRange.ys.length * gridCellSize,
              gridTemplateColumns: `repeat(${gridRange.xs.length}, ${gridCellSize}px)`,
              gridTemplateRows: `repeat(${gridRange.ys.length}, ${gridCellSize}px)`,
              transform: `translate(${gridOffset.x}px, ${gridOffset.y}px) scale(${gridZoom})`,
            }}
          >
            {gridRange.ys.flatMap((y) =>
              gridRange.xs.map((x) => {
                const active = x === cursor.x && y === cursor.y
                const value = cells[cellKey(x, y)] ?? ''
                const isSpace = value === ' '
                const isNewline = value === '\n'
                const displayValue = isSpace ? 'ㆍ' : isNewline ? '↵' : value
                return (
                  <div
                    key={`${x},${y}`}
                    className={active ? 'gridCell gridCellActive' : 'gridCell'}
                    title={`(${x}, ${y})`}
                    onPointerDown={(e) => {
                      if (e.button !== 0) {
                        e.preventDefault()
                        return
                      }
                      e.preventDefault()
                      const next = { x, y }
                      setCursor(next)
                      cursorRef.current = next
                      focusInput()
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                    }}
                  >
                    {isSpace || isNewline ? (
                      <span className="gridCellMeta">{displayValue}</span>
                    ) : (
                      displayValue
                    )}
                  </div>
                )
              }),
            )}
          </div>
        </div>

      </div>
    )
  }

  return (
    <>
      <section id="center">
        <div>
          <h1>Rectangular Grid Editor</h1>
          <p>
            打开一个本地文件夹后使用，文件夹内包含文本、图片、子文件夹与{' '}
            <code>Element_position.json</code>
          </p>
        </div>
        <button
          className="counter"
          onClick={openFolder}
          disabled={!canOpenFolder || openFolderState.status === 'opening'}
        >
          {openFolderState.status === 'opening' ? '正在打开…' : '打开文件夹'}
        </button>

        {openFolderState.status === 'error' ? (
          <p>{openFolderState.message}</p>
        ) : null}
      </section>

      <div className="ticks"></div>

      <section id="next-steps">
        <div id="docs">
          <h2>项目文件约定</h2>
          <p>
            选中文件夹后，将递归读取全部文件句柄，并尝试解析根目录的{' '}
            <code>Element_position.json</code>。
          </p>
        </div>
        <div id="social">
          <h2>下一步</h2>
          <p>接下来可以把网格画布与文本文件渲染接到上述状态上。</p>
        </div>
      </section>

      <div className="ticks"></div>
      <section id="spacer"></section>
    </>
  )
}

export default App
