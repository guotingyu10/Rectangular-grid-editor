import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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

type TextBlock = {
  id: string
  fileName: string
  contentX: number
  contentY: number
  width: number
  height: number
}

type TextSelection = {
  anchor: { x: number; y: number }
  focus: { x: number; y: number }
}

function parseGridCoord(input: unknown): { x: number; y: number } | null {
  if (typeof input === 'string') {
    const raw = input.trim()
    const comma = raw.match(/^\(\s*(-?\d+)\s*[,，]\s*(-?\d+)\s*\)$/)
    if (comma) return { x: Number(comma[1]), y: Number(comma[2]) }
    const dot = raw.match(/^\(\s*(-?\d+)\s*\.\s*(-?\d+)\s*\)$/)
    if (dot) return { x: Number(dot[1]), y: Number(dot[2]) }
  }
  if (typeof input === 'object' && input !== null) {
    const v = input as { x?: unknown; y?: unknown }
    if (typeof v.x === 'number' && typeof v.y === 'number') return { x: v.x, y: v.y }
  }
  return null
}

function formatGridCoordDot(x: number, y: number): string {
  return `(${Math.trunc(x)}.${Math.trunc(y)})`
}

function normalizeElementPositionJsonToDotStringRecord(
  json: unknown,
): { json: Record<string, unknown>; changed: boolean } {
  const record: Record<string, unknown> = {}
  let changed = false

  if (typeof json !== 'object' || json === null) {
    return { json: record, changed: json !== record }
  }

  const maybe = json as { elements?: unknown }
  if (Array.isArray(maybe.elements)) {
    for (const el of maybe.elements) {
      if (typeof el !== 'object' || el === null) continue
      const v = el as { file?: unknown; path?: unknown; x?: unknown; y?: unknown }
      const fileName =
        typeof v.file === 'string' ? v.file : typeof v.path === 'string' ? v.path : null
      if (!fileName) continue
      if (typeof v.x === 'number' && typeof v.y === 'number') {
        record[fileName] = formatGridCoordDot(v.x, v.y)
        changed = true
      }
    }
    return { json: record, changed: true }
  }

  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    const coord = parseGridCoord(v)
    if (coord) {
      const next = formatGridCoordDot(coord.x, coord.y)
      record[k] = next
      if (v !== next) changed = true
    } else {
      record[k] = v
    }
  }
  return { json: record, changed }
}

