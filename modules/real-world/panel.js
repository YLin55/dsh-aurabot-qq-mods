// 小世界面板：状态页 + 时间表开关 + 地区（配置与地点卡片同一张卡，单列可滚动）
const { useState, useEffect, useRef } = React
const { Card, Btn, Switch, Row, Select, Empty } = ui

const TAGS = [
  { key: '打工', emoji: '💰' },
  { key: '情色', emoji: '❤️' },
]

const DEFAULTS = {
  enabled: true,
  startTime: '10:00',
  endTime: '22:00',
  intervalHours: 2,
  allowLateReturn: false,
  allowOvernight: false,
  reportOnMove: true,
  chatProtectMinutes: 10,
  allowSelfOuting: true,
  rideMode: '电车',
  rideMinutes: 15,
  reportChance: 100,
  reportMinGapMinutes: 120,
  reflectEnabled: true,
  reflectTime: '23:30',
}

return function RealWorldPanel({ settings, draftSettings, setSettings, save, toast }) {
  const [maps, setMaps] = useState({ activeId: '', list: [] })   // 地区列表（当前地图内）
  const [presets, setPresets] = useState({ activeId: '', list: [] }) // 地图预设
  const [creatingMap, setCreatingMap] = useState(false)
  const [newMapName, setNewMapName] = useState('')
  const [places, setPlaces] = useState([])
  const [dirty, setDirty] = useState(false)
  // 「有没有未保存改动」不再靠手动 setDirty(true)：改回原样也要能熄灭。
  // 这里记一份「上次保存/加载时的地点指纹」，用当前地点跟它比，一致就不算改动。
  const savedSigRef = useRef('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [localCfg, setLocalCfg] = useState({})
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [confirmDel, setConfirmDel] = useState('')
  const [live, setLive] = useState(null)
  const [tab, setTab] = useState('status')
  const [mapSel, setMapSel] = useState(-1)        // 选中的地点序号
  const [mapMode, setMapMode] = useState('')      // '' | 'move' | 'add'
  const [mapDraft, setMapDraft] = useState(null)  // 正在编辑的地点副本
  const [draftIsNew, setDraftIsNew] = useState(false) // true=新增的点（要单独画），false=改动已有地点
  const [movingIdx, setMovingIdx] = useState(-1)       // >=0 表示正在挪这个地点（可取消）
  const [confirmDelPlace, setConfirmDelPlace] = useState(-1)
  const [zoom, setZoom] = useState(1)        // 地图缩放（1~3，滑块在地图右下角）
  const [view, setView] = useState({ x: 0.5, y: 0.5 })   // 视点中心（0~1 地图坐标），缩放后可拖拽
  const dragRef = useRef(null)               // 拖拽中的起点与原始视点
  const draggedRef = useRef(false)           // 这一下是拖拽而不是点击（避免松手误加点）

  const savedCfg = { ...DEFAULTS, ...(settings || {}) }
  const curCfg = draftSettings ? { ...DEFAULTS, ...draftSettings } : { ...savedCfg, ...localCfg }
  const cfgDirty = JSON.stringify(curCfg) !== JSON.stringify(savedCfg)
  const putCfg = (patch) => {
    if (typeof setSettings === 'function') setSettings(patch)
    else setLocalCfg((prev) => ({ ...prev, ...patch }))
  }
  const saveCfg = async () => {
    if (!save) return
    await save(curCfg)
    setLocalCfg({})
    toast && toast('设置已保存', 'ok')
    loadMaps()
  }

  const loadMaps = async () => {
    try {
      setErr('')
      const r = await call('/regions')
      const next = r.regions || { activeId: '', list: [] }
      setMaps(next)
      try {
        const m = await call('/maps')
        if (m && m.maps) setPresets(m.maps)
      } catch (e) { /* 老版本没有就跳过 */ }
      const active = (next.list || []).find((m) => m.id === next.activeId) || (next.list || [])[0]
      resetPlaces(active ? active.places : [])
    } catch (e) {
      setErr(String((e && e.message) || e))
    }
  }
  useEffect(() => {
    loadMaps()
    loadLive()
    const timer = setInterval(loadLive, 30_000)
    return () => clearInterval(timer)
  }, [])

  const loadLive = async () => {
    try {
      const r = await call('/state')
      setLive(r || null)
    } catch (e) {
      // 静默容错
    }
  }

  const activeMap = () => (maps.list || []).find((m) => m.id === maps.activeId) || (maps.list || [])[0] || null

  const pickMapPreset = async (id) => {
    const r = await call('/maps/select', { id })
    if (r && r.ok === false) { toast && toast(r.message || '切换失败'); return }
    if (r.maps) setPresets(r.maps)
    setDirty(false)
    await loadMaps()
    toast && toast(r.message || '已切换地图', 'ok')
  }

  const createMapPreset = async () => {
    const name = String(newMapName || '').trim()
    if (!name) { toast && toast('先给新地图起个名字'); return }
    const r = await call('/maps/new', { name })
    if (r && r.ok === false) { toast && toast(r.message || '新建失败'); return }
    if (r.maps) setPresets(r.maps)
    setCreatingMap(false)
    setNewMapName('')
    await loadMaps()
    toast && toast(r.message || '已新建地图', 'ok')
  }

  const pickRegion = async (id) => {
    // 这里只切换「正在查看/编辑的地区」，她的实际位置不变（要她过去用命令 /小世界 切地区）
    if (dirty) toast && toast('这个地区有没保存的改动，已丢弃')
    const r = await call('/regions/select', { id })
    if (r && r.ok === false) { toast && toast(r.message || '切换失败'); return }
    const nextList = (r.regions && r.regions.list) || maps.list
    setMaps(r.regions || r.maps || maps)
    const next = (nextList || []).find((m) => m.id === ((r.regions && r.regions.activeId) || id))
    resetPlaces(next ? next.places : [])
    setConfirmDel('')
    setMapSel(-1)
    setMapDraft(null)
    setDraftIsNew(false)
    await loadLive()
    toast && toast(r.message || '已切换查看的地区', 'ok')
  }

  const doCreate = async () => {
    const name = String(newName || '').trim()
    if (!name) { toast && toast('先给新地区起个名字'); return }
    const r = await call('/regions/new', { name })
    if (r && r.ok === false) { toast && toast(r.message || '新建失败'); return }
    setMaps(r.maps || maps)
    resetPlaces((r.map && r.map.places) || [])
    setCreating(false)
    setNewName('')
    toast && toast(`新建了「${name}」（自带一张「家」卡片）`, 'ok')
  }

  const doDeleteMap = async () => {
    const m = activeMap()
    if (!m) return
    if ((maps.list || []).length <= 1) { toast && toast('至少要留一个地区'); return }
    if (confirmDel !== m.id) { setConfirmDel(m.id); return }
    const r = await call('/regions/delete', { id: m.id })
    if (r && r.ok === false) { toast && toast(r.message || '删除失败'); return }
    const nextList = (r.regions && r.regions.list) || []
    setMaps(r.maps || maps)
    const active = nextList.find((x) => x.id === (r.regions && r.regions.activeId)) || nextList[0]
    resetPlaces(active ? active.places : [])
    setConfirmDel('')
    toast && toast(r.message || '已删除', 'ok')
  }

  const toggleTag = (idx, key) => {
    setPlaces((prev) => prev.map((p, i) => {
      if (i !== idx) return p
      const tags = Array.isArray(p.tags) ? [...p.tags] : []
      const at = tags.indexOf(key)
      if (at >= 0) tags.splice(at, 1)
      else tags.push(key)
      return { ...p, tags }
    }))
  }

  /** 一个地点参与「是否改动」的字段（位置、名字、简介、标签、图标、权重、是否车站）。 */
  const sigOfPlace = (p) => JSON.stringify([
    String(p?.name || ''), String(p?.info || ''),
    Array.isArray(p?.tags) ? [...p.tags].sort() : [],
    Number(p?.pref ?? 100), String(p?.icon || ''),
    Math.round(Number(p?.x ?? 0) * 10000), Math.round(Number(p?.y ?? 0) * 10000),
    Boolean(p?.station),
  ])
  const sigOfPlaces = (list) => JSON.stringify((list || []).map(sigOfPlace))
  /** 用后端给的地点列表重置编辑器，并把指纹记成「已保存」。 */
  // 当前地点 vs 上次保存的指纹：一致就熄灭（把改动改回原样也能熄灭）。
  // 另外有未提交的地图草稿（新增/移动）时也算有改动，提示别忘点保存。
  useEffect(() => {
    const changed = sigOfPlaces(places) !== savedSigRef.current
      || Boolean(mapDraft && (draftIsNew || movingIdx >= 0))
    setDirty(changed)
  }, [places, mapDraft, draftIsNew, movingIdx])

  const resetPlaces = (list) => {
    const copy = JSON.parse(JSON.stringify(list || []))
    setPlaces(copy)
    savedSigRef.current = sigOfPlaces(copy)
    setDirty(false)
  }

  const patchPlace = (idx, patch) => {
    setPlaces((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)))
  }
  const addPlace = () => {
    // 不填坐标：保存时后端会按「四分区取最少块 + 随机锚点挤开」自动放位置
    setPlaces((prev) => [...prev, { name: '', info: '' }])
  }
  const delPlace = (idx) => {
    if (places[idx]?.name === '家') { toast && toast('「家」是固定卡片，删不掉'); return }
    if (places[idx]?.station === true) { toast && toast('车站是必有的固定卡片，删不掉（每个地区都要有一个）'); return }
    setPlaces((prev) => prev.filter((_, i) => i !== idx))
  }
  const saveMapNow = async () => {
    const m = activeMap()
    if (!m) return
    setBusy(true)
    try {
      const clean = places.filter((p) => String(p.name || '').trim() || String(p.info || '').trim())
      const r = await call('/regions/save', { id: m.id, places: clean })
      if (r && r.ok === false) { toast && toast(r.message || '保存失败'); return }
      setMaps((r.regions && r.regions.list) ? { activeId: r.regions.activeId, list: r.regions.list } : maps)
      const saved = (r.region && r.region.places) || (r.map && r.map.places) || clean
      resetPlaces(saved)
      await loadLive()
      toast && toast('地区已保存', 'ok')
    } finally {
      setBusy(false)
    }
  }

  const rowBtn = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
  const cardStyle = {
    border: '1px solid var(--ab-line, rgba(128,128,128,.22))',
    borderRadius: 10,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    background: 'var(--ab-card, transparent)',
  }

  // ---------- 平面地图 ----------
  // 地点图标预设（创建/编辑时可选；留空按默认：车站🚉、家🏠、打工💼、其它📍）
const PLACE_ICONS = ['🏠', '🚉', '📍', '💼', '❤️', '🛁', '🍜', '☕', '🎹', '🌸', '🍺', '🏨']

const MAP_W = 1000 // viewBox 尺寸（正方形）
  const MIN_GAP = 0.09 // 两个地点至少隔开 9%（地图 2km ≈ 180m，比图标大一圈）

  const BG_FALLBACK = [
    { id: 'urban', name: '都市' },
    { id: 'rural', name: '乡村' },
    { id: 'suburb', name: '郊外' },
    { id: 'wild', name: '山野' },
    { id: 'fantasy', name: '异世界' },
  ]

  /** 五套简约平面地图背景（纯 SVG 图形，随地区保存的是 id）。 */
  const bgScene = (id) => {
    const W = MAP_W
    // 注意：参数不能叫 h，否则会遮住外层渲染函数 h()
    const r = (x, y, w, ht, fill, extra) => h('rect', { x: x * W, y: y * W, width: w * W, height: ht * W, fill, ...extra })
    const c = (x, y, rad, fill, extra) => h('circle', { cx: x * W, cy: y * W, r: rad * W, fill, ...extra })
    const line = (x1, y1, x2, y2, stroke, width) => h('line', { x1: x1 * W, y1: y1 * W, x2: x2 * W, y2: y2 * W, stroke, strokeWidth: width })
    if (id === 'urban') {
      return [
        r(0, 0, 1, 1, '#eef2f7'),
        r(0.06, 0.08, 0.16, 0.12, '#dde5ee'), r(0.28, 0.08, 0.14, 0.1, '#dde5ee'),
        r(0.5, 0.1, 0.18, 0.14, '#e3e9f2'), r(0.76, 0.08, 0.16, 0.18, '#dde5ee'),
        r(0.08, 0.28, 0.2, 0.16, '#e3e9f2'), r(0.34, 0.3, 0.14, 0.12, '#dde5ee'),
        r(0.62, 0.3, 0.12, 0.1, '#dde5ee'), r(0.8, 0.32, 0.14, 0.14, '#e3e9f2'),
        r(0.06, 0.54, 0.14, 0.16, '#dde5ee'), r(0.26, 0.56, 0.18, 0.12, '#e3e9f2'),
        r(0.58, 0.54, 0.16, 0.14, '#dde5ee'), r(0.78, 0.55, 0.16, 0.16, '#e3e9f2'),
        r(0.1, 0.78, 0.18, 0.14, '#dde5ee'), r(0.36, 0.76, 0.14, 0.16, '#e3e9f2'),
        r(0.6, 0.76, 0.2, 0.14, '#dde5ee'), r(0.84, 0.78, 0.1, 0.12, '#e3e9f2'),
        r(0.44, 0.44, 0.12, 0.12, '#cfe8cf'),
        line(0, 0.5, 1, 0.5, '#cfd8e3', 16), line(0.5, 0, 0.5, 1, '#cfd8e3', 16),
        line(0, 0.25, 1, 0.25, '#dbe3ec', 8), line(0, 0.75, 1, 0.75, '#dbe3ec', 8),
        line(0.25, 0, 0.25, 1, '#dbe3ec', 8), line(0.75, 0, 0.75, 1, '#dbe3ec', 8),
        h('path', { d: `M0 ${0.9 * W} Q ${0.3 * W} ${0.8 * W} ${0.55 * W} ${0.88 * W} T ${W} ${0.84 * W}`, stroke: '#a8cfee', strokeWidth: 22, fill: 'none' }),
      ]
    }
    if (id === 'rural') {
      return [
        r(0, 0, 1, 1, '#f7f2e4'),
        r(0.04, 0.06, 0.26, 0.22, '#e8dfbe'), r(0.34, 0.05, 0.22, 0.18, '#d6e5bd'),
        r(0.6, 0.07, 0.3, 0.2, '#efe4c4'), r(0.05, 0.34, 0.3, 0.24, '#d6e5bd'),
        r(0.4, 0.3, 0.24, 0.2, '#e8dfbe'), r(0.68, 0.33, 0.26, 0.22, '#cfe1b6'),
        r(0.06, 0.64, 0.26, 0.24, '#efe4c4'), r(0.36, 0.6, 0.3, 0.2, '#d6e5bd'),
        r(0.7, 0.62, 0.24, 0.26, '#e8dfbe'),
        // 田埂
        h('path', { d: `M${0.04 * W} ${0.17 * W} L ${0.3 * W} ${0.17 * W} M${0.17 * W} ${0.06 * W} L ${0.17 * W} ${0.28 * W}`, stroke: '#c8d3ac', strokeWidth: 4, fill: 'none' }),
        h('path', { d: `M${0.4 * W} ${0.15 * W} L ${0.62 * W} ${0.15 * W} M${0.5 * W} ${0.3 * W} L ${0.64 * W} ${0.3 * W}`, stroke: '#c8d3ac', strokeWidth: 4, fill: 'none' }),
        h('path', { d: `M${0.06 * W} ${0.76 * W} L ${0.32 * W} ${0.76 * W} M${0.7 * W} ${0.75 * W} L ${0.94 * W} ${0.75 * W}`, stroke: '#c8d3ac', strokeWidth: 4, fill: 'none' }),
        // 土路
        h('path', { d: `M${0.5 * W} 0 L ${0.44 * W} ${0.35 * W} L ${0.56 * W} ${0.7 * W} L ${0.5 * W} ${W}`, stroke: '#d7c6a4', strokeWidth: 24, fill: 'none' }),
        h('path', { d: `M0 ${0.5 * W} L ${W} ${0.52 * W}`, stroke: '#e0d3b6', strokeWidth: 14, fill: 'none' }),
        r(0.2, 0.45, 0.03, 0.03, '#d8b48a'), r(0.24, 0.47, 0.03, 0.03, '#d8b48a'),
        r(0.62, 0.45, 0.03, 0.03, '#d8b48a'), r(0.78, 0.5, 0.03, 0.03, '#d8b48a'),
        c(0.15, 0.85, 0.02, '#c3d9ae'), c(0.2, 0.88, 0.02, '#c3d9ae'), c(0.85, 0.2, 0.02, '#c3d9ae'),
      ]
    }
    if (id === 'suburb') {
      return [
        r(0, 0, 1, 1, '#eef4e9'),
        h('path', { d: `M0 ${0.3 * W} C ${0.3 * W} ${0.2 * W}, ${0.5 * W} ${0.45 * W}, ${W} ${0.34 * W}`, stroke: '#d6c8ac', strokeWidth: 34, fill: 'none' }),
        h('path', { d: `M${0.36 * W} 0 C ${0.34 * W} ${0.3 * W}, ${0.52 * W} ${0.6 * W}, ${0.44 * W} ${W}`, stroke: '#d6c8ac', strokeWidth: 26, fill: 'none' }),
        h('ellipse', { cx: 0.18 * W, cy: 0.62 * W, rx: 0.08 * W, ry: 0.05 * W, fill: '#cfe4f5' }),
        r(0.1, 0.08, 0.07, 0.055, '#d8b894'), r(0.22, 0.1, 0.07, 0.055, '#d8b894'),
        r(0.62, 0.09, 0.07, 0.055, '#d8b894'), r(0.76, 0.12, 0.07, 0.055, '#d8b894'),
        r(0.58, 0.22, 0.07, 0.055, '#d8b894'), r(0.86, 0.24, 0.07, 0.055, '#d8b894'),
        r(0.1, 0.46, 0.07, 0.055, '#d8b894'), r(0.28, 0.42, 0.07, 0.055, '#d8b894'),
        r(0.6, 0.52, 0.07, 0.055, '#d8b894'), r(0.74, 0.58, 0.07, 0.055, '#d8b894'),
        r(0.86, 0.64, 0.07, 0.055, '#d8b894'), r(0.3, 0.74, 0.07, 0.055, '#d8b894'),
        r(0.54, 0.8, 0.07, 0.055, '#d8b894'), r(0.76, 0.84, 0.07, 0.055, '#d8b894'),
        c(0.06, 0.42, 0.025, '#bcd9b8'), c(0.4, 0.14, 0.025, '#bcd9b8'),
        c(0.88, 0.45, 0.025, '#bcd9b8'), c(0.3, 0.9, 0.03, '#bcd9b8'),
        c(0.9, 0.72, 0.028, '#bcd9b8'), c(0.16, 0.3, 0.022, '#bcd9b8'),
      ]
    }
    if (id === 'wild') {
      return [
        r(0, 0, 1, 1, '#e9f0e4'),
        h('ellipse', { cx: 0.26 * W, cy: 0.26 * W, rx: 0.2 * W, ry: 0.15 * W, fill: '#cfe3cb' }),
        h('ellipse', { cx: 0.7 * W, cy: 0.2 * W, rx: 0.16 * W, ry: 0.12 * W, fill: '#bfd8bb' }),
        h('ellipse', { cx: 0.22 * W, cy: 0.7 * W, rx: 0.18 * W, ry: 0.14 * W, fill: '#bfd8bb' }),
        h('ellipse', { cx: 0.72 * W, cy: 0.72 * W, rx: 0.22 * W, ry: 0.16 * W, fill: '#cfe3cb' }),
        h('ellipse', { cx: 0.5 * W, cy: 0.46 * W, rx: 0.12 * W, ry: 0.09 * W, fill: '#b3d0af' }),
        h('path', { d: `M0.05 ${0.52 * W} Q ${0.3 * W} ${0.44 * W} ${0.5 * W} ${0.56 * W} T ${0.95 * W} ${0.5 * W}`, stroke: '#9cc7e8', strokeWidth: 18, fill: 'none' }),
        h('path', { d: `M${0.14 * W} ${0.9 * W} Q ${0.3 * W} ${0.66 * W} ${0.62 * W} ${0.62 * W} T ${0.9 * W} ${0.34 * W}`, stroke: '#c8b892', strokeWidth: 5, strokeDasharray: '10 12', fill: 'none' }),
        c(0.4, 0.24, 0.02, '#8fae8a', { opacity: 0.5 }), c(0.6, 0.32, 0.02, '#8fae8a', { opacity: 0.5 }),
        c(0.3, 0.52, 0.02, '#8fae8a', { opacity: 0.5 }), c(0.66, 0.6, 0.02, '#8fae8a', { opacity: 0.5 }),
        c(0.46, 0.8, 0.02, '#8fae8a', { opacity: 0.5 }),
      ]
    }
    if (id === 'fantasy') {
      // 剑与魔法的中世纪地图：羊皮纸底 + 城墙王城 + 山脉 + 森林 + 河 + 土路 + 罗盘
      const tri = (cx, cy, w, hgt, fill, stroke) => h('path', {
        d: `M${(cx - w / 2) * W} ${cy * W} L ${cx * W} ${(cy - hgt) * W} L ${(cx + w / 2) * W} ${cy * W} Z`,
        fill, stroke, strokeWidth: 2,
      })
      const tree = (cx, cy, rad, fill) => h('g', null,
        h('rect', { x: (cx - rad * 0.12) * W, y: (cy + rad * 0.5) * W, width: rad * 0.24 * W, height: rad * 0.7 * W, fill: '#8a6a45' }),
        h('circle', { cx: cx * W, cy: cy * W, r: rad * W, fill }))
      const tower = (cx, cy, w, hgt) => h('g', null,
        h('rect', { x: (cx - w / 2) * W, y: (cy - hgt) * W, width: w * W, height: hgt * W, fill: '#dcc59b', stroke: '#8a7050', strokeWidth: 3 }),
        // 窗
        h('rect', { x: (cx - w * 0.12) * W, y: (cy - hgt * 0.62) * W, width: w * 0.24 * W, height: hgt * 0.22 * W, fill: '#7d6344' }),
        tri(cx, cy - hgt, w * 1.35, w * 0.9, '#b3654f', '#8f4c3b'))
      return [
        r(0, 0, 1, 1, '#f3e7cd'),
        // 河
        h('path', {
          d: `M${0.98 * W} ${0.02 * W} C ${0.82 * W} ${0.2 * W}, ${0.9 * W} ${0.42 * W}, ${0.74 * W} ${0.58 * W} C ${0.64 * W} ${0.68 * W}, ${0.66 * W} ${0.86 * W}, ${0.56 * W} ${W}`,
          stroke: '#a9c8e0', strokeWidth: 26, fill: 'none', strokeLinecap: 'round',
        }),
        h('path', {
          d: `M${0.98 * W} ${0.02 * W} C ${0.82 * W} ${0.2 * W}, ${0.9 * W} ${0.42 * W}, ${0.74 * W} ${0.58 * W} C ${0.64 * W} ${0.68 * W}, ${0.66 * W} ${0.86 * W}, ${0.56 * W} ${W}`,
          stroke: '#c6dcec', strokeWidth: 12, fill: 'none', strokeLinecap: 'round',
        }),
        // 山脉（左上）
        tri(0.12, 0.30, 0.20, 0.16, '#d8c8a6', '#a89a7e'),
        tri(0.24, 0.28, 0.16, 0.12, '#cfbd97', '#a89a7e'),
        tri(0.18, 0.22, 0.14, 0.10, '#e2d3b3', '#a89a7e'),
        tri(0.34, 0.34, 0.12, 0.09, '#d3c2a0', '#a89a7e'),
        // 雪顶
        h('path', { d: `M${0.145 * W} ${0.235 * W} L ${0.18 * W} ${0.175 * W} L ${0.215 * W} ${0.235 * W} Z`, fill: '#fbf6ec' }),
        h('path', { d: `M${0.225 * W} ${0.215 * W} L ${0.24 * W} ${0.185 * W} L ${0.255 * W} ${0.215 * W} Z`, fill: '#fbf6ec' }),
        h('path', { d: `M${0.09 * W} ${0.285 * W} L ${0.12 * W} ${0.205 * W} L ${0.15 * W} ${0.285 * W} Z`, fill: '#f2ebdc' }),
        // 森林（左下 + 右上）
        tree(0.10, 0.62, 0.028, '#bcd6a6'), tree(0.16, 0.66, 0.024, '#accb96'),
        tree(0.13, 0.72, 0.026, '#bcd6a6'), tree(0.21, 0.71, 0.022, '#accb96'),
        tree(0.08, 0.76, 0.026, '#accb96'), tree(0.18, 0.78, 0.024, '#bcd6a6'),
        tree(0.84, 0.30, 0.024, '#bcd6a6'), tree(0.90, 0.34, 0.022, '#accb96'),
        tree(0.88, 0.27, 0.02, '#bcd6a6'),
        // 王城（中央偏左）：城墙 + 三座塔 + 城门
        h('rect', { x: 0.382 * W, y: 0.428 * W, width: 0.20 * W, height: 0.17 * W, fill: '#c9b48c', opacity: 0.45 }),
        h('rect', { x: 0.38 * W, y: 0.42 * W, width: 0.20 * W, height: 0.17 * W, fill: '#e9d8b6', stroke: '#8a7050', strokeWidth: 3.5 }),
        tower(0.385, 0.42, 0.055, 0.14),
        tower(0.575, 0.42, 0.055, 0.14),
        tower(0.48, 0.47, 0.062, 0.20),
        h('path', { d: `M${0.455 * W} ${0.59 * W} L ${0.455 * W} ${0.51 * W} Q ${0.48 * W} ${0.475 * W} ${0.505 * W} ${0.51 * W} L ${0.505 * W} ${0.59 * W} Z`, fill: '#8f6f4a' }),
        // 城墙垛口
        [0.40, 0.435, 0.47, 0.505, 0.54, 0.575].map((x) => h('rect', {
          key: 'm' + x, x: (x - 0.012) * W, y: 0.405 * W, width: 0.024 * W, height: 0.02 * W, fill: '#cbb38a',
        })),
        // 城墙外的田与村舍
        r(0.28, 0.60, 0.06, 0.05, '#e8d8b4'), r(0.28, 0.67, 0.06, 0.05, '#ded0a8'),
        r(0.62, 0.66, 0.05, 0.045, '#e8d8b4'), r(0.68, 0.70, 0.05, 0.045, '#ded0a8'),
        r(0.66, 0.34, 0.04, 0.035, '#e0cba4'), r(0.30, 0.36, 0.04, 0.035, '#e0cba4'),
        // 土路（虚线）
        h('path', { d: `M${0.48 * W} ${0.58 * W} L ${0.46 * W} ${0.78 * W} L ${0.34 * W} ${0.92 * W}`, stroke: '#b79b6f', strokeWidth: 6, strokeDasharray: '12 10', fill: 'none' }),
        h('path', { d: `M${0.48 * W} ${0.58 * W} L ${0.62 * W} ${0.72 * W} L ${0.82 * W} ${0.84 * W}`, stroke: '#b79b6f', strokeWidth: 6, strokeDasharray: '12 10', fill: 'none' }),
        h('path', { d: `M${0.48 * W} ${0.44 * W} L ${0.44 * W} ${0.2 * W}`, stroke: '#b79b6f', strokeWidth: 6, strokeDasharray: '12 10', fill: 'none' }),
        // 罗盘
        h('circle', { cx: 0.88 * W, cy: 0.86 * W, r: 0.05 * W, fill: 'none', stroke: '#a89a7e', strokeWidth: 3 }),
        h('path', { d: `M${0.88 * W} ${0.80 * W} L ${0.91 * W} ${0.86 * W} L ${0.88 * W} ${0.84 * W} L ${0.85 * W} ${0.86 * W} Z`, fill: '#b3654f' }),
        h('text', { x: 0.88 * W, y: 0.955 * W, fontSize: 20, textAnchor: 'middle', fill: '#a89a7e' }, 'N'),
      ]
    }
    return []
  }

  const tooClose = (draft, skipIndex) => {
    if (!draft || !Number.isFinite(draft.x) || !Number.isFinite(draft.y)) return null
    for (let i = 0; i < places.length; i += 1) {
      if (i === skipIndex) continue
      const p = places[i]
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
      const d = Math.hypot(draft.x - p.x, draft.y - p.y)
      if (d < MIN_GAP) return { name: p.name, meters: Math.round(d * 2000) }
    }
    return null
  }
  // 当前缩放下可见的地图范围（viewBox），点击换算和渲染共用
  const zoomOf = () => Math.min(3, Math.max(1, Number(zoom) || 1))
  const clampView = (v) => {
    const half = (MAP_W / zoomOf()) / 2
    const lo = half / MAP_W
    const hi = 1 - lo
    return { x: Math.min(hi, Math.max(lo, v.x)), y: Math.min(hi, Math.max(lo, v.y)) }
  }
  const zoomBox = () => {
    const z = zoomOf()
    const w = MAP_W / z
    const half = w / 2
    const cx = Math.min(MAP_W - half, Math.max(half, view.x * MAP_W))
    const cy = Math.min(MAP_W - half, Math.max(half, view.y * MAP_W))
    return { x: cx - half, y: cy - half, w, h: w, z }
  }
  const mapPoint = (evt, el) => {
    const rect = el.getBoundingClientRect()
    const vb = zoomBox()
    const relX = Math.min(1, Math.max(0, (evt.clientX - rect.left) / rect.width))
    const relY = Math.min(1, Math.max(0, (evt.clientY - rect.top) / rect.height))
    // 屏幕比例 → viewBox 内坐标 → 0~1 的地图坐标
    const x = (vb.x + relX * vb.w) / MAP_W
    const y = (vb.y + relY * vb.h) / MAP_W
    return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }
  }

  const selectPlace = (i) => {
    if (movingIdx >= 0 && movingIdx !== i) cancelDraft()
    setMapSel(i)
    setMapDraft({ ...places[i] })
    setDraftIsNew(false)
    setMapMode('')
    setMovingIdx(-1)
    setConfirmDelPlace(-1)
  }

  const startMove = () => {
    if (mapSel < 0) { toast && toast('先点一个地点'); return }
    setMapMode('move')
    setDraftIsNew(false)
    setMovingIdx(mapSel)
    toast && toast('点地图上的新位置（随时可以点「取消」）')
  }

  /** 放弃当前草稿：移动/新增都回到原样。 */
  const cancelDraft = () => {
    setMapDraft(null)
    setDraftIsNew(false)
    setMapMode('')
    setMovingIdx(-1)
    setMapSel(-1)
  }

  /** 删除地图上的地点（家/车站不能删）。 */
  const deletePlaceAt = async (idx) => {
    const target = places[idx]
    if (!target) return
    if (target.station === true) { toast && toast('车站是必有的固定卡，不能删', 'err'); return }
    if (target.name === '家') { toast && toast('「家」是固定卡，不能删', 'err'); return }
    if (confirmDelPlace !== idx) {
      setConfirmDelPlace(idx)
      toast && toast(`再点一次「确认删除『${target.name}』」`)
      return
    }
    const merged = places.filter((_, i) => i !== idx).map((pp) => ({ ...pp }))
    const m = activeMap()
    if (!m) return
    setBusy(true)
    try {
      const r = await call('/regions/save', { id: m.id, places: merged })
      if (r && r.ok === false) { toast && toast(r.message || '删除失败', 'err'); return }
      setMaps((r.regions && r.regions.list) ? { activeId: r.regions.activeId, list: r.regions.list } : maps)
      resetPlaces((r.region && r.region.places) || merged)
      setConfirmDelPlace(-1)
      cancelDraft()
      await loadLive()
      toast && toast(`删掉了「${target.name}」`, 'ok')
    } finally {
      setBusy(false)
    }
  }

  const applyBg = async (bg) => {
    try {
      const r = await call('/bg', { bg })
      if (r && r.ok === false) { toast && toast(r.message || '背景没设上', 'err'); return }
      setMaps((prev) => {
        const list = (prev.list || []).map((x) => (x.id === (r.region && r.region.id) ? { ...x, bg: r.region.bg } : x))
        return { ...prev, list }
      })
      await loadLive()
      toast && toast(r.message || '背景已更新', 'ok')
    } catch (e) {
      toast && toast('背景没设上：' + ((e && e.message) || e), 'err')
    }
  }

  const pickBgFile = (evt) => {
    const file = evt && evt.target && evt.target.files && evt.target.files[0]
    if (!file) return
    if (!/^image\//.test(file.type)) { toast && toast('要图片文件', 'err'); return }
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        // 缩到最长边 1024，转 JPEG，控制体积（后端上限 2MB）
        const max = 1024
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const hgt = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = hgt
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, w, hgt)
        const data = canvas.toDataURL('image/jpeg', 0.82)
        applyBg({ type: 'image', data })
      }
      img.onerror = () => toast && toast('这张图片读不出来', 'err')
      img.src = String(reader.result || '')
    }
    reader.onerror = () => toast && toast('读取文件失败', 'err')
    reader.readAsDataURL(file)
  }

  const startAdd = () => {
    setMapMode('add')
    setMapDraft({ name: '', info: '', tags: [], pref: 100, icon: '' })
    setDraftIsNew(true)
    setMapSel(-1)
    toast && toast('点地图上要放新地点的位置')
  }

  // 左键拖拽移动视点（缩放 > 1 时有意义；边界在 clampView 里夹住）
  const onMapPointerDown = (evt) => {
    if (evt.button !== 0) return
    draggedRef.current = false
    if (zoomOf() <= 1.01) return
    const rect = evt.currentTarget.getBoundingClientRect()
    dragRef.current = {
      sx: evt.clientX, sy: evt.clientY, vx: view.x, vy: view.y,
      w: rect.width, h: rect.height, el: evt.currentTarget, pid: evt.pointerId,
    }
    // 这里既不能 preventDefault、也不能 setPointerCapture：
    // 两者都会让浏览器不派发 click，放大后就点不中地点。等确认是拖动再接管。
  }
  const onMapPointerMove = (evt) => {
    const d = dragRef.current
    if (!d) return
    const dx = (evt.clientX - d.sx) / Math.max(1, d.w)
    const dy = (evt.clientY - d.sy) / Math.max(1, d.h)
    if (!draggedRef.current && Math.abs(evt.clientX - d.sx) + Math.abs(evt.clientY - d.sy) > 3) {
      draggedRef.current = true          // 超过 3px 才算拖动，之后才拦默认行为（防选中文字）
      try { d.el?.setPointerCapture?.(d.pid) } catch (error) { /* 忽略 */ }
    }
    if (!draggedRef.current) return
    if (evt.cancelable) evt.preventDefault()
    const vb = zoomBox()
    const span = vb.w / MAP_W
    setView(clampView({ x: d.vx - dx * span, y: d.vy - dy * span }))
  }
  const onMapPointerUp = (evt) => {
    const d = dragRef.current
    if (d && draggedRef.current) {
      try { d.el?.releasePointerCapture?.(d.pid) } catch (error) { /* 忽略 */ }
    }
    dragRef.current = null
  }

  const onMapClick = (evt) => {
    if (draggedRef.current) { draggedRef.current = false; return }   // 刚拖过，不算点击
    if (!mapMode) return
    const pos = mapPoint(evt, evt.currentTarget)
    const hit = tooClose(pos, mapMode === 'move' ? mapSel : -1)
    if (hit) {
      toast && toast(`这里离「${hit.name}」只有 ${hit.meters}m，太近了（至少 ${Math.round(MIN_GAP * 2000)}m）`, 'err')
      return
    }
    if (mapMode === 'move' && mapSel >= 0) {
      // 落点后停在移动态：还能继续点别的空位改主意，只有「保存」才真正生效
      setMapDraft((prev) => ({ ...(prev || places[mapSel]), x: pos.x, y: pos.y }))
      return
    }
    if (mapMode === 'add') {
      setMapDraft((prev) => ({ ...(prev || { name: '', info: '' }), x: pos.x, y: pos.y }))
      return
    }
  }

  const commitDraft = async () => {
    if (!mapDraft) return
    const hit = tooClose(mapDraft, mapSel)
    if (hit) {
      toast && toast(`「${mapDraft.name || '新地点'}」离「${hit.name}」只有 ${hit.meters}m，先挪远一点（至少 ${Math.round(MIN_GAP * 2000)}m）`, 'err')
      return
    }
    const m = activeMap()
    if (!m) return
    const merged = places.map((p) => ({ ...p }))
    if (mapSel >= 0 && merged[mapSel]) merged[mapSel] = { ...merged[mapSel], ...mapDraft }
    else if (mapDraft.name) merged.push({ ...mapDraft })
    setBusy(true)
    try {
      const r = await call('/regions/save', { id: m.id, places: merged })
      if (r && r.ok === false) { toast && toast(r.message || '保存失败'); return }
      setMaps(r.regions || maps)
      const active = (r.regions?.list || []).find((x) => x.id === (r.regions?.activeId))
      if (active) resetPlaces(active.places)
      setMapDraft(null)
      setDraftIsNew(false)
      setMapSel(-1)
      await loadLive()
      toast && toast('地图已更新', 'ok')
    } finally {
      setBusy(false)
    }
  }

  const regionNow = activeMap() || {}
  const bgNow = regionNow.bg || null
  const bgPresets = (live && live.bgPresets) || null
  const nowState = (live && live.state) || {}
  const decisions = (nowState.decisions || []).slice()
  const fmtClock = (ms) => {
    if (!ms) return ''
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const phaseText = nowState.phase === 'window' || nowState.phase === 'late'
    ? (nowState.nextAskAt && nowState.nextAskAt > Date.now()
        ? `下次移动：约 ${Math.max(1, Math.round((nowState.nextAskAt - Date.now()) / 60_000))} 分钟后（${fmtClock(nowState.nextAskAt)}）`
        : '下次移动：下一次检查就会提醒她定地点')
    : nowState.phase === 'before'
      ? '还没到外出时段'
      : '今天的外出时段已结束'

  const tabBarStyle = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 2,
    borderBottom: '1px solid var(--ab-line, rgba(128,128,128,0.2))',
    marginBottom: 4,
  }
  const TABS = [
    { id: 'status', label: '📊 状态' },
    { id: 'settings', label: '⚙️ 设置' },
    { id: 'map', label: '🗺️ 地图' },
  ]

  const statusCard = (
h(Card, {
      title: '现在在哪 · 今日路线',
      desc: '她现在的位置和理由，以及今天按时间记下的行程（每 30 秒自动刷新）。',
    },
      h(Row, { label: '当前位置' },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600 } }, nowState.place ? nowState.place.name : '（还没定）'),
          nowState.place ? h('span', { className: 'ab-small ab-muted' }, `${fmtClock(nowState.since)} 到的`) : null,
          h(Btn, { small: true, onClick: loadLive }, '刷新'))),
      h(Row, { label: '来这里的理由' },
        h('div', { className: 'ab-small', style: { whiteSpace: 'pre-wrap' } }, nowState.reason || '（没写）')),
      h(Row, { label: '移动节奏' },
        h('span', { className: 'ab-small ab-muted' }, phaseText)),
      h('div', { style: { marginTop: 6, marginBottom: 4, fontWeight: 600 } }, `今日路线（${decisions.length} 条）`),
      decisions.length
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '40vh', overflowY: 'auto', paddingRight: 6 } },
          decisions.map((d, i) => h('div', {
            key: i,
            style: { borderLeft: '3px solid var(--ab-line, rgba(128,128,128,.3))', paddingLeft: 8, fontSize: 13 },
          },
            h('div', { style: { fontWeight: 600 } }, `${fmtClock(d.at)}  ${d.name}`),
            d.reason ? h('div', { className: 'ab-small ab-muted', style: { whiteSpace: 'pre-wrap' } }, d.reason) : null)))
        : h('div', { className: 'ab-small ab-muted' }, '今天还没有行程记录'),
    )
  )

  const subRow = {
    marginLeft: 14,
    paddingLeft: 12,
    borderLeft: '2px solid var(--ab-line, rgba(128,128,128,.35))',
  }

  const settingsCard = (
    h(Card, {
      title: '小世界',
      desc: '从上往下是同一条逻辑：先决定她能不能自己出门，再排出外的时段与节奏，然后是移动方式、汇报、晚回/夜不归宿、每晚总结。',
    },
      // ① 总开关
      h(Row, { label: '允许她自己出门', hint: '关掉后完全不到点催她申报；其余功能照常。到点提醒固定 100%，节奏由下面的「移动间隔」决定' },
        Switch ? h(Switch, { on: curCfg.allowSelfOuting !== false, onChange: (v) => putCfg({ allowSelfOuting: v }) }) : null),
      // ② 外出时段与节奏
      h(Row, { label: '外出开始时间', hint: 'HH:MM，默认 10:00；时段之外不会催她、也不发消息' },
        h('input', {
          className: 'ab-input sm', style: { width: 100, textAlign: 'center' },
          value: curCfg.startTime ?? '10:00',
          onChange: (e) => putCfg({ startTime: e.target.value }),
        })),
      h(Row, { label: '外出结束时间', hint: 'HH:MM，默认 22:00；到点会问晚回 / 夜不归宿' },
        h('input', {
          className: 'ab-input sm', style: { width: 100, textAlign: 'center' },
          value: curCfg.endTime ?? '22:00',
          onChange: (e) => putCfg({ endTime: e.target.value }),
        })),
      h(Row, { label: '移动间隔（小时）', hint: '默认 2 小时提醒一次换地方；这个间隔同时也是申报的节奏' },
        h('input', {
          className: 'ab-input sm', style: { width: 100, textAlign: 'center' }, type: 'number', min: 0.5, max: 12, step: 0.5,
          value: curCfg.intervalHours ?? 2,
          onChange: (e) => putCfg({ intervalHours: Math.max(0.5, Math.min(12, Number(e.target.value) || 2)) }),
        })),
      h(Row, { label: '聊天保护（分钟）', hint: '主人刚发过消息的这段时间里不催她换地方；默认 10 分钟' },
        h('input', {
          className: 'ab-input sm', style: { width: 100, textAlign: 'center' }, type: 'number', min: 1, max: 120, step: 1,
          value: curCfg.chatProtectMinutes ?? 10,
          onChange: (e) => putCfg({ chatProtectMinutes: Math.max(1, Math.min(120, Number(e.target.value) || 10)) }),
        })),
      // ③ 跨地区怎么走
      h(Row, { label: '长途移动手段', hint: '自由填写，会写进位置提示；剑与魔法世界可以填「马车」「飞艇」「传送阵」之类' },
        h('input', {
          className: 'ab-input sm', style: { width: 170 }, placeholder: '电车',
          maxLength: 20,
          value: curCfg.rideMode ?? '电车',
          onChange: (e) => putCfg({ rideMode: e.target.value }),
        })),
      h(Row, { label: '长途移动用时（分钟）', hint: '跨地区那一段坐多久；提示词里的时间会跟着变' },
        h('input', {
          className: 'ab-input sm', style: { width: 90, textAlign: 'center' }, type: 'number', min: 1, max: 600, step: 1,
          value: curCfg.rideMinutes ?? 15,
          onChange: (e) => putCfg({ rideMinutes: Math.max(1, Math.min(600, Number(e.target.value) || 15)) }),
        })),
      // ④ 汇报行程：开关在上，参数紧跟
      h(Row, { label: '汇报行程', hint: '换了地方、或者她选了晚回 / 夜不归宿，都会主动跟你说一声（含原因）' },
        h(Switch, { on: !!curCfg.reportOnMove, onChange: (v) => putCfg({ reportOnMove: !!v }) })),
      h('div', { style: subRow },
        h(Row, { label: '汇报概率（%）', hint: '换了地方后主动说一声的概率；0 = 不主动汇报，100 = 每次都汇报' },
          h('input', {
            className: 'ab-input sm', style: { width: 90, textAlign: 'center' }, type: 'number', min: 0, max: 100, step: 5,
            value: curCfg.reportChance ?? 100,
            onChange: (e) => putCfg({ reportChance: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }),
          }))),
      h('div', { style: subRow },
        h(Row, { label: '汇报最小间隔（分钟）', hint: '两次主动汇报之间至少隔这么久；默认 120（= 2 小时，和移动间隔一致）' },
          h('input', {
            className: 'ab-input sm', style: { width: 90, textAlign: 'center' }, type: 'number', min: 0, max: 600, step: 5,
            value: curCfg.reportMinGapMinutes ?? 120,
            onChange: (e) => putCfg({ reportMinGapMinutes: Math.max(0, Math.min(600, Number(e.target.value) || 0)) }),
          }))),
      // ⑤ 结束时间之后的选择
      h(Row, { label: '允许晚回一小时', hint: '到结束时间时问她要不要再待一小时' },
        h(Switch, { on: !!curCfg.allowLateReturn, onChange: (v) => putCfg({ allowLateReturn: !!v }) })),
      h(Row, { label: '允许夜不归宿', hint: '到点后问她今晚回不回家；选了晚回会在一小时后再问一次' },
        h(Switch, { on: !!curCfg.allowOvernight, onChange: (v) => putCfg({ allowOvernight: !!v }) })),
      // ⑥ 每晚总结：开关在上，时间紧跟
      h(Row, { label: '每晚总结地点', hint: '到点让她回顾今天去过的地方，把新的认知写回地图描述' },
        h(Switch, { on: curCfg.reflectEnabled !== false, onChange: (v) => putCfg({ reflectEnabled: !!v }) })),
      h('div', { style: subRow },
        h(Row, { label: '总结时间', hint: 'HH:MM，默认 23:30' },
          h('input', {
            className: 'ab-input sm', style: { width: 100, textAlign: 'center' },
            value: curCfg.reflectTime ?? '23:30',
            onChange: (e) => putCfg({ reflectTime: e.target.value }),
          }))),
      h('div', { style: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' } },
        h(Btn, { onClick: saveCfg, disabled: !cfgDirty || !save }, cfgDirty ? '保存设置' : '已保存'),
        cfgDirty ? h('span', { className: 'ab-small ab-muted' }, '有没保存的改动') : null),
    )
  )


  const presetCard = (
    h(Card, {
      title: '地图预设',
      desc: '一张地图里可以有多个地区；切换地图会把她带到这张地图的家所在地区。',
    },
      h('div', { style: { ...rowBtn, marginBottom: 8 } },
        h('span', { className: 'ab-small ab-muted' }, '当前地图'),
        (presets.list || []).length
          ? h(Select, {
            value: presets.activeId,
            options: (presets.list || []).map((m) => ({ value: m.id, label: `${m.name}（${(m.regions || []).length} 个地区）` })),
            onChange: (v) => pickMapPreset(v),
          })
          : h('span', { className: 'ab-small ab-muted' }, '还没有地图'),
        h(Btn, { onClick: () => { setCreatingMap(true); setNewMapName(`地图 ${(presets.list || []).length + 1}`) } }, '新建地图')),
      creatingMap
        ? h('div', { style: { ...rowBtn, marginBottom: 8 } },
          h('input', {
            className: 'ab-input', style: { flex: 1, minWidth: 160 }, placeholder: '新地图的名字', value: newMapName,
            onChange: (e) => setNewMapName(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') createMapPreset() },
          }),
          h(Btn, { onClick: createMapPreset }, '创建'),
          h(Btn, { onClick: () => { setCreatingMap(false); setNewMapName('') } }, '取消'))
        : null,
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 4 } },
        (presets.list || []).length
          ? (presets.list || []).map((m) => `${m.name}：${(m.regions || []).length} 个地区`).join('｜')
          : '还没有地图'),
    )
  )

  const mapCard = (
h(Card, {
      title: `平面地图${activeMap() ? `（${activeMap().name} · ${places.length} 个地点）` : ''}`,
      desc: '一个地区一张方图，约 2km × 2km。点圆点看地点；「移动所选地点 / 添加地点」后点地图空位落点（可反复点、可取消），最后点「保存到地区」。🚉 车站 = 跨地区移动时默认着陆的位置，站名和简介都可以改成贴合世界观的说法。',
    },
      h('div', { style: { ...rowBtn, marginBottom: 8 } },
        h('span', { className: 'ab-small ab-muted' }, '当前地区'),
        (maps.list || []).length
          ? h(Select, {
            value: maps.activeId,
            options: (maps.list || []).map((m) => ({ value: m.id, label: `${m.name}（${(m.places || []).length} 个地点）` })),
            onChange: (v) => pickRegion(v),
          })
          : h('span', { className: 'ab-small ab-muted' }, '还没有地图'),
        h(Btn, { onClick: () => { setCreating(true); setNewName(`地区 ${(maps.list || []).length + 1}`) } }, '新建地区'),
        (maps.list || []).length > 1
          ? h(Btn, { onClick: doDeleteMap }, confirmDel === (activeMap() && activeMap().id) ? '再点一次确认删除' : '删除这个地区')
          : null,
      ),

      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 8 } },
        (live && live.travel)
          ? `🚶 正在路上：${live.travel.steps[live.travel.index] ? `${live.travel.steps[live.travel.index].kind === 'ride' ? '乘车' : '走路'} → ${live.travel.target.placeName}` : '即将到达'}（第 ${Math.min(live.travel.index + 1, live.travel.steps.length)}/${live.travel.steps.length} 段）`
          : `查看中：${(regionNow && regionNow.name) || '—'}　｜　她所在：${(live && live.placeRegion && live.placeRegion.name) || '—'}${(live && live.state && live.state.place) ? ` · ${live.state.place.name}` : ''}`),
      creating
        ? h('div', { style: { ...rowBtn, marginBottom: 8 } },
          h('input', {
            className: 'ab-input', style: { flex: 1, minWidth: 160 }, placeholder: '新地区的名字', value: newName,
            onChange: (e) => setNewName(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') doCreate() },
          }),
          h(Btn, { onClick: doCreate }, '创建'),
          h(Btn, { onClick: () => { setCreating(false); setNewName('') } }, '取消'))
        : null,

      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 } },
        h('span', { className: 'ab-small ab-muted' }, '背景'),
        (bgPresets && bgPresets.length ? bgPresets : BG_FALLBACK).map((b) => h(Btn, {
          key: b.id,
          small: true,
          kind: (bgNow && bgNow.type === 'preset' && bgNow.id === b.id) ? 'primary' : undefined,
          onClick: () => applyBg({ type: 'preset', id: b.id }),
        }, b.name)),
        h('label', {
          className: 'ab-btn ab-btn-sm',
          style: { cursor: 'pointer', padding: '4px 10px', border: '1px solid var(--ab-line, rgba(128,128,128,.3))', borderRadius: 8 },
          title: '导入自己的图片（会压到 1024px 内，随地区保存）',
        },
          '导入图片',
          h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: pickBgFile })),
        h(Btn, { small: true, onClick: () => applyBg(null) }, '无背景')),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 } },
        h(Btn, { small: true, onClick: startMove, disabled: mapSel < 0 || busy }, '移动所选地点'),
        h(Btn, { small: true, onClick: startAdd, disabled: busy }, '添加地点'),
        mapSel >= 0 ? h(Btn, {
          small: true,
          onClick: () => deletePlaceAt(mapSel),
          disabled: busy || (places[mapSel] && (places[mapSel].station || places[mapSel].name === '家')),
        }, confirmDelPlace === mapSel ? '确认删除' : '删除地点') : null,
        mapDraft
          ? h(Btn, { small: true, kind: 'primary', onClick: commitDraft, disabled: busy },
            busy ? '保存中…' : ((draftIsNew || movingIdx >= 0) ? '保存到地区' : '保存修改'))
          : null,
        mapDraft
          ? h(Btn, { small: true, onClick: cancelDraft, disabled: busy }, '取消')
          : null,
        mapMode ? h('span', { className: 'ab-small ab-muted' }, mapMode === 'move' ? '点地图选新位置…（可反复点，保存前都算预览）' : '点地图选新地点位置…（可点「取消」退出）') : null),
      h('div', { style: { display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' } },
        h('div', { style: { flex: '1 1 320px', minWidth: 280, position: 'relative' } },
          h('svg', {
            viewBox: `${zoomBox().x} ${zoomBox().y} ${zoomBox().w} ${zoomBox().h}`,
            onClick: onMapClick,
            onPointerDown: onMapPointerDown,
            onPointerMove: onMapPointerMove,
            onPointerUp: onMapPointerUp,
            onPointerCancel: onMapPointerUp,
            style: {
              width: '100%', height: 'auto', background: 'var(--ab-card, rgba(127,127,127,.06))',
              border: '1px solid var(--ab-line, rgba(128,128,128,.25))', borderRadius: 10,
              touchAction: 'none',
              cursor: mapMode ? 'crosshair' : (zoomOf() > 1.01 ? 'grab' : 'default'),
            },
          },
            // 背景（预设场景 / 自定义图片）
            bgNow && bgNow.type === 'image'
              ? h('image', {
                href: bgNow.data,
                x: 0, y: 0, width: MAP_W, height: MAP_W,
                preserveAspectRatio: 'xMidYMid slice',
                opacity: 0.62,
              })
              : null,
            bgNow && bgNow.type === 'preset' ? bgScene(bgNow.id) : null,
            // 网格
            [0, 0.25, 0.5, 0.75, 1].map((t) => h('line', {
              key: 'v' + t, x1: t * MAP_W, y1: 0, x2: t * MAP_W, y2: MAP_W,
              stroke: 'rgba(128,128,128,.22)', strokeWidth: 1,
            })),
            [0, 0.25, 0.5, 0.75, 1].map((t) => h('line', {
              key: 'h' + t, x1: 0, y1: t * MAP_W, x2: MAP_W, y2: t * MAP_W,
              stroke: 'rgba(128,128,128,.22)', strokeWidth: 1,
            })),
            // 比例尺文字
            h('text', { x: 10, y: MAP_W - 12, fontSize: 26, fill: 'currentColor', opacity: 0.55 }, '0'),
            h('text', { x: MAP_W - 90, y: MAP_W - 12, fontSize: 26, fill: 'currentColor', opacity: 0.55 }, '2 km'),
            // 地点
            places.map((p, i) => {
              const cx = (Number(p.x) || 0.5) * MAP_W
              const cy = (Number(p.y) || 0.5) * MAP_W
              const isSel = i === mapSel
              const icon = p.icon || (p.station ? '🚉' : (p.name === '家' ? '🏠' : (p.tags || []).includes('打工') ? '💼' : '📍'))
              return h('g', { key: i, style: { cursor: 'pointer' } },
                // 点击热区：只覆盖圆点周围一小圈，名字/图标文字不参与点击，
                // 否则上方的地名会把相邻的点挡住，点不中。
                h('circle', {
                  cx, cy, r: 34, fill: 'transparent',
                  onClick: (e) => { e.stopPropagation(); selectPlace(i) },
                }),
                h('circle', {
                  cx, cy, r: isSel ? 30 : 22,
                  fill: isSel ? 'rgba(239,68,68,.85)' : 'rgba(99,102,241,.75)',
                  stroke: '#fff', strokeWidth: 2, pointerEvents: 'none',
                }),
                h('text', { x: cx, y: cy + 9, fontSize: 26, textAnchor: 'middle', pointerEvents: 'none' }, icon),
                h('text', {
                  x: cx, y: cy - 32, fontSize: 22, textAnchor: 'middle', fill: 'currentColor', opacity: 0.85,
                  pointerEvents: 'none',
                  // 文字描一层底，压在背景/其它元素上也看得清
                  style: { paintOrder: 'stroke', stroke: 'rgba(0,0,0,.35)', strokeWidth: 4 },
                }, String(p.name || '').slice(0, 10)),
              )
            }),
            // 正在编辑/新增的点（预览）
            mapDraft && mapDraft.x !== undefined && (draftIsNew || movingIdx >= 0)
              ? h('g', { opacity: 0.95 }, null,
                h('circle', {
                  cx: mapDraft.x * MAP_W, cy: mapDraft.y * MAP_W, r: 26,
                  fill: 'rgba(34,197,94,.85)', stroke: '#fff', strokeWidth: 2,
                }),
                movingIdx >= 0 && places[movingIdx]
                  ? h('line', {
                    x1: places[movingIdx].x * MAP_W, y1: places[movingIdx].y * MAP_W,
                    x2: mapDraft.x * MAP_W, y2: mapDraft.y * MAP_W,
                    stroke: 'rgba(34,197,94,.7)', strokeWidth: 3, strokeDasharray: '10 8',
                  })
                  : null,
                h('text', { x: mapDraft.x * MAP_W, y: mapDraft.y * MAP_W - 36, fontSize: 22, textAnchor: 'middle', fill: 'currentColor' },
                  (mapDraft.name || '新地点') + (movingIdx >= 0 ? ' · 新位置' : '')))
              : null,
          ),
          // 右下角：缩放滑块
          h('div', {
            style: {
              position: 'absolute', right: 10, bottom: 10, zIndex: 3,
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 8px', borderRadius: 8,
              background: 'var(--ab-card, rgba(20,20,20,.72))',
              border: '1px solid var(--ab-line, rgba(128,128,128,.3))',
              backdropFilter: 'blur(2px)',
            },
            onClick: (e) => e.stopPropagation(),
          },
            h('span', { className: 'ab-small ab-muted' }, '缩放'),
            h('input', {
              type: 'range', min: 1, max: 3, step: 0.1, value: zoomOf(),
              style: { width: 96 },
              onChange: (e) => setZoom(Number(e.target.value) || 1),
            }),
            h('span', { className: 'ab-small ab-muted', style: { width: 34, textAlign: 'right' } }, `${Math.round(zoomOf() * 100)}%`),
            h(Btn, {
              small: true,
              onClick: () => { setZoom(1); setView({ x: 0.5, y: 0.5 }) },
            }, '复位')),
        ),
        // 右侧：选中的地点信息 / 编辑
        h('div', { style: { flex: '1 1 240px', minWidth: 220, display: 'flex', flexDirection: 'column', gap: 6 } },
          mapDraft
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('input', {
                className: 'ab-input', placeholder: '地点名', value: mapDraft.name || '',
                disabled: mapDraft.name === '家',
                onChange: (e) => setMapDraft((prev) => ({ ...prev, name: e.target.value })),
              }),
              mapDraft.station
                ? h('div', { className: 'ab-small ab-muted' }, '车站：跨地区移动时默认就落在这里；名字和简介都能改，改成贴合世界观的站名也行')
                : null,
              h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' } },
                h('span', { className: 'ab-small ab-muted' }, '图标'),
                PLACE_ICONS.map((ic) => h(Btn, {
                  key: ic, small: true,
                  kind: (mapDraft.icon || '') === ic ? 'primary' : undefined,
                  onClick: () => setMapDraft((prev) => ({ ...prev, icon: ic })),
                  title: `用 ${ic} 当这个地点的图标`,
                }, ic)),
                mapDraft.icon
                  ? h(Btn, { small: true, onClick: () => setMapDraft((prev) => ({ ...prev, icon: '' })) }, '默认')
                  : null),
              h('textarea', {
                className: 'ab-textarea', style: { minHeight: 70, resize: 'vertical' }, placeholder: '这地方是什么样',
                value: mapDraft.info || '',
                onChange: (e) => setMapDraft((prev) => ({ ...prev, info: e.target.value })),
              }),
              h('div', { className: 'ab-small ab-muted' },
                `坐标 ${Math.round((mapDraft.x ?? 0) * 2000)} , ${Math.round((mapDraft.y ?? 0) * 2000)} m（0~2000）`),
              mapDraft.name !== '家' && !mapDraft.station
                ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                  h('span', { className: 'ab-small ab-muted' }, '喜好权重'),
                  h('input', {
                    className: 'ab-input', style: { width: 90, textAlign: 'center' }, type: 'number', min: 0, max: 200, step: 5,
                    value: mapDraft.pref ?? 100,
                    onChange: (e) => setMapDraft((prev) => ({ ...prev, pref: Math.max(0, Math.min(200, Number(e.target.value) || 0)) })),
                  }),
                  h('span', { className: 'ab-small ab-muted' }, '0~200，越高越想去（每晚总结也会自己调）'))
                : h('div', { className: 'ab-small ab-muted' }, '家和车站是固定地点，没有喜好权重'),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                mapDraft.name !== '家' && !mapDraft.station
                  ? h(Btn, { small: true, onClick: () => deletePlaceAt(mapSel), disabled: busy || mapSel < 0 },
                    confirmDelPlace === mapSel ? '确认删除' : '删除这个地点')
                  : h('span', { className: 'ab-small ab-muted' }, mapDraft.station ? '车站不能删' : '「家」不能删'),
                h(Btn, { small: true, kind: 'primary', onClick: commitDraft, disabled: busy },
                  busy ? '保存中…' : ((draftIsNew || movingIdx >= 0) ? '保存到地区' : '保存修改')),
                h(Btn, { small: true, onClick: cancelDraft, disabled: busy }, '取消')),
            )
            : h('div', { className: 'ab-small ab-muted' }, '点地图上的圆点看地点信息；或「添加地点」后点空白处。'),
        )),
    )
  )

  const regionCard = (
h(Card, {
      title: '地点卡片',
      desc: '地区在「平面地图」上方切换；这里编辑当前地区的地点（「家」和「车站」是固定卡）。标签：💰 可以打工挣钱，❤️ 可以暧昧、有特殊服务的地方。喜好权重 0~200：越高她越倾向于去那儿（只对非固定地点有效，家和车站不参与）；每晚总结会按当天经历自动加减。',
    },
      err ? h('div', { className: 'ab-note err' }, err) : null,

      h('div', { style: { ...rowBtn, marginBottom: 10 } },
        h(Btn, { onClick: saveMapNow, disabled: busy || !dirty }, busy ? '保存中…' : (dirty ? '保存地区' : '没有改动')),
        h(Btn, { onClick: addPlace }, '添加地点'),
        dirty ? h('span', { className: 'ab-small ab-muted' }, '有没保存的地点改动') : null),

      places.length
        ? h('div', {
          // 单列、可滚动：地点多了就在框里滚
          style: {
            display: 'flex', flexDirection: 'column', gap: 10,
            maxHeight: '58vh', overflowY: 'auto', paddingRight: 6,
          },
        }, places.map((p, i) => h('div', { key: i, style: cardStyle },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('span', {
              style: { fontSize: 20, lineHeight: 1, cursor: 'pointer' },
              title: '点一下切换图标',
              onClick: () => {
                const cur = p.icon || ''
                const at = PLACE_ICONS.indexOf(cur)
                patchPlace(i, { icon: PLACE_ICONS[(at + 1) % PLACE_ICONS.length] })
              },
            }, p.icon || (p.station ? '🚉' : (p.name === '家' ? '🏠' : (p.tags || []).includes('打工') ? '💼' : '📍'))),
            h('input', {
              className: 'ab-input', style: { flex: 1, fontWeight: 600 },
              placeholder: '地点名', value: p.name || '',
              disabled: p.name === '家',
              onChange: (e) => patchPlace(i, { name: e.target.value }),
            }),
            h('span', { className: 'ab-small ab-muted' }, p.name === '家' ? '固定' : (p.station ? '车站' : '')),
            h(Btn, { onClick: () => delPlace(i), disabled: p.name === '家' || p.station === true },
              p.name === '家' ? '不可删' : (p.station ? '必有' : '删除'))),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            TAGS.map((t) => {
              const on = Array.isArray(p.tags) && p.tags.includes(t.key)
              return h(Btn, {
                key: t.key,
                small: true,
                onClick: () => toggleTag(i, t.key),
                title: on ? `取消「${t.key}」标签` : `标记为「${t.key}」`,
              }, `${t.emoji} ${t.key}${on ? ' ✓' : ''}`)
            })),
          p.name !== '家' && !p.station
            ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h('span', { className: 'ab-small ab-muted' }, '喜好'),
              h('input', {
                className: 'ab-input', style: { width: 80, textAlign: 'center' }, type: 'number', min: 0, max: 200, step: 5,
                value: p.pref ?? 100,
                onChange: (e) => patchPlace(i, { pref: Math.max(0, Math.min(200, Number(e.target.value) || 0)) }),
              }),
              h('span', { className: 'ab-small ab-muted' }, '越高越想去'))
            : h('div', { className: 'ab-small ab-muted' }, '固定地点，不参与喜好权重'),
          h('textarea', {
            className: 'ab-textarea',
            style: { minHeight: 58, resize: 'vertical' },
            placeholder: p.name === '家' ? '家的样子（留空用默认：一室一厅的小公寓……）' : '这地方是什么样（一句话）',
            value: p.info || '',
            onChange: (e) => patchPlace(i, { info: e.target.value }),
          }))))
        : h(Empty, { icon: '📍', text: '这张地图还没有地点，点「添加地点」' }),
    )
  )

  return h('div', { className: 'ab-grid' },
    h('div', { role: 'tablist', style: tabBarStyle },
      TABS.map((t) => h('button', {
        key: t.id,
        type: 'button',
        role: 'tab',
        'aria-selected': tab === t.id,
        className: 'ab-tab' + (tab === t.id ? ' on' : ''),
        onClick: () => setTab(t.id),
      }, t.label))),
    tab === 'status' ? statusCard : null,
    tab === 'settings' ? settingsCard : null,
    tab === 'map'
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, presetCard, mapCard, regionCard)
      : null,
  )
}