function extractTextFilePositions(json: unknown): Array<{ fileName: string; x: number; y: number }> {
  const results: Array<{ fileName: string; x: number; y: number }> = []

  if (typeof json === 'object' && json !== null) {
    const maybe = json as { elements?: unknown }
    if (Array.isArray(maybe.elements)) {
      for (const el of maybe.elements) {
        if (typeof el !== 'object' || el === null) continue
        const v = el as { file?: unknown; path?: unknown; x?: unknown; y?: unknown; type?: unknown }
        const fileName =
          typeof v.file === 'string' ? v.file : typeof v.path === 'string' ? v.path : null
        if (!fileName || !fileName.toLowerCase().endsWith('.txt')) continue
        if (typeof v.x !== 'number' || typeof v.y !== 'number') continue
        results.push({ fileName, x: v.x, y: v.y })
      }
      return results
    }

    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
      if (!k.toLowerCase().endsWith('.txt')) continue
      const coord = parseGridCoord(v)
      if (!coord) continue
      results.push({ fileName: k, x: coord.x, y: coord.y })
    }
  }

  return results
}

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

  const initial = {}

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
  const [selection, setSelection] = useState<TextSelection | null>(null)
  const selectionRef = useRef(selection)
  const gridRootRef = useRef<HTMLDivElement | null>(null)
  const gridCanvasRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const composingRef = useRef(false)
  const [altHeld, setAltHeld] = useState(false)
  const altHeldRef = useRef(false)
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
  const blockDragRef = useRef<{
    active: boolean
    pointerId: number
    blockId: string
    startClientX: number
    startClientY: number
    lastDx: number
    lastDy: number
    cellWidth: number
    cellHeight: number
  } | null>(null)
  const rightButtonDownRef = useRef(false)
  const [isRightDragging, setIsRightDragging] = useState(false)
  const [isBlockDragging, setIsBlockDragging] = useState(false)
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
  const [textBlocks, setTextBlocks] = useState<TextBlock[]>([])
  const textBlocksRef = useRef(textBlocks)
  const dirtyTextBlockIdsRef = useRef<Set<string>>(new Set())
  const saveDirtyTextBlocksTimerRef = useRef<number | null>(null)
  const dirtyTextBlockRenameIdsRef = useRef<Set<string>>(new Set())
  const renameOriginalFileNamesRef = useRef<Map<string, string>>(new Map())
  const [hasPendingSaves, setHasPendingSaves] = useState(false)
  const [hasPendingRenames, setHasPendingRenames] = useState(false)
  const loadTextBlocksIdRef = useRef(0)
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

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return
      }
    } catch (err) {
      void err
    }

    const el = inputRef.current
    if (!el) return
    const prevValue = el.value
    const prevStart = el.selectionStart
    const prevEnd = el.selectionEnd
    el.value = text
    el.select()
    try {
      document.execCommand('copy')
    } catch (err) {
      void err
    }
    el.value = prevValue
    if (prevStart !== null && prevEnd !== null) el.setSelectionRange(prevStart, prevEnd)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' && e.code !== 'AltLeft' && e.code !== 'AltRight') return
      e.preventDefault()
      e.stopPropagation()
      if (altHeldRef.current) return
      altHeldRef.current = true
      setAltHeld(true)
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' && e.code !== 'AltLeft' && e.code !== 'AltRight') return
      e.preventDefault()
      e.stopPropagation()
      if (!altHeldRef.current) return
      altHeldRef.current = false
      setAltHeld(false)
    }

    const onBlur = () => {
      if (!altHeldRef.current) return
      altHeldRef.current = false
      setAltHeld(false)
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true } as AddEventListenerOptions)
      window.removeEventListener('keyup', onKeyUp, { capture: true } as AddEventListenerOptions)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const findTextBlockIndexAt = useCallback((x: number, y: number, blocks: TextBlock[]) => {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!
      if (y < b.contentY || y >= b.contentY + b.height) continue
      if (x < b.contentX) continue
      if (x >= b.contentX + b.width) continue
      return i
    }
    return -1
  }, [])

  const findTextBlockIndexAtFileNameRow = useCallback(
    (x: number, y: number, blocks: TextBlock[]) => {
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i]!
        if (y !== b.contentY - 1) continue
        if (x < b.contentX) continue
        if (x > b.contentX + b.fileName.length) continue
        return i
      }
      return -1
    },
    [],
  )

  const selectedTextBlockId = useMemo(() => {
    if (!altHeld) return null
    const idx = findTextBlockIndexAt(cursor.x, cursor.y, textBlocks)
    if (idx < 0) return null
    return textBlocks[idx]!.id
  }, [altHeld, cursor.x, cursor.y, findTextBlockIndexAt, textBlocks])

  const saveTextBlockToFile = useCallback(async (block: TextBlock) => {
    if (openFolderState.status !== 'ready') return
    const findFileHandle = (fileName: string) => {
      const byExact = openFolderState.files.find((f) => f.path === fileName)
      if (byExact) return byExact.handle
      const byTail = openFolderState.files.find((f) => f.path.endsWith(`/${fileName}`))
      if (byTail) return byTail.handle
      const lower = fileName.toLowerCase()
      const byExactLower = openFolderState.files.find((f) => f.path.toLowerCase() === lower)
      if (byExactLower) return byExactLower.handle
      const byTailLower = openFolderState.files.find((f) =>
        f.path.toLowerCase().endsWith(`/${lower}`),
      )
      if (byTailLower) return byTailLower.handle
      return null
    }

    const handle = findFileHandle(block.id)
    if (!handle) return

    const snapshotCells = cellsRef.current
    const lines: string[] = []
    for (let row = 0; row < block.height; row++) {
      let line = ''
      for (let col = 0; col < block.width; col++) {
        const v = snapshotCells[cellKey(block.contentX + col, block.contentY + row)]
        if (v === '\n') break
        line += v ?? ' '
      }
      line = line.replace(/ +$/g, '')
      lines.push(line)
    }
    const text = lines.join('\n')

    const writable = await handle.createWritable()
    await writable.write(text)
    await writable.close()
  }, [cellKey, openFolderState])

  const flushDirtyTextBlocks = useCallback(async () => {
    if (openFolderState.status !== 'ready') return
    if (dirtyTextBlockIdsRef.current.size === 0) return

    const ids = Array.from(dirtyTextBlockIdsRef.current)
    dirtyTextBlockIdsRef.current.clear()

    const blocks = textBlocksRef.current
    for (const id of ids) {
      const block = blocks.find((b) => b.id === id)
      if (!block) continue
      try {
        await saveTextBlockToFile(block)
      } catch {
        continue
      }
    }

    if (
      saveDirtyTextBlocksTimerRef.current === null &&
      dirtyTextBlockIdsRef.current.size === 0
    ) {
      setHasPendingSaves(false)
    }
  }, [openFolderState.status, saveTextBlockToFile])

  const markTextBlockDirty = useCallback(
    (blockId: string) => {
      dirtyTextBlockIdsRef.current.add(blockId)
      setHasPendingSaves(true)
      if (saveDirtyTextBlocksTimerRef.current !== null) {
        window.clearTimeout(saveDirtyTextBlocksTimerRef.current)
      }
      saveDirtyTextBlocksTimerRef.current = window.setTimeout(() => {
        saveDirtyTextBlocksTimerRef.current = null
        void flushDirtyTextBlocks()
      }, 300)
    },
    [flushDirtyTextBlocks],
  )

  const renameElementPositionJson = useCallback((json: unknown, oldName: string, newName: string) => {
    if (typeof json !== 'object' || json === null) return json
    const maybe = json as { elements?: unknown }
    if (Array.isArray(maybe.elements)) {
      let changed = false
      const nextElements = maybe.elements.map((el) => {
        if (typeof el !== 'object' || el === null) return el
        const v = el as { file?: unknown; path?: unknown }
        const next: { file?: unknown; path?: unknown } = { ...v }
        let localChanged = false
        if (typeof v.file === 'string' && v.file === oldName) {
          next.file = newName
          localChanged = true
        }
        if (typeof v.path === 'string' && v.path === oldName) {
          next.path = newName
          localChanged = true
        }
        if (!localChanged) return el
        changed = true
        return { ...(el as Record<string, unknown>), ...next }
      })
      if (!changed) return json
      return { ...(json as Record<string, unknown>), elements: nextElements }
    }

    const record = json as Record<string, unknown>
    if (!(oldName in record)) return json
    const next = { ...record }
    next[newName] = next[oldName]
    delete next[oldName]
    return next
  }, [])

  const flushDirtyTextBlockRenames = useCallback(async () => {
    if (openFolderState.status !== 'ready') return
    if (dirtyTextBlockRenameIdsRef.current.size === 0) return

    const ids = Array.from(dirtyTextBlockRenameIdsRef.current)
    dirtyTextBlockRenameIdsRef.current.clear()

    let nextFiles = openFolderState.files
    let nextElementJson = openFolderState.elementPositionJson
    let nextBlocks: TextBlock[] | null = null
    const nextCells: Record<string, string> = { ...cellsRef.current }
    let changedAny = false
    const stillDirty = new Set<string>()

    const getBlocks = () => nextBlocks ?? textBlocksRef.current
    const ensureBlocks = () => {
      if (nextBlocks) return nextBlocks
      nextBlocks = textBlocksRef.current.map((b) => ({ ...b }))
      return nextBlocks
    }

    for (const oldPath of ids) {
      const blocks = getBlocks()
      const idx = blocks.findIndex((b) => b.id === oldPath)
      if (idx < 0) continue
      const b = blocks[idx]!

      const oldSlash = oldPath.lastIndexOf('/')
      const oldDir = oldSlash >= 0 ? oldPath.slice(0, oldSlash) : ''
      const oldBase = oldSlash >= 0 ? oldPath.slice(oldSlash + 1) : oldPath

      const oldDisplayName = renameOriginalFileNamesRef.current.get(oldPath) ?? oldBase

      let desiredBase = b.fileName.split(/[\\/]/).pop() ?? ''
      desiredBase = desiredBase.trim()
      if (desiredBase.length === 0) {
        stillDirty.add(oldPath)
        continue
      }
      if (oldBase.toLowerCase().endsWith('.txt') && !desiredBase.toLowerCase().endsWith('.txt')) {
        desiredBase = `${desiredBase}.txt`
      }
      if (desiredBase.includes('/') || desiredBase.includes('\\')) {
        stillDirty.add(oldPath)
        continue
      }

      const newPath = oldDir ? `${oldDir}/${desiredBase}` : desiredBase
      if (newPath === oldPath) {
        const draft = ensureBlocks()
        draft[idx] = { ...draft[idx]!, fileName: desiredBase }
        nextElementJson = renameElementPositionJson(nextElementJson, oldDisplayName, desiredBase)
        const fileNameY = b.contentY - 1
        const startX = b.contentX
        const maxLen = Math.max(b.fileName.length, desiredBase.length)
        for (let i = 0; i < maxLen; i++) {
          const k = cellKey(startX + i, fileNameY)
          if (i < desiredBase.length) nextCells[k] = desiredBase[i]!
          else delete nextCells[k]
        }
        renameOriginalFileNamesRef.current.delete(oldPath)
        changedAny = true
        continue
      }

      if (nextFiles.some((f) => f.path === newPath)) {
        stillDirty.add(oldPath)
        continue
      }

      let dirHandle: FileSystemDirectoryHandle = openFolderState.directoryHandle
      if (oldDir) {
        for (const seg of oldDir.split('/').filter(Boolean)) {
          dirHandle = await (dirHandle as unknown as { getDirectoryHandle: (n: string) => Promise<FileSystemDirectoryHandle> }).getDirectoryHandle(seg)
        }
      }
      const dirApi = dirHandle as unknown as {
        getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FileSystemFileHandle>
        removeEntry: (name: string) => Promise<void>
      }

      let newHandle: FileSystemFileHandle
      try {
        newHandle = await dirApi.getFileHandle(desiredBase, { create: true })
      } catch {
        stillDirty.add(oldPath)
        continue
      }

      try {
        const snapshotCells = nextCells
        const lines: string[] = []
        for (let row = 0; row < b.height; row++) {
          let line = ''
          for (let col = 0; col < b.width; col++) {
            const v = snapshotCells[cellKey(b.contentX + col, b.contentY + row)]
            if (v === '\n') break
            line += v ?? ' '
          }
          line = line.replace(/ +$/g, '')
          lines.push(line)
        }
        const text = lines.join('\n')

        const writable = await newHandle.createWritable()
        await writable.write(text)
        await writable.close()

        await dirApi.removeEntry(oldBase)
      } catch {
        stillDirty.add(oldPath)
        continue
      }

      nextFiles = nextFiles.map((f) => (f.path === oldPath ? { path: newPath, handle: newHandle } : f))
      nextElementJson = renameElementPositionJson(nextElementJson, oldDisplayName, desiredBase)

      if (dirtyTextBlockIdsRef.current.has(oldPath)) {
        dirtyTextBlockIdsRef.current.delete(oldPath)
        dirtyTextBlockIdsRef.current.add(newPath)
      }

      const draft = ensureBlocks()
      draft[idx] = { ...draft[idx]!, id: newPath, fileName: desiredBase }

      const fileNameY = b.contentY - 1
      const startX = b.contentX
      const maxLen = Math.max(b.fileName.length, desiredBase.length)
      for (let i = 0; i < maxLen; i++) {
        const k = cellKey(startX + i, fileNameY)
        if (i < desiredBase.length) nextCells[k] = desiredBase[i]!
        else delete nextCells[k]
      }

      renameOriginalFileNamesRef.current.delete(oldPath)
      changedAny = true
    }

    if (changedAny) {
      try {
        await writeJsonFile(openFolderState.elementPositionFile, nextElementJson)
      } catch {
        void nextElementJson
      }

      setOpenFolderState({
        ...openFolderState,
        files: nextFiles,
        elementPositionJson: nextElementJson,
      })

      if (nextBlocks) {
        textBlocksRef.current = nextBlocks
        setTextBlocks(nextBlocks)
      }

      cellsRef.current = nextCells
      setCells(nextCells)
    }

    dirtyTextBlockRenameIdsRef.current = stillDirty
    setHasPendingRenames(stillDirty.size > 0)
  }, [cellKey, openFolderState, renameElementPositionJson])

  const markTextBlockRenameDirty = useCallback(
    (blockId: string) => {
      dirtyTextBlockRenameIdsRef.current.add(blockId)
      setHasPendingRenames(true)
    },
    [],
  )

  const parseTxtFileNameTokenAt = useCallback(
    (x: number, y: number, snapshot: Record<string, string>) => {
      const isTokenChar = (v: string | undefined) => v !== undefined && v !== ' ' && v !== '\n'

      const here = snapshot[cellKey(x, y)]
      let pivotX = x
      if (!isTokenChar(here)) {
        const left = snapshot[cellKey(x - 1, y)]
        if (!isTokenChar(left)) return null
        pivotX = x - 1
      }

      let startX = pivotX
      for (let sx = pivotX - 1; sx >= pivotX - 260; sx--) {
        const v = snapshot[cellKey(sx, y)]
        if (!isTokenChar(v)) break
        startX = sx
      }

      let endX = pivotX
      for (let sx = pivotX + 1; sx <= pivotX + 260; sx++) {
        const v = snapshot[cellKey(sx, y)]
        if (!isTokenChar(v)) break
        endX = sx
      }

      let name = ''
      for (let sx = startX; sx <= endX; sx++) {
        const v = snapshot[cellKey(sx, y)]
        if (!isTokenChar(v)) return null
        name += v
      }

      const trimmed = name.trim()
      if (trimmed.length === 0) return null
      if (trimmed.includes('/') || trimmed.includes('\\')) return null
      if (!trimmed.toLowerCase().endsWith('.txt')) return null
      return { fileName: trimmed, startX }
    },
    [cellKey],
  )

  const upsertTextFilePosition = useCallback(
    (
      json: unknown,
      fileName: string,
      x: number,
      y: number,
    ): { json: unknown; changed: boolean } => {
      const normalized = normalizeElementPositionJsonToDotStringRecord(json)
      const next = formatGridCoordDot(x, y)
      const prev = normalized.json[fileName]
      if (prev === next && !normalized.changed) return { json, changed: false }
      return { json: { ...normalized.json, [fileName]: next }, changed: true }
    },
    [],
  )

  const createTextFileAt = useCallback(
    async (
      fileName: string,
      fileNameX: number,
      fileNameY: number,
      options?: { focusCursor?: boolean },
    ) => {
      if (openFolderState.status !== 'ready') return
      await flushDirtyTextBlockRenames()
      await flushDirtyTextBlocks()

      const lower = fileName.toLowerCase()
      const alreadyInFiles = openFolderState.files.some((f) => f.path.toLowerCase() === lower)

      const dirApi = openFolderState.directoryHandle as unknown as {
        getFileHandle: (
          name: string,
          options?: { create?: boolean },
        ) => Promise<FileSystemFileHandle>
      }

      let existed = true
      let handle: FileSystemFileHandle
      try {
        handle = await dirApi.getFileHandle(fileName)
      } catch {
        existed = false
        handle = await dirApi.getFileHandle(fileName, { create: true })
      }

      if (!existed) {
        const writable = await handle.createWritable()
        await writable.write(' ')
        await writable.close()
      }

      const upserted = upsertTextFilePosition(
        openFolderState.elementPositionJson,
        fileName,
        fileNameX,
        fileNameY,
      )
      if (upserted.changed) {
        await writeJsonFile(openFolderState.elementPositionFile, upserted.json)
      }

      const nextFiles = alreadyInFiles
        ? openFolderState.files
        : [...openFolderState.files, { path: fileName, handle }]

      setOpenFolderState({
        ...openFolderState,
        files: nextFiles,
        elementPositionJson: upserted.json,
      })

      if (options?.focusCursor !== false) {
        const nextCursor = { x: fileNameX, y: fileNameY + 1 }
        cursorRef.current = nextCursor
        setCursor(nextCursor)
      }
    },
    [
      flushDirtyTextBlocks,
      flushDirtyTextBlockRenames,
      openFolderState,
      upsertTextFilePosition,
    ],
  )

  const maybeCreateTextFileFromTokenAt = useCallback(
    (pos: { x: number; y: number }) => {
      if (openFolderState.status !== 'ready') return
      const blocks = textBlocksRef.current
      if (findTextBlockIndexAt(pos.x, pos.y, blocks) >= 0) return
      if (findTextBlockIndexAtFileNameRow(pos.x, pos.y, blocks) >= 0) return
      const parsed = parseTxtFileNameTokenAt(pos.x, pos.y, cellsRef.current)
      if (!parsed) return
      void createTextFileAt(parsed.fileName, parsed.startX, pos.y, { focusCursor: false })
    },
    [
      createTextFileAt,
      findTextBlockIndexAt,
      findTextBlockIndexAtFileNameRow,
      openFolderState.status,
      parseTxtFileNameTokenAt,
    ],
  )

  const moveTextBlockBy = useCallback(
    (blockId: string, dx: number, dy: number) => {
      if (dx === 0 && dy === 0) return
      const blocks = textBlocksRef.current
      const idx = blocks.findIndex((b) => b.id === blockId)
      if (idx < 0) return
      const b = blocks[idx]!

      const snapshot = cellsRef.current
      const nextCells: Record<string, string> = { ...snapshot }
      const moved: Array<{ x: number; y: number; v: string }> = []

      const fileNameY = b.contentY - 1
      for (let i = 0; i < b.fileName.length; i++) {
        const x = b.contentX + i
        const k = cellKey(x, fileNameY)
        const v = snapshot[k]
        if (v !== undefined) moved.push({ x, y: fileNameY, v })
      }

      for (let row = 0; row < b.height; row++) {
        const y = b.contentY + row
        for (let col = 0; col < b.width; col++) {
          const x = b.contentX + col
          const k = cellKey(x, y)
          const v = snapshot[k]
          if (v !== undefined) moved.push({ x, y, v })
        }
      }

      for (const p of moved) {
        delete nextCells[cellKey(p.x, p.y)]
      }
      for (const p of moved) {
        nextCells[cellKey(p.x + dx, p.y + dy)] = p.v
      }

      const nextBlocks = blocks.map((bb, i) =>
        i === idx ? { ...bb, contentX: bb.contentX + dx, contentY: bb.contentY + dy } : bb,
      )
      textBlocksRef.current = nextBlocks
      setTextBlocks(nextBlocks)
      cellsRef.current = nextCells
      setCells(nextCells)

      const cursorPos = cursorRef.current
      const maxRowWidth = Math.max(b.width, b.fileName.length)
      const inFileRow =
        cursorPos.y === fileNameY &&
        cursorPos.x >= b.contentX &&
        cursorPos.x < b.contentX + maxRowWidth
      const inContent =
        cursorPos.y >= b.contentY &&
        cursorPos.y < b.contentY + b.height &&
        cursorPos.x >= b.contentX &&
        cursorPos.x < b.contentX + b.width
      if (inFileRow || inContent) {
        const nextCursor = { x: cursorPos.x + dx, y: cursorPos.y + dy }
        cursorRef.current = nextCursor
        setCursor(nextCursor)
      }

      const sel = selectionRef.current
      if (sel) {
        const inside = (p: { x: number; y: number }) => {
          if (p.y === fileNameY) return p.x >= b.contentX && p.x < b.contentX + maxRowWidth
          if (p.y < b.contentY || p.y >= b.contentY + b.height) return false
          return p.x >= b.contentX && p.x < b.contentX + b.width
        }
        if (inside(sel.anchor) && inside(sel.focus)) {
          setSelection({
            anchor: { x: sel.anchor.x + dx, y: sel.anchor.y + dy },
            focus: { x: sel.focus.x + dx, y: sel.focus.y + dy },
          })
        }
      }
    },
    [cellKey],
  )

  const persistTextBlockPosition = useCallback(
    async (blockId: string) => {
      if (openFolderState.status !== 'ready') return
      const b = textBlocksRef.current.find((bb) => bb.id === blockId)
      if (!b) return
      const upserted = upsertTextFilePosition(
        openFolderState.elementPositionJson,
        b.fileName,
        b.contentX,
        b.contentY - 1,
      )
      if (!upserted.changed) return
      try {
        await writeJsonFile(openFolderState.elementPositionFile, upserted.json)
      } catch {
        return
      }
      setOpenFolderState({ ...openFolderState, elementPositionJson: upserted.json })
    },
    [openFolderState, upsertTextFilePosition],
  )

  const applyInsertedText = useCallback(
    (rawValue: string) => {
      const value = rawValue.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
      if (value.length === 0) return

      let nextCursor = cursorRef.current
      const nextCells: Record<string, string> = { ...cellsRef.current }

      const baseBlocks = textBlocksRef.current
      let nextBlocks: TextBlock[] | null = null

      const getBlocks = () => nextBlocks ?? baseBlocks
      const ensureBlocks = () => {
        if (nextBlocks) return nextBlocks
        nextBlocks = baseBlocks.map((b) => ({ ...b }))
        return nextBlocks
      }

      for (const ch of value) {
        if (ch === '\n') {
          const x = nextCursor.x
          const y = nextCursor.y
          const blockIndex = findTextBlockIndexAt(x, y, getBlocks())
          if (blockIndex >= 0) {
            const blocks = getBlocks()
            const b = blocks[blockIndex]!
            markTextBlockDirty(b.id)

            const minX = b.contentX
            let insertX = x
            if (insertX < minX) insertX = minX

            let width = b.width
            const requiredWidthForInsert = insertX - minX + 1
            if (requiredWidthForInsert > width) {
              const draft = ensureBlocks()
              draft[blockIndex] = { ...draft[blockIndex]!, width: requiredWidthForInsert }
              width = requiredWidthForInsert
            }

            const maxX = minX + width - 1
            let newlineX = -1
            for (let sx = minX; sx <= maxX; sx++) {
              if (nextCells[cellKey(sx, y)] === '\n') {
                newlineX = sx
                break
              }
            }
            if (newlineX >= 0 && insertX > newlineX) insertX = newlineX

            const scanEnd = newlineX >= 0 ? newlineX : maxX + 1
            let tailEnd = insertX
            for (let sx = scanEnd - 1; sx >= insertX; sx--) {
              const v = nextCells[cellKey(sx, y)]
              if (v !== undefined && v !== '\n') {
                tailEnd = sx + 1
                break
              }
            }
            const tailLen = tailEnd - insertX
            const tailVals: Array<string | undefined> = []
            for (let i = 0; i < tailLen; i++) {
              tailVals.push(nextCells[cellKey(insertX + i, y)])
            }

            const requiredWidthForTail = Math.max(
              width,
              tailVals.length + (newlineX >= 0 ? 1 : 0),
            )
            if (requiredWidthForTail > width) {
              const draft = ensureBlocks()
              draft[blockIndex] = { ...draft[blockIndex]!, width: requiredWidthForTail }
              width = requiredWidthForTail
            }

            for (let sx = insertX; sx < scanEnd; sx++) {
              delete nextCells[cellKey(sx, y)]
            }
            if (newlineX >= 0) delete nextCells[cellKey(newlineX, y)]
            nextCells[cellKey(insertX, y)] = '\n'
            for (let sx = minX; sx <= minX + width - 1; sx++) {
              if (sx !== insertX && nextCells[cellKey(sx, y)] === '\n') {
                delete nextCells[cellKey(sx, y)]
              }
            }

            const insertRowY = y + 1
            const oldHeight = b.height
            const nextHeight = oldHeight + 1
            const draft = ensureBlocks()
            draft[blockIndex] = { ...draft[blockIndex]!, height: nextHeight, width }

            for (let rel = oldHeight - 1; rel >= insertRowY - b.contentY; rel--) {
              const fromY = b.contentY + rel
              const toY = fromY + 1
              for (let col = 0; col < width; col++) {
                const cellX = minX + col
                const srcKey = cellKey(cellX, fromY)
                const destKey = cellKey(cellX, toY)
                const v = nextCells[srcKey]
                if (v === undefined) delete nextCells[destKey]
                else nextCells[destKey] = v
              }
            }

            for (let col = 0; col < width; col++) {
              delete nextCells[cellKey(minX + col, insertRowY)]
            }
            for (let i = 0; i < tailVals.length; i++) {
              const v = tailVals[i]
              const k = cellKey(minX + i, insertRowY)
              if (v === undefined) delete nextCells[k]
              else nextCells[k] = v
            }
            if (newlineX >= 0) {
              nextCells[cellKey(minX + tailVals.length, insertRowY)] = '\n'
            }

            nextCursor = { x: b.contentX, y: insertRowY }
          } else {
            nextCells[cellKey(x, y)] = '\n'
            nextCursor = { x: 0, y: y + 1 }
          }
          continue
        }

        const x = nextCursor.x
        const y = nextCursor.y
        const fileNameIndex = findTextBlockIndexAtFileNameRow(x, y, getBlocks())
        if (fileNameIndex >= 0) {
          const blocks = getBlocks()
          const b = blocks[fileNameIndex]!
          const oldName = b.fileName
          if (!renameOriginalFileNamesRef.current.has(b.id)) {
            renameOriginalFileNamesRef.current.set(b.id, oldName)
          }
          const startX = b.contentX
          const insertAtRaw = x - startX
          const insertAt = Math.max(0, Math.min(oldName.length, insertAtRaw))
          const newName = `${oldName.slice(0, insertAt)}${ch}${oldName.slice(insertAt)}`

          const draft = ensureBlocks()
          draft[fileNameIndex] = { ...draft[fileNameIndex]!, fileName: newName }

          const maxLen = Math.max(oldName.length, newName.length)
          for (let i = 0; i < maxLen; i++) {
            const k = cellKey(startX + i, y)
            if (i < newName.length) nextCells[k] = newName[i]!
            else delete nextCells[k]
          }

          markTextBlockRenameDirty(b.id)
          nextCursor = { x: x + 1, y }
          continue
        }

        const blockIndex = findTextBlockIndexAt(x, y, getBlocks())
        let relocateNewline = false
        if (blockIndex >= 0) {
          const blocks = getBlocks()
          const b = blocks[blockIndex]!
          markTextBlockDirty(b.id)
          const minX = b.contentX
          const maxX = b.contentX + b.width - 1

          let newlineX = -1
          for (let sx = minX; sx <= maxX; sx++) {
            if (nextCells[cellKey(sx, y)] === '\n') {
              newlineX = sx
              break
            }
          }

          if (newlineX >= 0 && x > newlineX) {
            relocateNewline = true
            delete nextCells[cellKey(newlineX, y)]
            for (let sx = newlineX; sx < x; sx++) {
              const k = cellKey(sx, y)
              if (nextCells[k] === undefined) nextCells[k] = ' '
            }
          }

          let endX = minX - 1
          for (let sx = maxX; sx >= minX; sx--) {
            const v = nextCells[cellKey(sx, y)]
            if (v !== undefined) {
              endX = sx
              break
            }
          }

          const shouldShift = endX >= x
          let nextWidth = b.width
          if (x >= b.contentX + b.width) nextWidth = Math.max(nextWidth, x - b.contentX + 1)
          if (shouldShift) nextWidth = Math.max(nextWidth, endX - b.contentX + 2)

          if (nextWidth !== b.width) {
            const draft = ensureBlocks()
            draft[blockIndex] = { ...draft[blockIndex]!, width: nextWidth }
          }

          if (shouldShift) {
            for (let sx = endX; sx >= x; sx--) {
              const srcKey = cellKey(sx, y)
              const destKey = cellKey(sx + 1, y)
              const v = nextCells[srcKey]
              if (v === undefined) delete nextCells[destKey]
              else nextCells[destKey] = v
            }
          }
        }

        nextCells[cellKey(x, y)] = ch

        if (relocateNewline) {
          const blocks = getBlocks()
          const b = blocks[blockIndex]!
          const minX = b.contentX

          let currentWidth = b.width
          let rowMaxX = minX + currentWidth - 1

          let lastNonNewlineX = minX - 1
          for (let sx = rowMaxX; sx >= minX; sx--) {
            const v = nextCells[cellKey(sx, y)]
            if (v === '\n') continue
            if (v !== undefined) {
              lastNonNewlineX = sx
              break
            }
          }

          const newlinePos = Math.max(minX, lastNonNewlineX + 1)
          const requiredWidth = newlinePos - minX + 1
          if (requiredWidth > currentWidth) {
            const draft = ensureBlocks()
            draft[blockIndex] = { ...draft[blockIndex]!, width: requiredWidth }
            currentWidth = requiredWidth
            rowMaxX = minX + currentWidth - 1
          }

          for (let sx = minX; sx <= rowMaxX; sx++) {
            if (nextCells[cellKey(sx, y)] === '\n') {
              delete nextCells[cellKey(sx, y)]
            }
          }
          nextCells[cellKey(newlinePos, y)] = '\n'
        }

        nextCursor = { x: x + 1, y }
      }

      cellsRef.current = nextCells
      cursorRef.current = nextCursor
      setCells(nextCells)
      setCursor(nextCursor)

      if (nextBlocks) {
        textBlocksRef.current = nextBlocks
        setTextBlocks(nextBlocks)
      }
    },
    [cellKey, findTextBlockIndexAt, findTextBlockIndexAtFileNameRow, markTextBlockDirty, markTextBlockRenameDirty],
  )

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
      setTextBlocks([])
      dirtyTextBlockIdsRef.current.clear()
      if (saveDirtyTextBlocksTimerRef.current !== null) {
        window.clearTimeout(saveDirtyTextBlocksTimerRef.current)
        saveDirtyTextBlocksTimerRef.current = null
      }
      dirtyTextBlockRenameIdsRef.current.clear()
      renameOriginalFileNamesRef.current.clear()
      setHasPendingSaves(false)
      setHasPendingRenames(false)
      const directoryHandle = await (
        window as unknown as {
          showDirectoryPicker: (options?: {
            mode?: 'read' | 'readwrite'
          }) => Promise<FileSystemDirectoryHandle>
        }
      ).showDirectoryPicker({ mode: 'readwrite' })

      const files = await listFilesRecursively(directoryHandle, '')
      const ensured = await ensureElementPositionJsonFile(directoryHandle)
      const normalized = normalizeElementPositionJsonToDotStringRecord(ensured.json)
      if (normalized.changed) {
        await writeJsonFile(ensured.fileHandle, normalized.json)
      }
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
        elementPositionJson: normalized.changed ? normalized.json : ensured.json,
      })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : '打开文件夹失败（未知错误）'
      setOpenFolderState({ status: 'error', message })
    }
  }, [])

  useEffect(() => {
    if (openFolderState.status !== 'ready') return

    const id = ++loadTextBlocksIdRef.current
    const { files, elementPositionJson } = openFolderState

    const findTextFileHandle = (fileName: string) => {
      const byExact = files.find((f) => f.path === fileName)
      if (byExact) return byExact
      const byTail = files.find((f) => f.path.endsWith(`/${fileName}`))
      if (byTail) return byTail
      const lower = fileName.toLowerCase()
      const byExactLower = files.find((f) => f.path.toLowerCase() === lower)
      if (byExactLower) return byExactLower
      const byTailLower = files.find((f) => f.path.toLowerCase().endsWith(`/${lower}`))
      if (byTailLower) return byTailLower
      return null
    }

    ;(async () => {
      const positions = extractTextFilePositions(elementPositionJson)
      if (positions.length === 0) return

      const nextCells: Record<string, string> = {}
      const nextBlocks: TextBlock[] = []

      for (const pos of positions) {
        const name = pos.fileName
        const fileNameX = pos.x
        const fileNameY = pos.y
        for (let i = 0; i < name.length; i++) {
          nextCells[cellKey(fileNameX + i, fileNameY)] = name[i]
        }

        const entry = findTextFileHandle(name)
        if (!entry) continue

        let text = ''
        try {
          text = await (await entry.handle.getFile()).text()
        } catch {
          continue
        }

        const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
        const contentX = pos.x
        const contentY = pos.y + 1
        const height = Math.max(1, lines.length)
        let width = 1
        for (let row = 0; row < lines.length; row++) {
          const line = lines[row] ?? ''
          const hasNewlineCell = row < lines.length - 1
          width = Math.max(width, line.length + (hasNewlineCell ? 1 : 0))
        }

        for (let row = 0; row < lines.length; row++) {
          const line = lines[row] ?? ''
          for (let col = 0; col < line.length; col++) {
            nextCells[cellKey(contentX + col, contentY + row)] = line[col]
          }
          if (row < lines.length - 1) {
            nextCells[cellKey(contentX + line.length, contentY + row)] = '\n'
          }
        }

        nextBlocks.push({
          id: entry.path,
          fileName: name,
          contentX,
          contentY,
          width,
          height,
        })
      }

      if (loadTextBlocksIdRef.current !== id) return
      cellsRef.current = nextCells
      textBlocksRef.current = nextBlocks
      setCells(nextCells)
      setTextBlocks(nextBlocks)
    })()
  }, [cellKey, openFolderState])

  useEffect(() => {
    viewTopLeftRef.current = viewTopLeft
  }, [viewTopLeft])

  useEffect(() => {
    cursorRef.current = cursor
  }, [cursor])

  useEffect(() => {
    selectionRef.current = selection
  }, [selection])

  useEffect(() => {
    cellsRef.current = cells
  }, [cells])

  useEffect(() => {
    textBlocksRef.current = textBlocks
  }, [textBlocks])

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

  const selectedCellKeys = useMemo(() => {
    if (!selection) return new Set<string>()

    const blocks = textBlocks
    const idxA = findTextBlockIndexAt(selection.anchor.x, selection.anchor.y, blocks)
    const idxB = findTextBlockIndexAt(selection.focus.x, selection.focus.y, blocks)
    const set = new Set<string>()

    if (idxA >= 0 && idxA === idxB) {
      const b = blocks[idxA]!
      const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
      const normalize = (p: { x: number; y: number }) => ({
        x: clamp(p.x, b.contentX, b.contentX + b.width - 1),
        y: clamp(p.y, b.contentY, b.contentY + b.height - 1),
      })

      const a = normalize(selection.anchor)
      const f = normalize(selection.focus)

      const toIndex = (p: { x: number; y: number }) =>
        (p.y - b.contentY) * b.width + (p.x - b.contentX)
      let start = toIndex(a)
      let end = toIndex(f)
      if (start > end) [start, end] = [end, start]

      for (let i = start; i <= end; i++) {
        const y = b.contentY + Math.floor(i / b.width)
        const x = b.contentX + (i % b.width)
        set.add(cellKey(x, y))
      }
      return set
    }

    const minX = Math.min(selection.anchor.x, selection.focus.x)
    const maxX = Math.max(selection.anchor.x, selection.focus.x)
    const minY = Math.min(selection.anchor.y, selection.focus.y)
    const maxY = Math.max(selection.anchor.y, selection.focus.y)
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        set.add(cellKey(x, y))
      }
    }
    return set
  }, [cellKey, findTextBlockIndexAt, selection, textBlocks])

  useEffect(() => {
    if (openFolderState.status !== 'ready') return
    const id = requestAnimationFrame(() => focusInput())
    return () => cancelAnimationFrame(id)
  }, [focusInput, openFolderState.status])

  useEffect(() => {
    if (openFolderState.status === 'ready') return
    dirtyTextBlockIdsRef.current.clear()
    if (saveDirtyTextBlocksTimerRef.current !== null) {
      window.clearTimeout(saveDirtyTextBlocksTimerRef.current)
      saveDirtyTextBlocksTimerRef.current = null
    }
  }, [openFolderState.status])

  const gridRange = useMemo(() => {
    const baseX = Math.floor(viewTopLeft.x)
    const baseY = Math.floor(viewTopLeft.y)
    const xs = Array.from({ length: gridSize.cols }, (_, i) => baseX + i)
    const ys = Array.from({ length: gridSize.rows }, (_, i) => baseY + i)
    return { xs, ys }
  }, [gridSize.cols, gridSize.rows, viewTopLeft.x, viewTopLeft.y])

  /**
   * 文本文件虚线边框的渲染策略（按用户要求）：
   * - 不再在 gridCanvasInner 上叠加一个“整体的边框 div”，因为叠加层会干扰网格线观感，并且也无法作为可选中的网格元素。
   * - 改为“借用周围网格本身的外边框”来显示文本内容区域的虚线框：
   *   - 顶边：用“文件名所在行”的 border-bottom 来画（它正好位于内容区域上方）
   *   - 左边：用“内容区域左侧一列”的 border-right 来画
   *   - 右边：用“内容区域最右一列”的 border-right 来画
   *   - 底边：用“内容区域最下行”的 border-bottom 来画
   *
   * 这样虚线边框完全是网格单元格边框的一部分：
   * - 不会抢占指针事件（点击/拖拽依旧由格子本身处理）
   * - 不会遮挡网格线（没有额外叠加层去覆盖线条/文字）
   */
  const textBorderSets = useMemo(() => {
    const dashedRight = new Set<string>()
    const dashedBottom = new Set<string>()

    for (const b of textBlocks) {
      const minX = b.contentX
      const maxX = b.contentX + b.width - 1
      const minY = b.contentY
      const maxY = b.contentY + b.height - 1

      for (let x = minX; x <= maxX; x++) {
        dashedBottom.add(cellKey(x, minY - 1))
        dashedBottom.add(cellKey(x, maxY))
      }

      for (let y = minY; y <= maxY; y++) {
        dashedRight.add(cellKey(minX - 1, y))
        dashedRight.add(cellKey(maxX, y))
      }
    }

    return { dashedRight, dashedBottom }
  }, [cellKey, textBlocks])

  const selectedTextBorderSets = useMemo(() => {
    if (!selectedTextBlockId) return null
    const b = textBlocks.find((bb) => bb.id === selectedTextBlockId)
    if (!b) return null
    const dashedRight = new Set<string>()
    const dashedBottom = new Set<string>()

    const minX = b.contentX
    const maxX = b.contentX + b.width - 1
    const minY = b.contentY
    const maxY = b.contentY + b.height - 1

    for (let x = minX; x <= maxX; x++) {
      dashedBottom.add(cellKey(x, minY - 1))
      dashedBottom.add(cellKey(x, maxY))
    }

    for (let y = minY; y <= maxY; y++) {
      dashedRight.add(cellKey(minX - 1, y))
      dashedRight.add(cellKey(maxX, y))
    }

    return { dashedRight, dashedBottom }
  }, [cellKey, selectedTextBlockId, textBlocks])

  const zoomByFactor = useCallback((factor: number) => {
    if (!Number.isFinite(factor) || factor === 1) return
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

    const nextZoom = Math.max(0.25, Math.min(4, oldZoom * factor))
    if (nextZoom === oldZoom) return
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
  }, [])

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
      const rightHeld =
        rightButtonDownRef.current ||
        ((e as unknown as { buttons?: number }).buttons ?? 0) === 2 ||
        (((e as unknown as { buttons?: number }).buttons ?? 0) & 2) === 2
      if (!e.ctrlKey && !rightHeld) return
      e.preventDefault()
      const raw = e.deltaY
      if (raw === 0) return
      const factor = Math.pow(1.12, -raw / 100)
      zoomByFactor(factor)
    }

    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => {
      window.removeEventListener('wheel', onWheel, true)
    }
  }, [openFolderState.status, zoomByFactor])

  useEffect(() => {
    if (openFolderState.status !== 'ready') return

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return

      const key = e.key
      const code = e.code

      if (key === '+' || key === '=' || code === 'NumpadAdd') {
        e.preventDefault()
        e.stopPropagation()
        zoomByFactor(1.12)
        return
      }
      if (key === '-' || key === '_' || code === 'NumpadSubtract') {
        e.preventDefault()
        e.stopPropagation()
        zoomByFactor(1 / 1.12)
        return
      }

      if (key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        panY(-1)
        return
      }
      if (key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        panY(1)
        return
      }
      if (key === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        panX(-1)
        return
      }
      if (key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        panX(1)
        return
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [openFolderState.status, panX, panY, zoomByFactor])

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
            applyInsertedText(value)
          }}
          onInput={(e) => {
            if (composingRef.current) return
            const value = e.currentTarget.value
            if (value.length === 0) return

            e.currentTarget.value = ''
            applyInsertedText(value)
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || composingRef.current) return
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
              e.preventDefault()
              const cells = cellsRef.current
              const selKeys = selectedCellKeys
              const sel = selectionRef.current
              if (sel && selKeys.size > 0) {
                const minX = Math.min(sel.anchor.x, sel.focus.x)
                const maxX = Math.max(sel.anchor.x, sel.focus.x)
                const minY = Math.min(sel.anchor.y, sel.focus.y)
                const maxY = Math.max(sel.anchor.y, sel.focus.y)
                const lines: string[] = []
                for (let y = minY; y <= maxY; y++) {
                  let rowFirst: number | null = null
                  let rowLast: number | null = null
                  for (let x = minX; x <= maxX; x++) {
                    if (!selKeys.has(cellKey(x, y))) continue
                    if (rowFirst === null) rowFirst = x
                    rowLast = x
                  }
                  if (rowFirst === null || rowLast === null) continue
                  let s = ''
                  for (let x = rowFirst; x <= rowLast; x++) {
                    if (!selKeys.has(cellKey(x, y))) {
                      s += ' '
                      continue
                    }
                    const v = cells[cellKey(x, y)]
                    if (v === '\n') continue
                    s += v ?? ' '
                  }
                  lines.push(s.replace(/\s+$/u, ''))
                }
                void copyToClipboard(lines.join('\n'))
                return
              }

              const cur = cursorRef.current
              const blocks = textBlocksRef.current
              const idx = findTextBlockIndexAt(cur.x, cur.y, blocks)
              if (idx >= 0) {
                const b = blocks[idx]!
                let s = ''
                for (let x = b.contentX; x <= b.contentX + b.width - 1; x++) {
                  const v = cells[cellKey(x, cur.y)]
                  if (v === '\n') break
                  s += v ?? ' '
                }
                void copyToClipboard(s.replace(/\s+$/u, ''))
              }
              return
            }

            if (e.ctrlKey || e.metaKey) return

            const current = cursorRef.current
            const isArrow =
              e.key === 'ArrowUp' ||
              e.key === 'ArrowDown' ||
              e.key === 'ArrowLeft' ||
              e.key === 'ArrowRight'

            if (e.altKey && isArrow) {
              e.preventDefault()
              if (selectionRef.current) setSelection(null)
              const blocks = textBlocksRef.current
              const idx = findTextBlockIndexAt(current.x, current.y, blocks)
              if (idx < 0) return
              const b = blocks[idx]!
              const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
              const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
              moveTextBlockBy(b.id, dx, dy)
              void persistTextBlockPosition(b.id)
              return
            }

            if (e.altKey) return

            if (isArrow && e.shiftKey) {
              e.preventDefault()
              const next =
                e.key === 'ArrowUp'
                  ? { x: current.x, y: current.y - 1 }
                  : e.key === 'ArrowDown'
                    ? { x: current.x, y: current.y + 1 }
                    : e.key === 'ArrowLeft'
                      ? { x: current.x - 1, y: current.y }
                      : { x: current.x + 1, y: current.y }

              cursorRef.current = next
              setCursor(next)
              const anchor = selectionRef.current?.anchor ?? current
              setSelection({ anchor, focus: next })
              return
            }

            if (e.key === 'ArrowUp') {
              e.preventDefault()
              if (selectionRef.current) setSelection(null)
              maybeCreateTextFileFromTokenAt(current)
              if (hasPendingRenames) {
                const blocks = textBlocksRef.current
                const idx = findTextBlockIndexAtFileNameRow(current.x, current.y, blocks)
                if (idx >= 0) {
                  const next = { x: current.x, y: current.y - 1 }
                  const nextIdx = findTextBlockIndexAtFileNameRow(next.x, next.y, blocks)
                  if (nextIdx < 0) void flushDirtyTextBlockRenames()
                }
              }
              const next = { x: current.x, y: current.y - 1 }
              cursorRef.current = next
              setCursor(next)
              return
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              if (selectionRef.current) setSelection(null)
              maybeCreateTextFileFromTokenAt(current)
              if (hasPendingRenames) {
                const blocks = textBlocksRef.current
                const idx = findTextBlockIndexAtFileNameRow(current.x, current.y, blocks)
                if (idx >= 0) {
                  const next = { x: current.x, y: current.y + 1 }
                  const nextIdx = findTextBlockIndexAtFileNameRow(next.x, next.y, blocks)
                  if (nextIdx < 0) void flushDirtyTextBlockRenames()
                }
              }
              const next = { x: current.x, y: current.y + 1 }
              cursorRef.current = next
              setCursor(next)
              return
            }
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              if (selectionRef.current) setSelection(null)
              maybeCreateTextFileFromTokenAt(current)
              if (hasPendingRenames) {
                const blocks = textBlocksRef.current
                const idx = findTextBlockIndexAtFileNameRow(current.x, current.y, blocks)
                if (idx >= 0) {
                  const next = { x: current.x - 1, y: current.y }
                  const nextIdx = findTextBlockIndexAtFileNameRow(next.x, next.y, blocks)
                  if (nextIdx < 0) void flushDirtyTextBlockRenames()
                }
              }
              const next = { x: current.x - 1, y: current.y }
              cursorRef.current = next
              setCursor(next)
              return
            }
            if (e.key === 'ArrowRight') {
              e.preventDefault()
              if (selectionRef.current) setSelection(null)
              maybeCreateTextFileFromTokenAt(current)
              if (hasPendingRenames) {
                const blocks = textBlocksRef.current
                const idx = findTextBlockIndexAtFileNameRow(current.x, current.y, blocks)
                if (idx >= 0) {
                  const next = { x: current.x + 1, y: current.y }
                  const nextIdx = findTextBlockIndexAtFileNameRow(next.x, next.y, blocks)
                  if (nextIdx < 0) void flushDirtyTextBlockRenames()
                }
              }
              const next = { x: current.x + 1, y: current.y }
              cursorRef.current = next
              setCursor(next)
              return
            }
            if (e.key === 'Backspace') {
              e.preventDefault()
              const nextCells = { ...cellsRef.current }
              const blocks = textBlocksRef.current
              const idxFileName = findTextBlockIndexAtFileNameRow(current.x, current.y, blocks)
              if (idxFileName >= 0) {
                if (selectionRef.current) setSelection(null)
                const b = blocks[idxFileName]!
                const startX = b.contentX
                const removeAt = current.x - startX - 1
                if (removeAt < 0 || removeAt >= b.fileName.length) return
                const oldName = b.fileName
                if (!renameOriginalFileNamesRef.current.has(b.id)) {
                  renameOriginalFileNamesRef.current.set(b.id, oldName)
                }
                const newName = `${oldName.slice(0, removeAt)}${oldName.slice(removeAt + 1)}`
                const nextBlocks = blocks.map((bb, i) =>
                  i === idxFileName ? { ...bb, fileName: newName } : bb,
                )
                textBlocksRef.current = nextBlocks
                setTextBlocks(nextBlocks)
                const maxLen = Math.max(oldName.length, newName.length)
                for (let i = 0; i < maxLen; i++) {
                  const k = cellKey(startX + i, current.y)
                  if (i < newName.length) nextCells[k] = newName[i]!
                  else delete nextCells[k]
                }
                markTextBlockRenameDirty(b.id)
                const nextCursor = { x: current.x - 1, y: current.y }
                cellsRef.current = nextCells
                cursorRef.current = nextCursor
                setCells(nextCells)
                setCursor(nextCursor)
                return
              }
              const idxAtCursor = findTextBlockIndexAt(current.x, current.y, blocks)

              if (idxAtCursor >= 0) {
                const b = blocks[idxAtCursor]!
                const minX = b.contentX
                if (current.x === minX && current.y > b.contentY) {
                  const yPrev = current.y - 1
                  let prevNewlineX = -1
                  for (let col = 0; col < b.width; col++) {
                    const x = minX + col
                    if (nextCells[cellKey(x, yPrev)] === '\n') {
                      prevNewlineX = x
                      break
                    }
                  }

                  if (prevNewlineX >= 0) {
                    const yCur = current.y
                    const curValues: Array<string | undefined> = []
                    let curHadNewline = false
                    for (let col = 0; col < b.width; col++) {
                      const x = minX + col
                      const v = nextCells[cellKey(x, yCur)]
                      if (v === '\n') {
                        curHadNewline = true
                        break
                      }
                      curValues.push(v)
                    }
                    const effectiveWidth = Math.max(
                      b.width,
                      prevNewlineX - minX + curValues.length + (curHadNewline ? 1 : 0),
                    )

                    delete nextCells[cellKey(prevNewlineX, yPrev)]
                    for (let i = 0; i < curValues.length; i++) {
                      const v = curValues[i]
                      const destX = prevNewlineX + i
                      const k = cellKey(destX, yPrev)
                      if (v === undefined) delete nextCells[k]
                      else nextCells[k] = v
                    }

                    if (curHadNewline) {
                      nextCells[cellKey(prevNewlineX + curValues.length, yPrev)] = '\n'
                    }

                    for (let row = yCur + 1; row < b.contentY + b.height; row++) {
                      for (let col = 0; col < effectiveWidth; col++) {
                        const x = minX + col
                        const srcKey = cellKey(x, row)
                        const destKey = cellKey(x, row - 1)
                        const v = nextCells[srcKey]
                        if (v === undefined) delete nextCells[destKey]
                        else nextCells[destKey] = v
                      }
                    }

                    const lastY = b.contentY + b.height - 1
                    for (let col = 0; col < effectiveWidth; col++) {
                      delete nextCells[cellKey(minX + col, lastY)]
                    }

                    const nextHeight = Math.max(1, b.height - 1)
                    let newWidth = 1
                    for (let row = 0; row < nextHeight; row++) {
                      const y = b.contentY + row
                      let last = -1
                      for (let col = 0; col < effectiveWidth; col++) {
                        const v = nextCells[cellKey(minX + col, y)]
                        if (v === '\n') {
                          last = Math.max(last, col)
                          break
                        }
                        if (v !== undefined) last = col
                      }
                      newWidth = Math.max(newWidth, last + 1)
                    }

                    const nextBlocks = blocks.map((bb, i) =>
                      i === idxAtCursor ? { ...bb, width: newWidth, height: nextHeight } : bb,
                    )
                    textBlocksRef.current = nextBlocks
                    setTextBlocks(nextBlocks)
                    markTextBlockDirty(b.id)

                    const nextCursor = { x: prevNewlineX, y: yPrev }
                    cellsRef.current = nextCells
                    cursorRef.current = nextCursor
                    setCells(nextCells)
                    setCursor(nextCursor)
                    return
                  }
                }
              }

              const nextCursor = { x: current.x - 1, y: current.y }
              const idx = findTextBlockIndexAt(nextCursor.x, nextCursor.y, blocks)

              if (idx >= 0) {
                const b = blocks[idx]!
                const minX = b.contentX
                const maxX = b.contentX + b.width - 1
                if (nextCursor.x >= minX && nextCursor.x <= maxX) {
                  for (let sx = nextCursor.x; sx < maxX; sx++) {
                    const srcKey = cellKey(sx + 1, nextCursor.y)
                    const destKey = cellKey(sx, nextCursor.y)
                    const v = nextCells[srcKey]
                    if (v === undefined) delete nextCells[destKey]
                    else nextCells[destKey] = v
                  }
                  delete nextCells[cellKey(maxX, nextCursor.y)]

                  let newWidth = 1
                  for (let row = 0; row < b.height; row++) {
                    const y = b.contentY + row
                    let last = -1
                    for (let col = 0; col < b.width; col++) {
                      const v = nextCells[cellKey(b.contentX + col, y)]
                      if (v === '\n') {
                        last = Math.max(last, col)
                        break
                      }
                      if (v !== undefined) last = col
                    }
                    newWidth = Math.max(newWidth, last + 1)
                  }

                  if (newWidth < b.width) {
                    const nextBlocks = blocks.map((bb, i) =>
                      i === idx ? { ...bb, width: newWidth } : bb,
                    )
                    textBlocksRef.current = nextBlocks
                    setTextBlocks(nextBlocks)
                  }

                  markTextBlockDirty(b.id)
                } else {
                  delete nextCells[cellKey(nextCursor.x, nextCursor.y)]
                }
              } else {
                delete nextCells[cellKey(nextCursor.x, nextCursor.y)]
              }

              cellsRef.current = nextCells
              cursorRef.current = nextCursor
              setCells(nextCells)
              setCursor(nextCursor)
              return
            }
            if (e.key === 'Delete') {
              e.preventDefault()
              const nextCells = { ...cellsRef.current }
              const blocks = textBlocksRef.current
              const idxFileName = findTextBlockIndexAtFileNameRow(current.x, current.y, blocks)
              if (idxFileName >= 0) {
                if (selectionRef.current) setSelection(null)
                const b = blocks[idxFileName]!
                const startX = b.contentX
                const removeAt = current.x - startX
                if (removeAt < 0 || removeAt >= b.fileName.length) return
                const oldName = b.fileName
                if (!renameOriginalFileNamesRef.current.has(b.id)) {
                  renameOriginalFileNamesRef.current.set(b.id, oldName)
                }
                const newName = `${oldName.slice(0, removeAt)}${oldName.slice(removeAt + 1)}`
                const nextBlocks = blocks.map((bb, i) =>
                  i === idxFileName ? { ...bb, fileName: newName } : bb,
                )
                textBlocksRef.current = nextBlocks
                setTextBlocks(nextBlocks)
                const maxLen = Math.max(oldName.length, newName.length)
                for (let i = 0; i < maxLen; i++) {
                  const k = cellKey(startX + i, current.y)
                  if (i < newName.length) nextCells[k] = newName[i]!
                  else delete nextCells[k]
                }
                markTextBlockRenameDirty(b.id)
                cellsRef.current = nextCells
                setCells(nextCells)
                return
              }
              const idx = findTextBlockIndexAt(current.x, current.y, blocks)

              if (idx >= 0) {
                const b = blocks[idx]!
                const minX = b.contentX
                const maxX = b.contentX + b.width - 1
                const currentValue = nextCells[cellKey(current.x, current.y)]
                if (
                  currentValue === '\n' &&
                  current.x >= minX &&
                  current.x <= maxX &&
                  current.y >= b.contentY &&
                  current.y < b.contentY + b.height - 1
                ) {
                  const yPrev = current.y
                  const yCur = current.y + 1
                  const prevNewlineX = current.x

                  const curValues: Array<string | undefined> = []
                  let curHadNewline = false
                  for (let col = 0; col < b.width; col++) {
                    const x = minX + col
                    const v = nextCells[cellKey(x, yCur)]
                    if (v === '\n') {
                      curHadNewline = true
                      break
                    }
                    curValues.push(v)
                  }
                  const effectiveWidth = Math.max(
                    b.width,
                    prevNewlineX - minX + curValues.length + (curHadNewline ? 1 : 0),
                  )

                  delete nextCells[cellKey(prevNewlineX, yPrev)]
                  for (let i = 0; i < curValues.length; i++) {
                    const v = curValues[i]
                    const destX = prevNewlineX + i
                    const k = cellKey(destX, yPrev)
                    if (v === undefined) delete nextCells[k]
                    else nextCells[k] = v
                  }

                  if (curHadNewline) {
                    nextCells[cellKey(prevNewlineX + curValues.length, yPrev)] = '\n'
                  }

                  for (let row = yCur + 1; row < b.contentY + b.height; row++) {
                    for (let col = 0; col < effectiveWidth; col++) {
                      const x = minX + col
                      const srcKey = cellKey(x, row)
                      const destKey = cellKey(x, row - 1)
                      const v = nextCells[srcKey]
                      if (v === undefined) delete nextCells[destKey]
                      else nextCells[destKey] = v
                    }
                  }

                  const lastY = b.contentY + b.height - 1
                  for (let col = 0; col < effectiveWidth; col++) {
                    delete nextCells[cellKey(minX + col, lastY)]
                  }

                  const nextHeight = Math.max(1, b.height - 1)
                  let newWidth = 1
                  for (let row = 0; row < nextHeight; row++) {
                    const y = b.contentY + row
                    let last = -1
                    for (let col = 0; col < effectiveWidth; col++) {
                      const v = nextCells[cellKey(minX + col, y)]
                      if (v === '\n') {
                        last = Math.max(last, col)
                        break
                      }
                      if (v !== undefined) last = col
                    }
                    newWidth = Math.max(newWidth, last + 1)
                  }

                  const nextBlocks = blocks.map((bb, i) =>
                    i === idx ? { ...bb, width: newWidth, height: nextHeight } : bb,
                  )
                  textBlocksRef.current = nextBlocks
                  setTextBlocks(nextBlocks)
                  markTextBlockDirty(b.id)
                } else if (current.x >= minX && current.x <= maxX) {
                  for (let sx = current.x; sx < maxX; sx++) {
                    const srcKey = cellKey(sx + 1, current.y)
                    const destKey = cellKey(sx, current.y)
                    const v = nextCells[srcKey]
                    if (v === undefined) delete nextCells[destKey]
                    else nextCells[destKey] = v
                  }
                  delete nextCells[cellKey(maxX, current.y)]

                  let newWidth = 1
                  for (let row = 0; row < b.height; row++) {
                    const y = b.contentY + row
                    let last = -1
                    for (let col = 0; col < b.width; col++) {
                      const v = nextCells[cellKey(b.contentX + col, y)]
                      if (v === '\n') {
                        last = Math.max(last, col)
                        break
                      }
                      if (v !== undefined) last = col
                    }
                    newWidth = Math.max(newWidth, last + 1)
                  }

                  if (newWidth < b.width) {
                    const nextBlocks = blocks.map((bb, i) =>
                      i === idx ? { ...bb, width: newWidth } : bb,
                    )
                    textBlocksRef.current = nextBlocks
                    setTextBlocks(nextBlocks)
                  }

                  markTextBlockDirty(b.id)
                } else {
                  delete nextCells[cellKey(current.x, current.y)]
                }
              } else {
                delete nextCells[cellKey(current.x, current.y)]
              }

              cellsRef.current = nextCells
              setCells(nextCells)
              return
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              if (selectionRef.current) setSelection(null)
              const blocks = textBlocksRef.current
              const idxFileName = findTextBlockIndexAtFileNameRow(current.x, current.y, blocks)
              if (idxFileName >= 0) {
                const b = blocks[idxFileName]!
                markTextBlockRenameDirty(b.id)
                void flushDirtyTextBlockRenames()
                const nextCursor = { x: b.contentX, y: b.contentY }
                cursorRef.current = nextCursor
                setCursor(nextCursor)
                return
              }
              if (openFolderState.status === 'ready') {
                const idxBlock = findTextBlockIndexAt(current.x, current.y, blocks)
                if (idxBlock < 0) {
                  const parsed = parseTxtFileNameTokenAt(current.x, current.y, cellsRef.current)
                  if (parsed) {
                    void createTextFileAt(parsed.fileName, parsed.startX, current.y)
                    return
                  }
                }
              }
              applyInsertedText('\n')
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
          <div>
            缩放：<code>{Math.round(gridZoom * 100)}%</code>
          </div>
          <div>
            保存：<code>{hasPendingSaves ? '内容待保存' : '内容已保存'}</code>，<code>
              {hasPendingRenames ? '文件名待保存' : '文件名已保存'}
            </code>
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
            cursor: isRightDragging ? 'grabbing' : isBlockDragging ? 'move' : undefined,
            ['--grid-cell-font-size' as never]: `${gridCellFontSize}px`,
          }}
          ref={gridCanvasRef}
          onContextMenu={(e) => {
            e.preventDefault()
          }}
          onWheel={(e) => {
            e.preventDefault()

            const rightHeld =
              rightButtonDownRef.current || (((e as unknown as { buttons?: number }).buttons ?? 0) & 2) === 2

            if (e.ctrlKey || rightHeld) return

            const magnitude = Math.abs(e.deltaY)
            const sign = Math.sign(e.deltaY)
            if (magnitude === 0 || sign === 0) return
            const zoom = gridZoomRef.current
            if (!Number.isFinite(zoom) || zoom <= 0) return
            const baseSteps = sign * Math.max(1, Math.round(magnitude / 100))
            const steps = baseSteps / zoom

            if (e.shiftKey) {
              panX(steps)
              return
            }

            panY(steps)
          }}
          onPointerDown={(e) => {
            if (e.button === 2) {
              e.preventDefault()
              rightButtonDownRef.current = true
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
            const drag = blockDragRef.current
            if (drag?.active && drag.pointerId === e.pointerId) {
              e.preventDefault()
              const dx = e.clientX - drag.startClientX
              const dy = e.clientY - drag.startClientY
              const nextDx = Math.round(dx / drag.cellWidth)
              const nextDy = Math.round(dy / drag.cellHeight)
              const stepX = nextDx - drag.lastDx
              const stepY = nextDy - drag.lastDy
              if (stepX !== 0 || stepY !== 0) {
                moveTextBlockBy(drag.blockId, stepX, stepY)
                drag.lastDx = nextDx
                drag.lastDy = nextDy
              }
              return
            }
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
            const drag = blockDragRef.current
            if (drag?.active && drag.pointerId === e.pointerId) {
              e.preventDefault()
              blockDragRef.current = null
              setIsBlockDragging(false)
              void persistTextBlockPosition(drag.blockId)
              return
            }
            const state = rightDragRef.current
            if (!state?.active || state.pointerId !== e.pointerId) return
            e.preventDefault()
            rightDragRef.current = null
            setIsRightDragging(false)
            rightButtonDownRef.current = false
          }}
          onPointerCancel={(e) => {
            const drag = blockDragRef.current
            if (drag?.active && drag.pointerId === e.pointerId) {
              e.preventDefault()
              blockDragRef.current = null
              setIsBlockDragging(false)
              void persistTextBlockPosition(drag.blockId)
              return
            }
            const state = rightDragRef.current
            if (!state?.active || state.pointerId !== e.pointerId) return
            e.preventDefault()
            rightDragRef.current = null
            setIsRightDragging(false)
            rightButtonDownRef.current = false
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
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.preventDefault()

              const canvas = gridCanvasRef.current
              if (!canvas) {
                focusInput()
                return
              }
              const rect = canvas.getBoundingClientRect()
              if (rect.width <= 0 || rect.height <= 0) {
                focusInput()
                return
              }

              const cellSize = gridCellSizeRef.current
              const zoom = gridZoomRef.current
              if (!Number.isFinite(cellSize) || cellSize <= 0) {
                focusInput()
                return
              }
              if (!Number.isFinite(zoom) || zoom <= 0) {
                focusInput()
                return
              }

              const screenX = e.clientX - rect.left
              const screenY = e.clientY - rect.top
              const innerX = (screenX - gridOffset.x) / zoom
              const innerY = (screenY - gridOffset.y) / zoom
              const col = Math.floor(innerX / cellSize)
              const row = Math.floor(innerY / cellSize)
              const size = gridSizeRef.current
              if (col < 0 || row < 0 || col >= size.cols || row >= size.rows) {
                focusInput()
                return
              }

              const topLeft = viewTopLeftRef.current
              const x = Math.floor(topLeft.x) + col
              const y = Math.floor(topLeft.y) + row

              const prev = cursorRef.current
              if (e.altKey && openFolderState.status === 'ready') {
                if (selectionRef.current) setSelection(null)
                if (hasPendingRenames) {
                  const blocks = textBlocksRef.current
                  const prevIdx = findTextBlockIndexAtFileNameRow(prev.x, prev.y, blocks)
                  if (prevIdx >= 0) {
                    const nextIdx = findTextBlockIndexAtFileNameRow(x, y, blocks)
                    if (nextIdx < 0) void flushDirtyTextBlockRenames()
                  }
                }

                const blocks = textBlocksRef.current
                const idx = findTextBlockIndexAt(x, y, blocks)
                if (idx >= 0) {
                  const b = blocks[idx]!
                  const cellWidth = cellSize * zoom
                  const cellHeight = cellSize * zoom
                  if (Number.isFinite(cellWidth) && Number.isFinite(cellHeight)) {
                    blockDragRef.current = {
                      active: true,
                      pointerId: e.pointerId,
                      blockId: b.id,
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      lastDx: 0,
                      lastDy: 0,
                      cellWidth,
                      cellHeight,
                    }
                    setIsBlockDragging(true)
                    e.currentTarget.setPointerCapture(e.pointerId)
                  }
                  const next = { x, y }
                  setCursor(next)
                  cursorRef.current = next
                  focusInput()
                  return
                }
              }

              maybeCreateTextFileFromTokenAt(prev)
              if (hasPendingRenames) {
                const blocks = textBlocksRef.current
                const prevIdx = findTextBlockIndexAtFileNameRow(prev.x, prev.y, blocks)
                if (prevIdx >= 0) {
                  const nextIdx = findTextBlockIndexAtFileNameRow(x, y, blocks)
                  if (nextIdx < 0) void flushDirtyTextBlockRenames()
                }
              }

              const next = { x, y }
              setCursor(next)
              cursorRef.current = next
              if (e.shiftKey) {
                const anchor = selectionRef.current?.anchor ?? prev
                setSelection({ anchor, focus: next })
              } else if (selectionRef.current) {
                setSelection(null)
              }
              focusInput()
            }}
          >
            {gridRange.ys.flatMap((y) =>
              gridRange.xs.map((x) => {
                const active = x === cursor.x && y === cursor.y
                const value = cells[cellKey(x, y)] ?? ''
                const isSpace = value === ' '
                const isNewline = value === '\n'
                const displayValue = isSpace ? 'ㆍ' : isNewline ? '↵' : value
                const borderKey = cellKey(x, y)
                const hasDashedRight = textBorderSets.dashedRight.has(borderKey)
                const hasDashedBottom = textBorderSets.dashedBottom.has(borderKey)
                const hasSelectedDashedRight =
                  selectedTextBorderSets?.dashedRight.has(borderKey) ?? false
                const hasSelectedDashedBottom =
                  selectedTextBorderSets?.dashedBottom.has(borderKey) ?? false
                const selected = selectedCellKeys.has(borderKey)
                const borderStyle: CSSProperties | undefined =
                  hasDashedRight || hasDashedBottom
                    ? {
                        borderRight: hasDashedRight
                          ? `${hasSelectedDashedRight ? 3 : 2}px dashed ${hasSelectedDashedRight ? '#0078d7' : '#a8a8a8'}`
                          : undefined,
                        borderBottom: hasDashedBottom
                          ? `${hasSelectedDashedBottom ? 3 : 2}px dashed ${hasSelectedDashedBottom ? '#0078d7' : '#a8a8a8'}`
                          : undefined,
                      }
                    : undefined
                return (
                  <div
                    key={`${x},${y}`}
                    className={`gridCell${selected ? ' gridCellSelected' : ''}${active ? ' gridCellActive' : ''}`}
                    title={`(${x}, ${y})`}
                    style={borderStyle}
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
