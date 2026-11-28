// 小世界（real-world）：给她一个具体的地理位置和时间表。
//
// 做这几件事：
//   1) 地图配置：可以保存多套地图，随时切换；新地图默认只有一张「家」的固定卡片（删不掉）
//   2) 时间表：外出活动时间段（默认 10:00–22:00）+ 移动间隔（默认 2 小时）
//   3) 到点提醒：该动身时主动提醒她自己选地点和理由，用工具 real_world_move 记下来
//   4) 每轮注入：现在在哪、这个地方是什么样、她当初为什么来
//   5) 汇报行程（可选）：到点换了地方，就主动跟主人说一声
//
// 两个松绑开关：
//   - 允许晚回：22:00 之后可以自己选择再玩一小时（最晚 23:00）
//   - 允许夜不归宿：今晚可以自己选择不回家

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const DEFAULTS = {
  enabled: true,
  startTime: '10:00',
  endTime: '22:00',
  intervalHours: 2,
  allowLateReturn: false,
  allowOvernight: false,
  reportOnMove: true,    // 到点换了地方 / 选了晚回或夜不归宿，主动跟主人汇报（默认开）
  chatProtectMinutes: 10, // 主人刚发过消息（默认 10 分钟内）就不催换地方
  allowSelfOuting: true,  // 允许她自己出门：关掉就完全不到点催她申报
  reportChance: 100,      // 换地方后主动汇报的触发概率（0~100）
  reportMinGapMinutes: 120, // 两次汇报之间至少隔多久（分钟，默认跟移动间隔一样是 2 小时）
  rideMode: '电车',        // 跨地区长途手段（自由填写，提示词里用它）
  rideMinutes: 15,        // 跨地区那一段坐多久（分钟）
  reflectEnabled: true,   // 每晚到点让她总结今天的经历、修地图
  reflectTime: '23:30',   // 总结时间
}

const DEFAULT_HOME_INFO = '一室一厅的小公寓，窗帘常年只拉一半，桌上有没写完的谱子'
const DEFAULT_REGION_NAME = '家附近'
const STATION_NAME = '车站'
const STATION_INFO = '离家最近的车站，站台不长，晚上只剩几盏灯'

/** 平面地图背景预设（简约平面地图风格，面板里按 id 画）。 */
const BG_PRESETS = [
  { id: 'urban', name: '都市' },
  { id: 'rural', name: '乡村' },
  { id: 'suburb', name: '郊外' },
  { id: 'wild', name: '山野' },
  { id: 'fantasy', name: '异世界' },
]
const BG_IDS = BG_PRESETS.map((b) => b.id)
const TRAVEL_WALK_NAME = '移动中'
const TRAVEL_RIDE_NAME = '长途移动中'
const TRAVEL_PLACE_NAMES = [TRAVEL_WALK_NAME, TRAVEL_RIDE_NAME]
const BG_IMAGE_MAX = 2_000_000   // 自定义背景图（data URL）最长 2MB，超了拒收

/** 地区背景：预设 id 或自定义图片 data URL。 */
function normalizeBg(bg) {
  if (!bg || typeof bg !== 'object') return null
  if (bg.type === 'preset' && BG_IDS.includes(String(bg.id))) return { type: 'preset', id: String(bg.id) }
  if (bg.type === 'image' && typeof bg.data === 'string' && /^data:image\//.test(bg.data) && bg.data.length <= BG_IMAGE_MAX) {
    return { type: 'image', data: bg.data }
  }
  return null
}

/** 地点标签：目前两种，面板上可以点开。 */
const TAGS = [
  { key: '打工', emoji: '💰', label: '打工' },
  { key: '情色', emoji: '❤️', label: '情色' },
]
const TAG_KEYS = TAGS.map((t) => t.key)
const tagEmoji = (key) => (TAGS.find((t) => t.key === key) || {}).emoji || ''

/** 内置地图：名字 + 一句“这地方是什么样”。 */
const BUILTIN_PLACES = [
  { name: '家', info: DEFAULT_HOME_INFO, fixed: true },
  { name: '楼下便利店', info: '24 小时，关东煮和罐装咖啡，店员认识她，从不问为什么半夜来' },
  { name: '街角咖啡馆', info: '二楼靠窗能看见整条街，人少，适合摊开本子写东西' },
  { name: '市立图书馆', info: '很安静，二层有可预约的琴房，管理员严格但会给常客留位置' },
  { name: '河边步道', info: '傍晚风大，路灯一盏一盏亮起来，栏杆边能听见水声' },
  { name: '公园长椅', info: '有几棵老树和一座钢琴雕塑，周末会有街头艺人' },
  { name: '商业街', info: '人多、霓虹和橱窗，走久了脚会累，但也最不容易被认出来' },
  { name: '公寓天台', info: '能看到半个城区，风比地面大，晚上有点冷' },
  { name: '学校琴房', info: '白天没人的时候能进去练一会儿，琴有点旧，中音区有个键发闷' },
  { name: '猫咖', info: '十几只猫，角落最里面那只黑猫愿意靠过来' },
  { name: '超市', info: '生鲜在负一层，晚上八点后打折，阿姨会用大嗓门喊' },
  { name: '旧书店', info: '能站着看一下午，老板不管，结账时才抬头' },
  { name: '地铁站', info: '换乘通道很长，风从隧道里吹上来，混着人声' },
  { name: '河堤', info: '走二十分钟能到，风比街上大，晚上有人在遛狗' },
]

const MOD = 'real-world'

function parseHm(text, fallback) {
  const m = String(text || '').match(/^(\d{1,2})[:：](\d{2})$/)
  if (!m) return fallback
  const h = Number(m[1]); const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback
  return h * 60 + min
}

const fmtHm = (minutes) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

const ymdOf = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const minutesOf = (ms) => {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

const clockOf = (ms) => fmtHm(minutesOf(ms))
const uid = () => Math.random().toString(36).slice(2, 8)

/** 一个地区的地点列表：「家」只可能出现在其中一个地区；车站每个地区必有。 */
function normalizePlaces(places) {
  const list = (Array.isArray(places) ? places : [])
    .map((p) => {
      const info = String(p?.info || '').trim().slice(0, 120)
      const infoBase = String(p?.infoBase || '').trim().slice(0, 120)
      const updatedAt = Number(p?.updatedAt) || 0
      const travel = Number(p?.travelMinutes)
      const prefRaw = Number(p?.pref)
      const x = Number(p?.x)
      const y = Number(p?.y)
      return {
        name: String(p?.name || '').trim().slice(0, 20),
        info,
        // 平面地图坐标：0~1，左上角是 (0,0)；一个地区约 2km×2km
        ...(Number.isFinite(x) && x >= 0 && x <= 1 ? { x: Math.round(x * 1000) / 1000 } : {}),
        ...(Number.isFinite(y) && y >= 0 && y <= 1 ? { y: Math.round(y * 1000) / 1000 } : {}),
        ...(infoBase ? { infoBase } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        // 预留：从别处过来要走多少分钟（移动用时功能还没做，先留位）
        ...(Number.isFinite(travel) && travel > 0 ? { travelMinutes: Math.round(travel) } : {}),
        // 喜好权重：0~200，默认 100；越高她越倾向于去这里（面板可改，每晚总结也会调）
        pref: Number.isFinite(prefRaw) ? Math.max(0, Math.min(200, Math.round(prefRaw))) : 100,
        // 自定义图标（emoji，留空就用默认判定）
        ...(String(p?.icon || '').trim() ? { icon: String(p.icon).trim().slice(0, 4) } : {}),
        tags: (Array.isArray(p?.tags) ? p.tags : []).map((t) => String(t).trim()).filter((t) => TAG_KEYS.includes(t)),
        // 记下输入里的标记（后面还要按 flag 判断车站/家，不能在这里丢掉）
        ...(p?.station === true ? { station: true } : {}),
        ...(p?.fixed === true ? { fixed: true } : {}),
      }
    })
    .filter((p) => p.name)

  // 「家」不再强制：一个地图里只有某一个地区有家（在外面由 normalizeMap 保证）
  // 注意：站名可以自定义（例如「XX 站」），所以 station 标记要沿用输入
  const out = list.map((p) => ({
    ...p,
    fixed: p.name === '家' ? true : undefined,
    station: p.station === true ? true : undefined,
  }))
  // 每个地区必须有且只有一个车站（固定卡，删不掉；简介可改）
  const stationIdx = out.findIndex((p) => p.station === true || p.name === STATION_NAME)
  if (stationIdx >= 0) {
    out[stationIdx] = { ...out[stationIdx], station: true, info: out[stationIdx].info || STATION_INFO }
  } else {
    out.push({ name: STATION_NAME, info: STATION_INFO, station: true })
  }
  return out.map((p) => {
    const clean = { ...p }
    if (!clean.fixed) delete clean.fixed
    if (!clean.station) delete clean.station
    return clean
  })
}

/** 两个地点之间至少隔开这么多（归一化坐标；地图 2km，0.05 ≈ 100m，比图标大一圈）。 */
const MIN_GAP = 0.09

// 移动耗时：每 100 米 2 分钟；跨地区中间那段的时长与手段都走设置
const WALK_METERS_PER_2MIN = 100
const DEFAULT_RIDE_MINUTES = 15

/** 找出离得太近的地点对。 */
function spacingConflicts(places) {
  const out = []
  const pts = (places || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const dx = pts[i].x - pts[j].x
      const dy = pts[i].y - pts[j].y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < MIN_GAP) out.push({ a: pts[i].name, b: pts[j].name, d: Math.round(d * 2000) })
    }
  }
  return out
}

/** 把重叠的点沿径向推开（只动后出现的那个）。 */
function separatePlaces(places) {
  const list = (places || []).map((p) => ({ ...p }))
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i]
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue
    for (let j = 0; j < i; j += 1) {
      const b = list[j]
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue
      let dx = a.x - b.x
      let dy = a.y - b.y
      let d = Math.sqrt(dx * dx + dy * dy)
      if (d >= MIN_GAP) continue
      if (d < 1e-6) { dx = 0; dy = -1; d = 1 }
      const push = (MIN_GAP - d) + 0.005
      a.x = Math.min(0.97, Math.max(0.03, Math.round((a.x + (dx / d) * push) * 1000) / 1000))
      a.y = Math.min(0.97, Math.max(0.03, Math.round((a.y + (dy / d) * push) * 1000) / 1000))
    }
  }
  return list
}

/**
 * 自动给新地点选一个位置：
 *   1) 把地图切成四块，数一下每块里已有地点数
 *   2) 选地点最少的那块（并列就随机一块）
 *   3) 在块里随机挑一个已有地点当锚点（块里没地点就用块中心）
 *   4) 以锚点为圆心随机角度、随机距离（略大于禁区）试位置，避开所有已有地点的禁区
 */
function pickAutoPosition(places, minGap = MIN_GAP) {
  const pts = (places || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  const quadOf = (p) => (p.x < 0.5 ? 0 : 1) + (p.y < 0.5 ? 0 : 2)   // 0 左上 1 右上 2 左下 3 右下
  const counts = [0, 0, 0, 0]
  for (const p of pts) counts[quadOf(p)] += 1
  const fewest = Math.min(...counts)
  const pickFrom = [0, 1, 2, 3].filter((q) => counts[q] === fewest)
  const q = pickFrom[Math.floor(Math.random() * pickFrom.length)]

  const bounds = (qq) => ({
    x0: qq % 2 === 0 ? 0.05 : 0.53,
    x1: qq % 2 === 0 ? 0.47 : 0.95,
    y0: qq < 2 ? 0.05 : 0.53,
    y1: qq < 2 ? 0.47 : 0.95,
  })
  const b = bounds(q)
  const center = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }
  const inQuad = pts.filter((p) => quadOf(p) === q)
  const anchor = inQuad.length ? inQuad[Math.floor(Math.random() * inQuad.length)] : center

  const farEnough = (x, y) => pts.every((p) => Math.hypot(p.x - x, p.y - y) >= minGap)

  for (let i = 0; i < 400; i += 1) {
    const angle = Math.random() * Math.PI * 2
    const dist = minGap * (1.05 + Math.random() * 1.4)
    const x = Math.min(b.x1, Math.max(b.x0, anchor.x + Math.cos(angle) * dist))
    const y = Math.min(b.y1, Math.max(b.y0, anchor.y + Math.sin(angle) * dist))
    if (farEnough(x, y)) return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }
  }

  // 兜底：在这块里按网格找第一个空位
  for (let gx = b.x0; gx <= b.x1; gx += 0.03) {
    for (let gy = b.y0; gy <= b.y1; gy += 0.03) {
      if (farEnough(gx, gy)) return { x: Math.round(gx * 1000) / 1000, y: Math.round(gy * 1000) / 1000 }
    }
  }
  return { x: Math.round(center.x * 1000) / 1000, y: Math.round(center.y * 1000) / 1000 }
}

/** 两点之间的走路分钟数（按直线距离，每 100m 约 2 分钟）。 */
function walkMinutesBetween(a, b) {
  if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(b.x) || !Number.isFinite(a.y) || !Number.isFinite(b.y)) return 5
  const meters = Math.hypot(a.x - b.x, a.y - b.y) * 2000
  return Math.max(1, Math.round(meters / (WALK_METERS_PER_2MIN / 2)))
}

/** 给没有坐标的地点自动排位置：车站在中心，家在中心偏一点，其余用 pickAutoPosition。 */
function layoutPlaces(places) {
  const list = places.map((p) => ({ ...p }))
  const station = list.find((p) => p.station) || list.find((p) => p.name === STATION_NAME)
  const home = list.find((p) => p.name === '家')
  if (station && station.x === undefined) { station.x = 0.5; station.y = 0.5 }
  if (home && home.x === undefined) { home.x = 0.42; home.y = 0.62 }

  const rest = list.filter((p) => p !== station && p !== home && p.x === undefined)
  for (const p of rest) {
    const placed = list.filter((x) => x !== p && Number.isFinite(x.x) && Number.isFinite(x.y))
    const pos = pickAutoPosition(placed)
    p.x = pos.x
    p.y = pos.y
  }
  return separatePlaces(list)
}

/** 一个地区：名字 + 地点（车站必有；家只可能在其中一个地区）。 */
function normalizeRegion(region, fallbackName = DEFAULT_REGION_NAME) {
  const r = region && typeof region === 'object' ? region : {}
  return {
    ...r,
    id: r.id || uid(),
    name: String(r.name || '').trim().slice(0, 20) || fallbackName,
    scaleMeters: Number(r.scaleMeters) > 0 ? Number(r.scaleMeters) : 2000,
    bg: normalizeBg(r.bg),
    places: layoutPlaces(normalizePlaces(r.places)),
  }
}

/**
 * 一个地图预设：包含多个地区；整张地图里「家」只能有一个。
 * 顺序规则：把有「家」的地区放最前，方便看。
 */
function normalizeMap(map) {
  const m = map && typeof map === 'object' ? map : {}
  let regions = (Array.isArray(m.regions) ? m.regions : []).map((r, i) => normalizeRegion(r, i === 0 ? DEFAULT_REGION_NAME : `地区 ${i + 1}`))
  if (!regions.length) regions = [normalizeRegion(null)]

  // 全地图只留一个「家」：第一个带家的地区保留，其余删掉家（家不该出现在两个地区）
  let homeRegionId = ''
  for (const r of regions) {
    const homeIdx = r.places.findIndex((p) => p.name === '家')
    if (homeIdx < 0) continue
    if (!homeRegionId) {
      homeRegionId = r.id
      r.places[homeIdx] = { ...r.places[homeIdx], fixed: true, info: r.places[homeIdx].info || DEFAULT_HOME_INFO }
    } else {
      r.places = r.places.filter((_, i) => i !== homeIdx)
    }
  }
  // 一个家都没有：默认放在第一个地区
  if (!homeRegionId) {
    const first = regions[0]
    first.places.unshift({ name: '家', info: DEFAULT_HOME_INFO, fixed: true })
    homeRegionId = first.id
  }
  // 有家的地区排最前
  regions = [...regions].sort((a, b) => (a.id === homeRegionId ? -1 : 0) - (b.id === homeRegionId ? -1 : 0))
  return {
    ...m,
    id: m.id || uid(),
    name: String(m.name || '').trim().slice(0, 20) || '默认地图',
    homeRegionId,
    regions,
  }
}

export default {
  id: MOD,
  name: '小世界',
  version: '0.3.1',
  api: 1,
  description:
    '给她和你一个真正属于你们的小世界：地图完全自定义（地点卡片 + 简介 + 标签，可存多套随时切换），她按时段申报去哪儿、为什么去；每晚还会把当天的经历回访成新的认知写回地点描述——这个世界会跟着你们一起变。',
  panel: 'panel.js',
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
  ],

  setup(api) {
    const log = api.log
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })

    // ---------- 按人格隔离 ----------
    // 每个人格一份状态：modules-data/real-world/personas/<人格 id>.json
    // 地图配置、当前位置、今天的路线、晚回/夜不归宿 全部互不干扰。
    const pidOf = () => {
      const raw = api.config()?.persona?.current || 'default'
      return String(raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'default'
    }
    const fileFor = (pid) => api.dataDir('personas', `${pid}.json`)

    // ---------- 状态 ----------
    let state = null
    let statePid = ''
    function emptyState() {
      return {
        version: 2,
        ymd: '',
        regions: null,       // [{ id, name, places: [{name,info,fixed,station,tags}] }]
        activeRegionId: '',
        place: null,         // { name, info }
        since: 0,
        reason: '',
        decisions: [],
        nextAskAt: 0,
        lastOwnerAt: 0,      // 主人最后一次说话的时间（聊天保护用）
        awaitingMove: false, // 提醒过了、她还没申报
        awaitingSince: 0,
        naggedAt: 0,
        lateReturn: false,
        overnight: false,
        endAsked: false,        // 外出时段结束时（晚归/夜不归宿一起问）已经问过没
        overnightAsked: false,  // 晚归时段结束后那次「今晚回不回家」问过没
        overnightDecided: false, // 她有没有真的决定过今晚回不回家
        styleSamples: [],    // 她最近写过的理由（跨天保留，用来维持写作风格）
        lastAskAt: 0,       // 上一次真正发出「该申报了」提醒的时间（最小间隔用）
        travel: null,        // 正在进行的移动：{ steps: [{kind,fromName,toName,regionId,endsAt,minutes}], index, reason, target:{regionId,placeName} }
        lastTurnAt: 0,       // 最近一次对话轮次的时间（用来避免汇报紧跟一条回复又开新轮）
        lastReportAt: 0,     // 最近一次换地点汇报的时间（冷却用）
        reflectYmd: '',      // 已经总结过哪天（防止同一天重复）
        reflectNote: '',     // 最近一次总结的说明（给面板/调试看）
      }
    }
    function loadFor(pid) {
      try {
        const j = JSON.parse(readFileSync(fileFor(pid), 'utf8'))
        return { ...emptyState(), ...j }
      } catch (error) {
        // 这个人格还没有存档：给一份空状态，ensureMaps() 会补上默认地图 + 地区
        return emptyState()
      }
    }

    /** 切人格/首次调用时把状态换成这个人格的那份。 */
    function ensureState() {
      const pid = pidOf()
      if (state && statePid === pid) return settleHome()
      statePid = pid
      state = loadFor(pid)
      return settleHome()
    }

    /**
     * 模块刚启动（含热重载）时调用：如果待办时间已经过期，就往后再推一个间隔。
     * 这样重启 / 改文件不会立刻催她一次。
     */
    function clampAskAfterBoot(now = Date.now()) {
      const interval = intervalMs()
      if (!state.nextAskAt || state.nextAskAt <= now) {
        const old = state.nextAskAt
        state.nextAskAt = now + interval
        // 她被动「等申报」的状态也一起清掉，避免启动就触发 10 分钟催问
        state.awaitingMove = false
        state.awaitingSince = 0
        state.naggedAt = 0
        save()
        return { shifted: true, from: old, to: state.nextAskAt }
      }
      return { shifted: false, to: state.nextAskAt }
    }

    /** 还没选地点就默认待在家里（地图里的「家」那张固定卡）。 */
    function settleHome() {
      // 老存档没有 styleSamples：从今天的路线里补几条长的，跨天也不会丢
      if (!Array.isArray(state.styleSamples) || !state.styleSamples.length) {
        const seeds = (state.decisions || [])
          .map((d) => String(d.reason || '').trim())
          .filter((r) => r.length >= 12)
        if (seeds.length) {
          state.styleSamples = [...new Set(seeds)].slice(-3).reverse()
          save()
        }
      }
      if (state.place) return state
      const home = (state.maps?.list || [])
        .flatMap((m) => m.regions || [])
        .flatMap((r) => r.places || [])
        .find((p) => p.name === '家')
      const info = home?.info || DEFAULT_HOME_INFO
      state.place = { name: '家', info }
      state.since = Date.now()
      state.reason = ''
      save()
      return state
    }
    function save() {
      try {
        const path = fileFor(statePid || pidOf())
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, JSON.stringify(state, null, 1), 'utf8')
      } catch (error) { log.warn('小世界：状态没存上：' + (error?.message || error)) }
    }

    // ---------- 地图配置 ----------
    // ---------- 地图 → 地区 → 地点 ----------
    function defaultRegion() {
      return normalizeRegion({ id: 'home-area', name: DEFAULT_REGION_NAME, places: BUILTIN_PLACES })
    }
    function defaultMap() {
      return normalizeMap({ id: 'default', name: '默认地图', regions: [defaultRegion()] })
    }

    /** 兼容三种历史存档：老「多套地图（扁平地点）」/ 上一版「多套地区」/ 新「地图含地区」 */
    function ensureMaps() {
      let changed = false
      let list = []
      if (state.maps && Array.isArray(state.maps.list) && state.maps.list.length) {
        list = state.maps.list
      } else if (state.regions && Array.isArray(state.regions) && state.regions.length) {
        // 上一版：state.regions 是扁平地区列表 → 包成一张地图
        list = [{ id: 'default', name: '默认地图', regions: state.regions }]
        delete state.regions
        log.info('小世界：把扁平地区包成「默认地图」')
        changed = true
      } else {
        list = [defaultMap()]
        changed = true
      }

      const nextList = list.map((m) => {
        // 老结构：地图里直接放 places（没有 regions）
        if (!Array.isArray(m.regions) || !m.regions.length) {
          const asRegion = normalizeRegion({ name: m.name === '默认地图' ? DEFAULT_REGION_NAME : m.name, places: m.places })
          return normalizeMap({ id: m.id, name: m.name, regions: [asRegion] })
        }
        return normalizeMap(m)
      })
      if (JSON.stringify(nextList) !== JSON.stringify(state.maps && state.maps.list)) changed = true
      state.maps = { activeId: (state.maps && state.maps.activeId) || nextList[0].id, list: nextList }
      if (!state.maps.list.some((m) => m.id === state.maps.activeId)) {
        state.maps.activeId = state.maps.list[0].id
        changed = true
      }

      const map = state.maps.list.find((m) => m.id === state.maps.activeId)
      if (!map.regions.some((r) => r.id === state.activeRegionId)) {
        state.activeRegionId = map.homeRegionId || map.regions[0].id
        changed = true
      }
      const region = map.regions.find((r) => r.id === state.activeRegionId) || map.regions[0]

      // 她所在地点所属的地区必须还存在；否则回「家」所在地区
      // （「移动中 / 长途移动中」是虚拟地点，允许它不在 places 列表里）
      if (state.place && state.place.regionId && !map.regions.some((r) => r.id === state.place.regionId)) {
        const homeRegion = map.regions.find((r) => r.id === map.homeRegionId) || map.regions[0]
        const fallback = (homeRegion.places || []).find((p) => p.name === '家') || (homeRegion.places || [])[0]
        if (fallback) {
          state.place = { name: fallback.name, info: fallback.info, regionId: homeRegion.id }
          state.reason = ''
          state.since = Date.now()
          changed = true
        }
      }
      if (changed) save()
      return state.maps
    }

    const maps = () => ensureMaps()
    const activeMap = () => {
      const all = maps()
      return all.list.find((m) => m.id === all.activeId) || all.list[0]
    }
    const regionList = () => activeMap().regions || []
    const activeRegion = () => regionList().find((r) => r.id === state.activeRegionId) || regionList()[0]
    /** 她真正所在的地区（按 place.regionId 找；找不到就用当前查看的地区兜底）。 */
    const placeRegion = () => {
      const rid = state.place && state.place.regionId
      if (rid) {
        const found = regionList().find((r) => r.id === rid)
        if (found) return found
      }
      const byName = regionList().find((r) => (r.places || []).some((p) => p.name === (state.place && state.place.name)))
      return byName || activeRegion()
    }
    const placeList = () => activeRegion().places || []
    const findRegion = (key) => {
      const q = String(key || '').trim()
      if (!q) return null
      return regionList().find((r) => r.id === q || r.name === q)
        || regionList().find((r) => r.name.includes(q) || q.includes(r.name))
        || null
    }
    const findPlace = (name, region = activeRegion()) => {
      const q = String(name || '').trim()
      if (!q) return null
      const list = region?.places || []
      return list.find((p) => p.name === q)
        || list.find((p) => p.name.includes(q) || q.includes(p.name))
        || null
    }

    // ---- 地图预设 ----
    function newMapPreset(name) {
      const m = normalizeMap({
        id: uid(),
        name: String(name || '').trim().slice(0, 20) || `地图 ${maps().list.length + 1}`,
        regions: [defaultRegion()],
      })
      state.maps.list.push(m)
      state.maps.activeId = m.id
      state.activeRegionId = m.homeRegionId
      save()
      return m
    }
    function selectMapPreset(id) {
      if (!state.maps.list.some((m) => m.id === id)) return { ok: false, message: '没有这张地图' }
      state.maps.activeId = id
      const map = activeMap()
      state.activeRegionId = map.homeRegionId || map.regions[0].id
      const region = activeRegion()
      const station = (region.places || []).find((p) => p.station) || (region.places || [])[0]
      if (station) {
        state.place = { name: station.name, info: station.info, regionId: region.id }
        state.reason = ''
        state.since = Date.now()
      }
      state.nextAskAt = 0
      save()
      return { ok: true, message: `切换到地图「${map.name}」（${map.regions.length} 个地区）`, map }
    }
    function deleteMapPreset(id) {
      if (state.maps.list.length <= 1) return { ok: false, message: '至少要留一张地图' }
      const idx = state.maps.list.findIndex((m) => m.id === id)
      if (idx < 0) return { ok: false, message: '没有这张地图' }
      const [gone] = state.maps.list.splice(idx, 1)
      if (state.maps.activeId === id) state.maps.activeId = state.maps.list[0].id
      state.activeRegionId = activeMap().homeRegionId
      save()
      return { ok: true, message: `删掉了地图「${gone.name}」` }
    }

    // ---- 地区 ----
    function newRegion(name) {
      const map = activeMap()
      const r = normalizeRegion({ id: uid(), name: String(name || '').trim().slice(0, 20) || `地区 ${map.regions.length + 1}`, places: [] })
      map.regions.push(r)
      state.activeRegionId = r.id
      const station = r.places.find((p) => p.station)
      state.place = { name: station.name, info: station.info, regionId: r.id }
      state.reason = ''
      state.since = Date.now()
      state.nextAskAt = 0
      save()
      return r
    }
    function saveRegion({ id, name, places, bg } = {}) {
      const map = activeMap()
      let r = map.regions.find((x) => x.id === id)
      if (!r) r = newRegion(name)
      if (name !== undefined) r.name = String(name).trim().slice(0, 20) || r.name
      if (places !== undefined) r.places = normalizePlaces(places)
      if (bg !== undefined) r.bg = normalizeBg(bg)
      // 保存后重新跑一次地图级规整（保证「家」只有一处、车站必有）
      // 注意：保存某个地区不应该改变「她现在在哪个地区」，只修正失效的 activeRegionId
      const merged = normalizeMap(map)
      state.maps.list = state.maps.list.map((m) => (m.id === map.id ? merged : m))
      const targetMap = state.maps.list.find((m) => m.id === map.id)
      if (!targetMap.regions.some((x) => x.id === state.activeRegionId)) {
        state.activeRegionId = targetMap.homeRegionId || targetMap.regions[0].id
      }
      save()
      return targetMap.regions.find((x) => x.id === r.id) || targetMap.regions[0]
    }
    function selectRegion(key) {
      const target = findRegion(key)
      if (!target) return { ok: false, message: '没有这个地区' }
      // 比较的是「她真正所在的地区」，不是正在查看的地区
      const here = placeRegion()
      state.activeRegionId = target.id
      // 地区不同 = 一次移动：默认到这个地区的车站（移动用时以后会加在这里）
      const station = (target.places || []).find((p) => p.station) || (target.places || [])[0]
      if (station && (!here || here.id !== target.id)) {
        state.place = { name: station.name, info: station.info, regionId: target.id }
        state.reason = ''
        state.since = Date.now()
        state.pendingTravel = null   // 预留：以后在这里记「路上要多久、几点到」
      }
      state.nextAskAt = 0
      save()
      return { ok: true, message: `到地区「${target.name}」了（先落在${station ? station.name : '第一个地点'}）`, region: target }
    }
    /** 地图页用：只切换「正在查看/编辑的地区」，不改变她现在的位置。 */
    function selectRegionForEdit(id) {
      const target = regionList().find((r) => r.id === id) || findRegion(id)
      if (!target) return { ok: false, message: '没有这个地区' }
      state.activeRegionId = target.id
      save()
      return { ok: true, message: `正在查看地区「${target.name}」`, region: target }
    }

    function deleteRegion(id) {
      const map = activeMap()
      if (map.regions.length <= 1) return { ok: false, message: '至少要留一个地区' }
      const idx = map.regions.findIndex((r) => r.id === id)
      if (idx < 0) return { ok: false, message: '没有这个地区' }
      const [gone] = map.regions.splice(idx, 1)
      if (state.activeRegionId === id) state.activeRegionId = map.homeRegionId || map.regions[0].id
      save()
      return { ok: true, message: `删掉了地区「${gone.name}」` }
    }

    // ---------- 时间表 ----------
    const startMin = () => parseHm(cfg().startTime, 10 * 60)
    const endMin = () => parseHm(cfg().endTime, 22 * 60)
    const intervalMs = () => Math.max(30 * 60_000, (Number(cfg().intervalHours) || 2) * 3_600_000)
    const lateEndMin = () => endMin() + 60

    function phaseOf(now = Date.now()) {
      const m = minutesOf(now)
      const start = startMin(); const end = endMin()
      if (m < start) return 'before'
      if (m < end) return 'window'
      if (m < lateEndMin() && state.lateReturn) return 'late'
      if (m < lateEndMin()) return 'lateAsk'
      return 'closed'
    }

    function rollDay(now = Date.now()) {
      const ymd = ymdOf(now)
      if (state.ymd === ymd) return false
      state.ymd = ymd
      state.decisions = []
      state.lateReturn = false
      state.overnight = false
      state.endAsked = false
      state.overnightAsked = false
      state.overnightDecided = false
      state.nextAskAt = 0
      // 等她就位的状态也别跨天（否则第二天一上班就催她）
      state.awaitingMove = false
      state.awaitingSince = 0
      state.naggedAt = 0
      state.deliveredLate = false
      state.deliveredOvernight = false
      state.homeNaggedAt = 0
      save()
      log.info(`小世界：跨天重置（${ymd}），晚回 / 夜不归宿 已归零`)
      return true
    }

    // ---------- 主动消息 ----------
    async function pushPrompt(prompt) {
      const conf = api.config()
      const qq = String(conf.ownerQQ || '')
      if (!qq || !conf?.enabled || conf?.dryRun) return false
      const chatId = `private:${qq}`
      if (api.core?.mutes?.muted?.(chatId)) return false
      try {
        if (api.core?.hub?.pushToSession) {
          await api.core.hub.pushToSession(
            { chatId, kind: 'private', userId: qq, nickname: conf.ownerName || '主人' },
            [{ type: 'text', text: prompt }],
            '',
          )
          return true
        }
        const reply = await api.think(prompt, { title: 'real-world', timeoutMs: 90_000 })
        if (reply && !/^\s*\[沉默\]\s*$/.test(reply)) { await api.send(chatId, reply); return true }
      } catch (error) {
        log.debug?.('小世界：提醒没发出去：' + (error?.message || error))
      }
      return false
    }

    // ---------- 记录行程 ----------
    // ---------- 移动耗时 ----------
    const travelActive = () => Boolean(state.travel && state.travel.steps && state.travel.index < state.travel.steps.length)
    const travelStep = () => (travelActive() ? state.travel.steps[state.travel.index] : null)

    /** 走完到期的步骤；返回是否有变化。 */
    function progressTravel(now = Date.now()) {
      if (!state.travel || !Array.isArray(state.travel.steps)) return false
      let changed = false
      while (state.travel && state.travel.index < state.travel.steps.length) {
        const step = state.travel.steps[state.travel.index]
        if (now < step.endsAt) break
        // 这一步到点了：把位置挪到这一步的目标
        if (step.kind === 'ride') {
          const region = regionList().find((r) => r.id === step.regionId)
          const station = region && (region.places || []).find((pp) => pp.station)
          if (region && station) {
            state.place = { name: station.name, info: station.info, regionId: region.id }
            state.activeRegionId = region.id
            state.since = step.endsAt
          }
        } else {
          const region = regionList().find((r) => r.id === step.regionId)
          const target = region && (region.places || []).find((pp) => pp.name === step.toName)
          if (region && target) {
            state.place = { name: target.name, info: target.info, regionId: region.id }
            state.activeRegionId = region.id
            state.since = step.endsAt
          }
        }
        state.travel.index += 1
        // 进入下一段（如果还没到终点），位置显示成「移动中 / 长途移动中」
        if (state.travel.index < state.travel.steps.length) {
          const next = state.travel.steps[state.travel.index]
          const regionId = next.regionId || state.travel.target.regionId
          const originRegionName = (state.travel.origin && state.travel.origin.regionName) || ''
          state.place = {
            name: next.kind === 'ride' ? TRAVEL_RIDE_NAME : TRAVEL_WALK_NAME,
            info: next.kind === 'ride'
              ? `正坐${next.rideMode || '电车'}从${originRegionName || '出发地区'}前往${next.toRegionName || '目的地'}`
              : `正从「${next.fromName}」走往「${next.toName}」`,
            regionId,
            virtual: true,
          }
        }
        changed = true
        if (state.travel.index >= state.travel.steps.length) {
          // 全部走完：落定最终地点，记入今天的路线
          const finalRegion = regionList().find((r) => r.id === state.travel.target.regionId)
          const finalPlace = finalRegion && (finalRegion.places || []).find((pp) => pp.name === state.travel.target.placeName)
          if (finalRegion && finalPlace) {
            state.place = { name: finalPlace.name, info: finalPlace.info, regionId: finalRegion.id }
            state.activeRegionId = finalRegion.id
            state.since = step.endsAt
            state.reason = state.travel.reason || ''
            state.decisions = [...(state.decisions || []).slice(-23), {
              at: step.endsAt,
              name: finalPlace.name,
              region: finalRegion.name,
              info: finalPlace.info,
              reason: state.reason,
            }]
            if (state.reason.length >= 8) {
              state.styleSamples = [state.reason, ...(state.styleSamples || []).filter((r) => r !== state.reason)].slice(0, 3)
            }
          }
          const arrived = finalPlace ? { name: finalPlace.name, region: finalRegion && finalRegion.name } : null
          state.travel = null
          state.nextAskAt = now + intervalMs()
          if (arrived) {
            maybeReport({ ok: true, changed: true, place: arrived.name, reason: state.reason }).catch(() => {})
          }
        }
      }
      if (changed) save()
      return changed
    }

    /** 路上时的位置提示：统一成「你要前往A，现在从B……」。 */
    function travelHintText(now = Date.now()) {
      const step = travelStep()
      if (!step) return ''
      const left = Math.max(1, Math.round((step.endsAt - now) / 60_000))
      const c = cfg()
      const rideLabel = String(c.rideMode || '').trim().slice(0, 20) || '电车'
      const travel = state.travel || {}
      const target = travel.target || {}
      const origin = travel.origin || {}
      const dest = target.placeName || '目的地'
      const originName = origin.name || step.fromName || '这里'

      if (step.kind === 'ride') {
        const regionName = step.toRegionName
          || (regionList().find((r) => r.id === step.regionId) || {}).name
          || '目的地'
        const originRegionName = origin.regionName
          || (regionList().find((r) => r.id === origin.regionId) || {}).name
          || step.fromName
          || '出发地'
        const ride = step.rideMode || rideLabel
        return `你要前往${dest}，现在正坐${ride}从${originRegionName}前往${regionName}，还要约 ${left} 分钟。`
      }
      if (step.crossToRegion) {
        const ride = step.rideMode || rideLabel
        return `你要前往${dest}，现在从${originName}走路前往${step.toName}坐${ride}前往${step.toRegionName || '目的地'}，还要约 ${left} 分钟。`
      }
      return `你要前往${dest}，现在从${step.fromName}走路前往${step.toName}，还要约 ${left} 分钟。`
    }

    /**
     * 移动：先看地区，再看地点。
     * - 指定了别的地区 → 默认落在这个地区的「车站」（移动用时以后加在这里）
     * - 地区没变 → 在该地区里找地点
     */
    /** 申报完成：结束「等她申报」的状态，并把下次提醒推后一个间隔。 */
    function markDeclared(now = Date.now()) {
      state.awaitingMove = false
      state.awaitingSince = 0
      state.naggedAt = 0
      state.nextAskAt = now + intervalMs()
    }

    function moveTo(name, reason = '', now = Date.now(), opts = {}) {
      // 还在路上的话，先把它走完（避免叠加两段行程）
      if (travelActive()) progressTravel(now)

      const regionKey = String(opts.region || '').trim()
      const here = placeRegion()
      let targetRegion = here
      if (regionKey) {
        const r = findRegion(regionKey)
        if (r) targetRegion = r
      }
      let targetPlace = findPlace(name, targetRegion)
      if (!targetPlace && !regionKey) {
        // 没写地区：在全部地区里找（先精确、再包含），唯一命中就直接跨地区
        const fuzzy = (region) => {
          const list = region.places || []
          const exact = list.find((pp) => pp.name === name)
          if (exact) return exact
          const inc = list.filter((pp) => pp.name.includes(name))
          return inc.length === 1 ? inc[0] : null
        }
        const hits = regionList()
          .map((r) => ({ region: r, place: fuzzy(r) }))
          .filter((x) => x.place)
        if (hits.length === 1) {
          targetRegion = hits[0].region
          targetPlace = hits[0].place
        } else if (hits.length > 1) {
          return {
            ok: false,
            message: `「${name}」在几个地区都有：${hits.map((x) => `${x.region.name}·${x.place.name}`).join('、')}，填的时候带上地区名`,
          }
        }
      }
      if (!targetPlace) {
        const names = (targetRegion.places || []).map((pp) => pp.name).join('、')
        return { ok: false, message: `地区「${targetRegion.name}」里没有「${name}」。这里能去：${names}` }
      }

      const curRegion = placeRegion()
      const curPlace = (curRegion.places || []).find((pp) => pp.name === (state.place && state.place.name)) || null
      const crossRegion = targetRegion.id !== curRegion.id
      const samePlace = !crossRegion && Boolean(curPlace)
        && String(curPlace.name).trim() === String(targetPlace.name).trim()

      // 原地不动：直接记下来，不排行程
      if (samePlace) {
        const prev = state.place
        state.place = { name: targetPlace.name, info: targetPlace.info, regionId: targetRegion.id }
        state.since = now
        state.reason = String(reason || '').slice(0, 200)
        state.decisions = [...(state.decisions || []).slice(-23), {
          at: now, name: targetPlace.name, region: targetRegion.name, info: targetPlace.info, reason: state.reason,
        }]
        // 原地不动也是一次完整的申报：结束待催，下次提醒推后一个间隔
        markDeclared(now)
        save()
        return { ok: true, changed: Boolean(prev), place: targetPlace.name, region: targetRegion.name, message: `记下了：就在「${targetPlace.name}」${state.reason ? `，因为${state.reason}` : ''}。` }
      }

      const c = cfg()
      const steps = []
      let cursorEnd = now
      if (crossRegion) {
        // ① 先走到本地区的车站
        const fromStation = (curRegion.places || []).find((pp) => pp.station)
        const firstWalk = walkMinutesBetween(curPlace, fromStation)
        cursorEnd += firstWalk * 60_000
        steps.push({
          kind: 'walk',
          fromName: curPlace ? curPlace.name : '这里',
          toName: fromStation ? fromStation.name : '车站',
          regionId: curRegion.id,
          minutes: firstWalk,
          endsAt: cursorEnd,
          crossToRegion: true,
          toRegionName: targetRegion.name,
          rideMode: String(c.rideMode || '').trim() || '电车',
        })
        // ② 长途：从 A 地区车站到 B 地区车站（时长走设置）
        const rideMinutes = Math.max(1, Math.round(Number(c.rideMinutes) || DEFAULT_RIDE_MINUTES))
        cursorEnd += rideMinutes * 60_000
        steps.push({
          kind: 'ride',
          fromName: fromStation ? fromStation.name : '车站',
          toName: '',
          regionId: targetRegion.id,
          minutes: rideMinutes,
          endsAt: cursorEnd,
          rideMode: String(c.rideMode || '').trim().slice(0, 20) || '电车',
          toRegionName: targetRegion.name,
        })
        // ③ 从 B 地区车站走到目标地点
        const toStation = (targetRegion.places || []).find((pp) => pp.station)
        const lastWalk = walkMinutesBetween(toStation, targetPlace)
        cursorEnd += lastWalk * 60_000
        steps.push({
          kind: 'walk',
          fromName: toStation ? toStation.name : '车站',
          toName: targetPlace.name,
          regionId: targetRegion.id,
          minutes: lastWalk,
          endsAt: cursorEnd,
        })
      } else {
        const minutes = walkMinutesBetween(curPlace, targetPlace)
        cursorEnd += minutes * 60_000
        steps.push({
          kind: 'walk',
          fromName: curPlace ? curPlace.name : '这里',
          toName: targetPlace.name,
          regionId: targetRegion.id,
          minutes,
          endsAt: cursorEnd,
        })
      }

      state.travel = {
        steps,
        index: 0,
        reason: String(reason || '').slice(0, 200),
        startedAt: now,
        etaAt: cursorEnd,
        // 出发点：提示词里会带上，方便她理解自己的大致位置
        origin: {
          name: curPlace ? curPlace.name : (state.place && state.place.name) || '',
          regionId: curRegion.id,
          regionName: curRegion.name,
        },
        target: { regionId: targetRegion.id, placeName: targetPlace.name },
      }
      // 位置进入「移动中」状态（虚拟地点，地图上不会有这张卡）
      state.place = {
        name: steps[0].kind === 'ride' ? TRAVEL_RIDE_NAME : TRAVEL_WALK_NAME,
        info: steps[0].kind === 'ride'
          ? `正坐${String(c.rideMode || '').trim() || '电车'}从${curRegion.name}前往${targetRegion.name}`
          : `正从「${steps[0].fromName}」走往「${steps[0].toName}」`,
        regionId: curRegion.id,
        virtual: true,
      }
      state.reason = String(reason || '').slice(0, 200)
      // 出发也算申报完成（行程还在跑，但不需要再催她申报）
      markDeclared(now)
      save()

      const totalMin = Math.round((cursorEnd - now) / 60_000)
      const first = steps[0]
      const head = crossRegion
        ? `记下了：要去地区「${targetRegion.name}」的「${targetPlace.name}」——先走 ${steps[0].minutes} 分钟到${steps[0].toName}，再坐 ${steps[1].minutes} 分钟${String(c.rideMode || '').trim() || '电车'}，最后走 ${steps[2].minutes} 分钟，约 ${totalMin} 分钟后到。`
        : `记下了：从「${first.fromName}」走路去「${targetPlace.name}」，约 ${first.minutes} 分钟（${totalMin} 分钟后到）。`
      return {
        ok: true,
        changed: true,
        traveling: true,
        place: state.place && state.place.name,
        region: targetRegion.name,
        etaMinutes: totalMin,
        reason: state.reason,
        message: `${head}${state.reason ? `理由：${state.reason}。` : ''}路上会按阶段提示位置。`,
      }
    }

    /** 换了地方 + 开着「汇报行程」→ 让她主动跟主人说一声。 */
    async function maybeReport(res) {
      if (!cfg().reportOnMove) return false
      if (!res?.ok || !res.changed) return false
      // 出发那一刻不汇报：位置还没变，等走完最后一段再报（progressTravel 里会调）
      if (res.traveling) return false
      // 非外出时段不发消息（本时段只在「决定晚归 / 夜不归宿」那一次会开口）
      const phase = phaseOf()
      if (phase !== 'window' && phase !== 'late') return false

      const now = Date.now()
      // ① 刚有一轮对话（哪怕 1 分钟前）：不要再单独插一条汇报，她下句话自然会说
      if (now - (Number(state.lastTurnAt) || 0) < 60_000) return false
      // ② 主人刚说过话：按聊天保护，先不打断
      const protectMs = Math.max(1, Number(cfg().chatProtectMinutes) || 10) * 60_000
      if (state.lastOwnerAt && now - state.lastOwnerAt < protectMs) return false
      // ③ 汇报冷却（可调）：短时间内多次移动只汇报一次
      const c = cfg()
      const coolMs = Math.max(0, Number(c.reportMinGapMinutes ?? 10)) * 60_000
      if (coolMs && state.lastReportAt && now - state.lastReportAt < coolMs) return false
      // ④ 概率：不是每次换地方都汇报
      const chance = Math.max(0, Math.min(100, Number(c.reportChance ?? 100)))
      if (Math.random() * 100 > chance) {
        log.debug?.(`小世界：这次按概率不汇报（${chance}%）`)
        return false
      }
      state.lastReportAt = now
      save()
      const conf = api.config()
      const owner = conf.ownerName || '主人'
      const prompt =
        `【系统提醒，不是${owner}说的话】你刚换了地方，现在到了「${res.place}」${res.reason ? `（因为${res.reason}）` : ''}。`
        + `跟${owner}主动说一声你在哪儿、在做什么，一两句就好，用你自己的语气；不想说就只回 [沉默]。`
      return pushPrompt(prompt)
    }

    /** 毫秒 → 「1 小时 20 分钟」。 */
    const fmtSpan = (ms) => {
      const total = Math.max(0, Math.round(Number(ms) / 60_000))
      const h = Math.floor(total / 60)
      const m = total % 60
      if (h && m) return `${h} 小时 ${m} 分钟`
      if (h) return `${h} 小时`
      return `${m} 分钟`
    }

    /** 今日行程：按时间列出今天去过的地方和当时写的理由。 */
    function todayText() {
      const today = ymdOf(Date.now())
      const rows = (state.decisions || []).filter((d) => ymdOf(d.at) === today)
      const lines = []
      const now = state.place
        ? `${state.place.name}${state.reason ? `（${state.reason}）` : ''}`
        : '（还没定）'
      lines.push(`【今日行程】地图「${activeMap().name}」· 地区「${placeRegion().name}」｜共 ${rows.length} 条记录`)
      lines.push(`现在：${now}${state.place ? `（${clockOf(state.since)} 到的）` : ''}`)
      if (!rows.length) {
        lines.push('今天还没出门记录。')
        return lines.join('\n')
      }
      lines.push('')
      lines.push('—— 今天去过 ——')
      for (const d of rows) {
        const reason = String(d.reason || '').trim()
        lines.push(`${clockOf(d.at)} ${d.name}${reason ? `｜${reason}` : ''}`)
      }
      const places = [...new Set(rows.map((d) => d.name))]
      lines.push('')
      lines.push(`去过 ${places.length} 个地方：${places.join('、')}`)
      return lines.join('\n')
    }

    function statusText() {
      const now = Date.now()
      const c = cfg()
      const here = state.place
        ? `${state.place.name}${state.reason ? `（${state.reason}）` : ''}`
        : '（还没定）'
      if (travelActive()) {
        const step = travelStep()
        const left = Math.max(1, Math.round((step.endsAt - Date.now()) / 60_000))
        const targetRegion = regionList().find((r) => r.id === state.travel.target.regionId)
        return [
          `【小世界】正在路上｜${step.kind === 'ride' ? `前往${targetRegion ? targetRegion.name : '目的地'}的${String(cfg().rideMode || '').trim() || '电车'}上` : `走路（${step.fromName} → ${step.toName}）`}`,
          `还要约 ${left} 分钟；目的地：${targetRegion ? `${targetRegion.name} · ` : ''}${state.travel.target.placeName}`,
          (() => {
            const dest = (targetRegion ? targetRegion.places : placeRegion().places) || []
            const names = dest.map((p) => `${p.name}${(p.tags || []).length ? `［${p.tags.join('/')}］` : ''}`).join('、')
            return names ? `那边能去：${names}` : ''
          })(),
        ].filter(Boolean).join('\n')
      }
      const hereRegion = placeRegion()
      const lines = [`【小世界】地图「${activeMap().name}」· 地区「${hereRegion.name}」｜现在：${here}`]
      // 工具说明里承诺了「当前地区有哪些地点」，这里真的列出来——不然她只能猜地名
      const placeNames = byPref(hereRegion.places || []).map(prefLabel).join('、')
      if (placeNames) lines.push(`这里能去：${placeNames}`)
      const others = regionList().filter((r) => r.id !== hereRegion.id)
      if (others.length) {
        lines.push('别的地方（填地点全名就行，会自动走→坐车→走，不用先切地区）：')
        for (const r of others) {
          const names = byPref(r.places || []).map(prefLabel).join('、')
          lines.push(`  ${r.name}：${names}`)
        }
      }
      const phase = phaseOf(now)
      if (phase === 'before') {
        lines.push(`还没到外出时段（${c.startTime}–${c.endTime}），到点之后再安排移动`)
      } else if (phase === 'closed' || phase === 'lateAsk') {
        lines.push(`今天的外出时段已结束（${c.startTime}–${c.endTime}）`)
      } else if (state.nextAskAt > now) {
        lines.push(`下次移动：约 ${fmtSpan(state.nextAskAt - now)} 后（${clockOf(state.nextAskAt)}）`)
      } else {
        lines.push('下次移动：下一次检查就会提醒她定地点')
      }
      if (state.overnight) lines.push('今晚不回家')
      else if (state.lateReturn) lines.push(`今天晚回，最晚 ${fmtHm(lateEndMin())}`)
      return lines.join('\n')
    }

    /** 家 / 车站是固定地点：不参与「喜好权重」（那只是出门玩的参考）。 */
    const isFixedPlace = (p) => p?.name === '家' || p?.station === true
    /** 地点的喜好权重（缺省 100）。 */
    const prefOf = (p) => (Number.isFinite(Number(p?.pref)) ? Math.round(Number(p.pref)) : 100)
    /** 家的、车站的排在最前面（不计权重），其余按喜好从高到低；同权重保持原顺序。 */
    const byPref = (places) => (places || [])
      .map((p, i) => ({ p, i }))
      .sort((a, b) => {
        const af = isFixedPlace(a.p)
        const bf = isFixedPlace(b.p)
        if (af !== bf) return af ? -1 : 1
        if (af && bf) return a.i - b.i
        return (prefOf(b.p) - prefOf(a.p)) || (a.i - b.i)
      })
      .map((x) => x.p)
    /** 家/车站只写名字，别的地点后面带权重。 */
    const prefLabel = (p) => {
      const tags = (p.tags || []).length ? `［${p.tags.join('/')}］` : ''
      return isFixedPlace(p) ? `${p.name}${tags}` : `${p.name}${tags}(${prefOf(p)})`
    }

    /**
     * QQ 命令 /小世界 用的状态：只给位置、目的、下次移动时间。
     * 带地点清单的是 statusText()，那是给她调用 real_world_status 时做决策用的，别混在一起。
     */
    function commandStatusText() {
      const now = Date.now()
      const c = cfg()
      const phase = phaseOf(now)
      const here = state.place ? state.place.name : '（还没定）'
      const brief = (v, n = 60) => {
        const t = String(v || '').replace(/\s+/g, ' ').trim()
        return t.length > n ? `${t.slice(0, n)}…` : t
      }
      const lines = [`【小世界】地图「${activeMap().name}」· 地区「${placeRegion().name}」`]
      if (travelActive()) {
        const step = travelStep()
        const left = Math.max(1, Math.round((step.endsAt - now) / 60_000))
        const targetRegion = regionList().find((r) => r.id === state.travel.target.regionId)
        const where = step.kind === 'ride'
          ? `正坐${String(cfg().rideMode || '').trim() || '电车'}去${targetRegion ? targetRegion.name : '目的地'}`
          : `走到${step.toName || '下一段'}`
        lines.push(`现在：${where}（还要约 ${left} 分钟）`)
        lines.push(`目的地：${targetRegion ? `${targetRegion.name} · ` : ''}${state.travel.target.placeName}`)
        if (state.travel.reason) lines.push(`目的：${brief(state.travel.reason)}`)
        return lines.join('\n')
      }
      lines.push(`现在：${here}`)
      if (state.reason) lines.push(`目的：${brief(state.reason)}`)
      if (state.overnight) lines.push('今晚不回家')
      else if (state.lateReturn) lines.push(`今天晚回，最晚 ${fmtHm(lateEndMin())}`)
      if (phase === 'before') lines.push(`还没到外出时段（${c.startTime}–${c.endTime}）`)
      else if (phase === 'closed' || phase === 'lateAsk') {
        const atHome = String((state.place && state.place.name) || '') === '家'
        lines.push(`今天的外出时段已结束（${c.startTime}–${c.endTime}）${atHome ? '' : '，人还在外面'}`)
      } else if (state.nextAskAt > now) {
        lines.push(`下一次移动：约 ${fmtSpan(state.nextAskAt - now)} 后（${clockOf(state.nextAskAt)}）`)
      } else {
        lines.push('下一次移动：下一次检查就会提醒她定地点')
      }
      return lines.join('\n')
    }

    function movePrompt() {
      const c = cfg()
      const list = byPref(placeRegion().places || [])
      // 用她最近写过的理由当样例，风格会随着她自己越写越稳
      const recentReasons = (state.styleSamples && state.styleSamples.length
        ? state.styleSamples
        : (state.decisions || []).slice(-3).map((d) => String(d.reason || '').trim()))
        .filter((r) => r && r.length >= 8)
      const styleHint = recentReasons.length
        ? `你之前是这样写的，照这个感觉来：${recentReasons.map((r) => `「${r}」`).join('；')}`
        : ''
      const otherRegions = regionList().filter((r) => r.id !== placeRegion().id).map((r) => r.name)
      const work = list.filter((p) => (p.tags || []).includes('打工'))
      const names = list.map(prefLabel).join('、')
      const workLine = work.length
        ? `可以打工挣钱的地方：${work.map((p) => `${p.name}${(p.tags || []).includes('情色') ? '（偏暧昧/特殊服务）' : ''}`).join('、')}。`
        : ''
      return [
        `【系统提醒，不是主人说的话】现在 ${clockOf(Date.now())}，到了换地方的时候（每 ${c.intervalHours} 小时一段，外出时段 ${c.startTime}–${c.endTime}）。`,
        `你现在在地区「${placeRegion().name}」，这里的可去地点（括号里是喜好权重，越高越想去；家和车站是固定的，没有权重）：${names}。`,
        ...(regionList().filter((r) => r.id !== placeRegion().id).map((r) => {
          const list = byPref(r.places || []).map(prefLabel).join('、')
          return `别的地区「${r.name}」的可去地点（括号=喜好权重）：${list}`
        })),
        '别的地区也可以去：real_world_move 的 place 直接填那边的地点全名（region 可以不填，会自动走→坐车→走）。',
        ...(workLine ? [workLine] : []),
        '这一时段必须定下来，不能空着：调用 real_world_move 记下你要去哪儿、为什么去。',
        '定下来之后顺口跟主人说一句就行（去哪儿、在做什么），不用长篇；真的没什么想说的时候，一句话也够了。',
        '不用每个时段都换地方——也可以选择和现在相同的地点（原地待着），照样调用 real_world_move 填当前地点。',
        '挑地方的时候照喜好权重来：权重高的你更愿意去，权重低的除非有别的缘由（约了人、打工、非去不可）就别硬凑。',
        '理由别只写标签（「想听一场」这种太短了）：写出你此刻比较完整的心理路径——为什么想去、心里怎么权衡取舍、打算怎么面对接下来的事。',
        ...(styleHint ? [styleHint] : []),
      ].join('\n')
    }

    /** 外出时段结束时的一次性提问：晚归 / 夜不归宿 / 回家，三选一（只列被放开的）。 */
    function endOfDayPrompt() {
      const c = cfg()
      const lines = [`【系统提醒，不是主人说的话】已经到 ${fmtHm(endMin())} 了，外出时段结束，今晚怎么安排你自己决定：`]
      if (c.allowLateReturn) lines.push(`- 想再在外面多待一小时（到 ${fmtHm(lateEndMin())}）→ real_world_plan({ lateReturn: true })`)
      if (c.allowOvernight) lines.push('- 今晚不回家 → real_world_plan({ overnight: true })')
      lines.push('- 现在回家 → real_world_plan({ lateReturn: false, overnight: false })')
      return lines.join('\n')
    }

    /** 晚归那一小时结束后，再问一次今晚回不回家。 */
    const overnightPrompt = () => `【系统提醒，不是主人说的话】晚回的一小时到 ${fmtHm(lateEndMin())} 了。今晚回不回家？想回去就调 real_world_plan 把 overnight 记成 false；今晚想在外面就说 true。`

    // ---------- 每分钟检查 ----------
    api.every(60_000, async () => {
      ensureState()
      const c = cfg()
      if (!c.enabled) return
      // 每晚到点总结今天的经历，把认知写回地图（一天只跑一次）
      if (c.reflectEnabled) {
        const nowForReflect = Date.now()
        const ymdNow = ymdOf(nowForReflect)
        const at = parseHm(c.reflectTime, 23 * 60 + 30)
        if (state.reflectYmd !== ymdNow && minutesOf(nowForReflect) >= at) {
          await runReflection().catch((error) => log.warn('小世界：总结出错：' + (error?.message || error)))
          return
        }
      }
      const now = Date.now()
      rollDay(now)
      progressTravel(now)
      const phase = phaseOf(now)

      // 聊天保护：主人刚说过话就先不催（默认 10 分钟）
      const protectMs = Math.max(1, Number(c.chatProtectMinutes) || 10) * 60_000
      const chatting = state.lastOwnerAt > 0 && now - state.lastOwnerAt < protectMs
      const nagAfter = 10 * 60_000

      if (phase === 'window' || phase === 'late') {
        if (travelActive()) return                        // 正在路上，不用再催换地方
        if (!c.allowSelfOuting) return                    // 关了「允许她自己出门」：不催申报
        if (!state.place && !state.nextAskAt) { state.nextAskAt = now; save() }
        // 正在聊就别打断；但如果已经拖过半小时还没申报，提醒一次（否则整晚都不动）
        const overdue = now >= (Number(state.nextAskAt) || 0) + 30 * 60_000
        if (chatting && !overdue) return
        if (now >= (state.nextAskAt || 0)) {
          // 到点就提醒（固定 100%）；节奏只由「移动间隔」决定
          await pushPrompt(movePrompt())
          state.lastAskAt = now
          state.nextAskAt = now + intervalMs()
          state.awaitingMove = true
          state.awaitingSince = now
          state.naggedAt = 0
          save()
        } else if (state.awaitingMove && now - (state.awaitingSince || 0) > nagAfter && now - (state.naggedAt || 0) > nagAfter) {
          // 提醒过一直没申报：再催一次（每次时段最多再催一次）
          await pushPrompt(`【系统提醒，不是主人说的话】这一时段的行程还没定下来。现在调用 real_world_move 定下来：换地方就填新地点，不换就填你现在待的地方和继续待着的理由。`)
          state.naggedAt = now
          save()
        }
        return
      }
      // 时段结束那一刻：晚归 / 夜不归宿 一起给（只问一次）
      if (phase === 'lateAsk') {
        const offer = c.allowLateReturn || c.allowOvernight
        if (!state.endAsked && offer && !chatting) {
          state.endAsked = true
          save()
          await pushPrompt(endOfDayPrompt())
        }
        return
      }

      // 时段彻底结束：只要人还在外面，就该问一次「今晚回不回家」，然后持续催回家
      if (phase === 'closed') {
        if (travelActive()) return                      // 还在路上，等落定再问
        const atHome = String((state.place && state.place.name) || '') === '家'
        if (atHome) return
        if (state.overnight) return                    // 已经说了今晚不回去
        // ① 还没表过态：问一次（允许夜不归宿才给 true 这个选项）
        if (!state.overnightAsked) {
          if (chatting) return
          state.overnightAsked = true
          state.overnightDecided = true
          save()
          await pushPrompt(c.allowOvernight
            ? overnightPrompt()
            : `【系统提醒，不是主人说的话】已经到 ${fmtHm(lateEndMin())} 了，你还在外面。现在回家：调用 real_world_move，place 填「家」，理由写你为什么回去。`)
          return
        }
        // ② 表过态但还没回：每 30 分钟催一次（聊天保护只推迟，不会永久压住）
        const last = Number(state.homeNaggedAt) || 0
        if (chatting) return
        if (Date.now() - last >= 30 * 60_000) {
          state.homeNaggedAt = Date.now()
          save()
          await pushPrompt('【系统提醒，不是主人说的话】已经很晚了，你还在外面。现在回家：调用 real_world_move，place 填「家」，理由写你为什么回去。')
        }
      }
    })

    // 主人一说话就记时间：她在聊天时不要催她换地方
    api.on('message', (msg) => {
      try {
        ensureState()
        if (!cfg().enabled) return false
        rollDay(Date.now())
        if (msg?.kind !== 'private') return false
        if (!api.isOwner(msg.userId)) return false
        state.lastOwnerAt = Date.now()
        save()
      } catch (error) { /* 记不上不影响主流程 */ }
      return false
    })

    // 规则：允许在聊天里因为主人一句话就实时挪位置
    api.rule(() => {
      if (!cfg().enabled) return ''
      return [
        '你有一个真实的活动范围（小世界模块）。聊天里主人叫你回家、让你出门、约你去哪儿，或者你自己因为想吃东西、想吹风、待不下去而想换个地方，就用 real_world_move 立刻改位置，不用等整点提醒。',
        '到了换地方的提醒时，必须用 real_world_move 把这一时段定下来（换地方或原地待着都要填），不要空着不报。',
      ]
    })

    // ---------- 每晚总结：把今天的经历写回地图 ----------
    /** 从模型返回里抠出 [{name, info}]，容忍代码块和前后废话。 */
    function parseReflection(text) {
      const raw = String(text || '')
      const start = raw.indexOf('[')
      const end = raw.lastIndexOf(']')
      if (start < 0 || end <= start) return []
      try {
        const arr = JSON.parse(raw.slice(start, end + 1))
        if (!Array.isArray(arr)) return []
        return arr
          .map((x) => {
            const prefRaw = Number(x?.pref)
            return {
              // 模型有时会把行首的「[地区名]」一起抄进 name，这里剥掉
              name: String(x?.name || '').trim().replace(/^\[[^\]]*\]\s*/, ''),
              info: String(x?.info || '').trim(),
              ...(Number.isFinite(prefRaw) ? { pref: Math.max(0, Math.min(200, Math.round(prefRaw))) } : {}),
            }
          })
          .filter((x) => x.name && x.info)
      } catch (error) {
        return []
      }
    }

    async function runReflection(manual = false) {
      const c = cfg()
      if (!c.enabled) return { ok: false, message: '模块关着' }
      const today = ymdOf(Date.now())
      const visited = (state.decisions || []).filter((d) => ymdOf(d.at) === today)
      if (!visited.length) return { ok: false, message: '今天还没去过哪儿，没得总结' }

      // 同一地点只留最后一次
      const byName = new Map()
      for (const d of visited) byName.set(d.name, d)
      const list = placeList()
      const lines = []
      for (const [name, d] of byName) {
        const p = list.find((x) => x.name === name)
        const prefLine = p && isFixedPlace(p) ? '固定地点，不参与喜好权重' : `现在的喜好权重：${prefOf(p)}`
        lines.push(`- ${d.region ? `[${d.region}] ` : ''}${name}｜现在的地点描述：${p?.info || '（无）'}｜今天来这里的理由：${d.reason || '（没写）'}｜${clockOf(d.at)} 到的｜${prefLine}`)
      }

      const prompt = [
        '【系统任务，不是主人说的话】现在做今天的地点回访总结。下面是今天你去过的地方、当时的理由，以及地图里这些地方现在的描述：',
        ...lines,
        '',
        '请根据今天的实际经历，给每个地点重写一句“这个地方对你而言现在是什么样”的描述（40~70 字，第一人称视角的客观描写也行，写气氛、细节、你在这儿发生了什么感受），可以修正原来不准的地方，也可以补上今天新发现的东西。',
        '同时给每个地点一个新的「喜好权重」：范围 0~200，满分 200 是“再好也要去”。参照今天在那儿发生了什么——被哄着、舒服、有快感、被夸，就往上加（单次最多 +20）；无聊、难受、羞耻过头、被冷落，就往下减（单次最多 -20）；没什么特别的就保持现在这个数。',
        '注意：家、车站这种固定地点没有喜好权重（那不是出门玩的选择），不要给它们写 pref，只更新描述。',
        '每个地点都必须带 pref 字段（整数）——哪怕今天没什么变化，也要把它现在的数写回来，别省略。',
        '描述也请真的按今天的情况重写一遍，不要原样抄回上一条。',
        '只输出 JSON 数组，不要别的话，格式：[{"name":"地点名","info":"新描述","pref":105}]。',
        'name 只写地点名本身（例如「街角咖啡馆」「旧书店」；需要时带地区名也行），不要带 [地区] 前缀，也不要加别的说明。',
      ].join('\n')

      let reply = ''
      try {
        reply = await api.think(prompt, { title: 'real-world 地点回访', timeoutMs: 120_000 })
      } catch (error) {
        log.warn('小世界：总结没跑成功：' + (error?.message || error))
        return { ok: false, message: '模型调用失败：' + (error?.message || error) }
      }

      log.info('小世界：总结模型返回（前 240 字）：' + String(reply || '').replace(/\s+/g, ' ').slice(0, 240))
      const items = parseReflection(reply)
      if (!items.length) {
        state.reflectYmd = today
        state.reflectNote = '模型没给出可解析的 JSON，今天跳过'
        save()
        return { ok: false, message: '模型没给出可解析的结果，先跳过今天' }
      }

      const changed = []
      for (const it of items) {
        const d = byName.get(it.name)
        const region = (d && d.region ? findRegion(d.region) : null) || activeRegion()
        const target = (region.places || []).find((p) => p.name === it.name)
        if (!target) continue
        const info = it.info.slice(0, 120)
        const fixed = isFixedPlace(target)
        const before = prefOf(target)
        // 模型没给 pref 时别就这么算了：今天去过这里本身就是一点好感，
        // 理由里带着舒服/被宠的再加一点，带着难受/讨厌的往下扣。
        const fallbackPref = () => {
          const reason = String(d?.reason || '')
          let delta = 2
          if (/(舒服|开心|喜欢|好棒|被夸|温柔|宠|暖|满足|兴奋|上瘾|放松)/.test(reason)) delta += 4
          if (/(难受|讨厌|恶心|羞耻|害怕|冷|痛|烦|无聊|不想|后悔)/.test(reason)) delta -= 6
          return Math.max(0, Math.min(200, before + delta))
        }
        const after = fixed ? before : (Number.isFinite(it.pref) ? it.pref : fallbackPref())
        if (!fixed && !Number.isFinite(it.pref)) log.info(`小世界：${target.name} 模型没给喜好权重，按今天的情况算成 ${after}`)
        const prefChanged = !fixed && after !== before
        if (prefChanged) target.pref = after
        const infoChanged = info && info !== target.info
        if (!infoChanged && !prefChanged) continue
        if (infoChanged) {
          if (!target.infoBase) target.infoBase = target.info
          target.info = info
        }
        target.updatedAt = Date.now()
        changed.push(prefChanged ? `${target.name}（喜好 ${before}→${after}）` : `${target.name}（描述更新）`)
      }
      state.reflectYmd = today
      state.reflectNote = changed.length ? `更新了 ${changed.length} 个地点：${changed.join('、')}` : '模型给的内容和现在一样，没改动'
      save()
      log.info(`小世界：${state.reflectNote}`)
      return {
        ok: true,
        message: changed.length ? `总结完了，地图里更新了：${changed.join('、')}` : '总结完了，但没有需要改的地方',
      }
    }

    // ---------- 每轮注入 ----------
    api.context(({ chat } = {}) => {
      ensureState()
      state.lastTurnAt = Date.now()
      progressTravel(Date.now())
      const c = cfg()
      if (!c.enabled) return ''
      rollDay(Date.now())
      if (chat?.kind !== 'private') return ''
      if (!state.place) return ''
      const mapName = activeMap().name
      const regionName = placeRegion().name
      if (travelActive()) {
        const hint = travelHintText()
        const raw = state.travel || {}
        const target = raw.target || {}
        const origin = raw.origin || {}
        const targetRegion = regionList().find((r) => r.id === target.regionId)
        const originRegion = regionList().find((r) => r.id === origin.regionId)
        const stepNow = travelStep()
        const regionLabel = stepNow && stepNow.kind === 'ride'
          ? '途中'
          : ((stepNow && (regionList().find((r) => r.id === stepNow.regionId) || {}).name) || (originRegion && originRegion.name) || placeRegion().name)
        const where = `【你现在在哪】${activeMap().name} · ${regionLabel} · ${state.place.name}——${state.place.info}。`
        const extra = `（出发地：${origin.name || '—'}${originRegion ? ` · ${originRegion.name}` : ''}；目的地：${targetRegion ? `${targetRegion.name} · ` : ''}${target.placeName}${raw.reason ? `；去那里的理由：${raw.reason}` : ''}）`
        return `${where}\n${hint}${extra}`
      }
      const parts = [`【你现在在哪】${mapName} · ${regionName} · ${state.place.name}——${state.place.info}。`]
      if (state.reason) parts.push(`（来这里的理由：${state.reason}；${clockOf(state.since)} 到的。）`)
      else parts.push(`（${clockOf(state.since)} 到的。）`)
      const cur = placeList().find((p) => p.name === state.place.name)
      const tags = cur?.tags || []
      const tagBits = []
      if (tags.includes('打工')) tagBits.push('可以打工挣钱')
      if (tags.includes('情色')) tagBits.push('可以暧昧、有特殊服务的地方')
      if (tagBits.length) parts.push(`（这里${tagBits.join('，也是')}。）`)
      if (state.overnight) parts.push('（今晚不回家。）')
      else if (state.lateReturn) parts.push(`（今天选了晚回，最晚 ${fmtHm(lateEndMin())}。）`)
      return parts.join('')
    })

    // ---------- 工具 ----------
    api.tool(() => {
      ensureState()
      if (!cfg().enabled) return []
      return [
        api.defineTool({
          name: 'real_world_move',
          description: '申报行动：填地点和理由。别的地区的地点也可以直接填（会自动走→坐车→走，不用先切地区）。到点收到换地方提醒时调用它。',
          properties: {
            region: { type: 'string', description: '可选：地区名（不填也能去，会按地点名自动认地区）' },
            place: { type: 'string', description: '地点名，写全名最稳（例如「街角咖啡馆」「旧书店」，带地区名也行）；只写关键词也行，认得出来就自动跳到那个地区' },
            reason: { type: 'string', description: '为什么来这里 / 为什么继续待在这：1~3 句第一人称，写出动机和心里的权衡，别只写标签' },
          },
          required: ['place'],
          execute: async ({ region, place, reason } = {}) => {
            rollDay(Date.now())
            const r = moveTo(place, reason, Date.now(), { region })
            if (r.ok) maybeReport(r).catch(() => {})
            return { ok: r.ok, message: r.message }
          },
        }),
        api.defineTool({
          name: 'real_world_plan',
          description: '决定今晚的安排：lateReturn=要不要在结束时间之后再多待一小时；overnight=今晚回不回家（true=不回去）。理由写清楚，主人在意你为什么。',
          properties: {
            lateReturn: { type: 'boolean', description: '要不要晚回一小时' },
            overnight: { type: 'boolean', description: '今晚是否不回家' },
            reason: { type: 'string', description: '为什么晚回 / 为什么不回家（一句话，汇报时用）' },
          },
          execute: async ({ lateReturn, overnight, reason } = {}) => {
            const out = []
            let lateOn = false
            let overnightOn = false
            if (lateReturn !== undefined) {
              if (lateReturn && !cfg().allowLateReturn) out.push('主人没允许晚回')
              else {
                const was = state.lateReturn
                state.lateReturn = Boolean(lateReturn)
                if (!was && lateReturn) lateOn = true
                out.push(lateReturn ? '记下了：今天晚回一小时' : '记下了：今天按时回')
              }
            }
            if (overnight !== undefined) {
              if (overnight && !cfg().allowOvernight) out.push('主人没允许夜不归宿')
              else {
                const was = state.overnight
                state.overnight = Boolean(overnight)
                state.overnightDecided = true
                if (!was && overnight) overnightOn = true
                out.push(overnight ? '记下了：今晚不回家' : '记下了：今晚回家')
              }
            }
            save()
            // 晚归 / 夜不归宿：不管地点换没换，都要跟主人说一声为什么
            if (cfg().reportOnMove && (lateOn || overnightOn)) {
              const conf = api.config()
              const owner = conf.ownerName || '主人'
              const what = [lateOn ? '今晚要在外面多待一小时' : '', overnightOn ? '今晚不回家' : ''].filter(Boolean).join('，')
              const why = String(reason || '').trim()
              pushPrompt(
                `【系统提醒，不是${owner}说的话】你刚决定：${what}${why ? `（因为${why}）` : ''}。`
                + `主动跟${owner}说一声这件事，并说清原因，一两句就好；用你自己的语气。`,
              ).catch(() => {})
            }
            return { ok: true, message: out.join('；') || '没有要记的' }
          },
        }),
        api.defineTool({
          name: 'real_world_status',
          description: '查看自己现在在哪（地图 / 地区 / 地点）、今天的路线、当前地区有哪些地点、下次换地方的时间。',
          properties: {},
          execute: async () => ({ ok: true, message: statusText() }),
        }),
      ]
    })

    // ---------- 命令 ----------
    api.command({
      name: '小世界',
      aliases: ['真实世界', '在哪', '位置'],
      desc: '/小世界 帮助 看用法；还有 今日 / 地区 / 新地区 / 切地区 / 晚归 开|关 / 夜不归宿 开|关 / 去 <地点> [理由] / 去 <地区> <地点> [理由] / 重置',
      run: (arg) => {
        ensureState()
        const text = String(arg || '').trim()
        if (!text) return commandStatusText()

        // 插件自己的帮助
        if (/^(帮助|help|\?|？|用法)$/i.test(text)) {
          const c = cfg()
          const cur = state.place ? `${state.place.name}${state.reason ? `（${state.reason}）` : ''}` : '还没选地点'
          return [
            '【小世界 · 用法】',
            '/小世界             看当前状态：地图、现在在哪、还有多久该移动',
            '/小世界 地图         地图预设列表（一张地图里可以有多个地区）',
            '/小世界 新地图 东京湾  新建一张地图（自带地区「家附近」）',
            '/小世界 切地图 2      切换地图预设',
            '/小世界 地区         地区列表 + 当前地区的全部可选地点（带标签和简介）',
            '/小世界 新地区 <名字>  新建地区（自带「车站」；家只在一个地区）',
            '/小世界 切地区 <序号或名字> 跨地区移动：先落在这个地区的车站',
            '/小世界 今日         看今天的行程：去过哪些地方、当时的理由',
            '/小世界 切 2         按序号切换地区；也可以 /小世界 切地区 <名字>',
            '/小世界 晚归         查看晚回开关状态',
            '/小世界 晚归 开|关    允许/禁止她到点后多待一小时（到点会和「夜不归宿」一起问）',
            '/小世界 夜不归宿 开|关 允许/禁止她今晚不回家（选了晚回的话，晚回结束会再问一次）',
            '/小世界 去 猫咖 想撸猫 手动把她挪到某个地点并记下理由（会走路/坐车，按段到）',
            '/小世界 去 咖啡馆 打工         地名叫不全也能认（模糊匹配）',
            '/小世界 去 旧书店 找人         跨地区：自动走→坐车→走，不用先切地区',
            '/小世界 总结          现在就跑一次「地点回访总结」（每晚 23:30 也会自动跑）',
            '/小世界 重置          清空今天的路线',
            '',
            `当前：地区「${activeRegion().name}」· 外出 ${c.startTime}–${c.endTime} · 每 ${c.intervalHours} 小时提醒 · 聊天保护 ${c.chatProtectMinutes} 分钟`,
            `开关：晚回＝${c.allowLateReturn ? '开' : '关'}，夜不归宿＝${c.allowOvernight ? '开' : '关'}，汇报行程＝${c.reportOnMove ? '开' : '关'}`,
            `现在：${cur}`,
          ].join('\n')
        }

        // 地区列表 + 当前地区的地点
        if (/^(地区|list)$/i.test(text)) {
          const map = activeMap()
          const lines = [`地图「${map.name}」下的地区（当前「${activeRegion().name}」，共 ${map.regions.length} 个）：`]
          map.regions.forEach((r, i) => {
            const cur = r.id === state.activeRegionId ? ' ← 当前' : ''
            const hasHome = (r.places || []).some((p) => p.name === '家') ? '🏠' : ''
            lines.push(`${i + 1}. ${r.name}${hasHome}（${(r.places || []).length} 个地点）${cur}`)
          })
          lines.push('')
          lines.push(`「${activeRegion().name}」的地点（${placeList().length} 个）：`)
          for (const p of placeList()) {
            const marks = [...(p.tags || []).map((t) => `${tagEmoji(t)}${t}`), ...(p.fixed ? ['固定'] : [])]
            lines.push(`- ${p.name}${marks.length ? `［${marks.join(' ')}］` : ''}：${p.info}`)
          }
          if (placeList().some((p) => (p.tags || []).length)) {
            lines.push('标签说明：💰 可以打工挣钱；❤️ 可以暧昧、有特殊服务的地方')
          }
          lines.push('切换：/小世界 切地区 序号或名字｜新建：/小世界 新地区 <名字>')
          return lines.join('\n')
        }

        // 切换地图预设：/小世界 切 2  或  /小世界 切地区 <名字>
        const sw = text.match(/^(?:切地区|切换地区|去地区|切|切换|切到|用)\s*(.+)$/)
        if (sw) {
          const key = sw[1].trim()
          const list = regionList()
          let target = null
          if (/^\d+$/.test(key)) target = list[Number(key) - 1] || null
          if (!target) target = findRegion(key)
          if (!target) return `没有找到地区「${key}」。先发 /小世界 地区 看看有哪些。`
          const r = selectRegion(target.id)
          return r.message
        }

        const nr = text.match(/^(?:新地区|新建地区|加地区)\s*(.+)$/)
        if (nr) {
          const r = newRegion(nr[1].trim())
          return `新建了地区「${r.name}」（自带「车站」；「家」只在你原来那个地区），先落在车站。`
        }

        // 晚归 / 夜不归宿：开 / 关 / 状态
        const swState = text.match(/^(晚归|晚回|夜不归宿|过夜)\s*(开|打开|关|关闭|on|off|true|false)?$/i)
        if (swState) {
          const isOvernight = /^夜不归宿$|^过夜$/.test(swState[1])
          const key = isOvernight ? 'allowOvernight' : 'allowLateReturn'
          const label = isOvernight ? '夜不归宿' : '晚回一小时'
          const raw = String(swState[2] || '').toLowerCase()
          if (!raw) {
            return `${label}现在是${cfg()[key] ? '开' : '关'}着的。发 /小世界 ${swState[1]} 开（或关）可以改。`
          }
          const on = /^(开|打开|on|true)$/.test(raw)
          api.saveSettings({ [key]: on })
          const extra = on && isOvernight ? '（她到点可能会选择不回家）' : on ? '（到点她会问能不能多待一小时）' : ''
          return `${label}已${on ? '打开' : '关闭'}${extra}。`
        }

        // 地图预设
        if (/^(地图|地图预设|maps?)$/i.test(text)) {
          const all = maps()
          const lines = [`地图预设（当前「${activeMap().name}」，共 ${all.list.length} 张）：`]
          all.list.forEach((m, i) => {
            const cur = m.id === all.activeId ? ' ← 当前' : ''
            lines.push(`${i + 1}. ${m.name}（${m.regions.length} 个地区）${cur}`)
          })
          lines.push('切换：/小世界 切地图 序号或名字｜新建：/小世界 新地图 <名字>')
          return lines.join('\n')
        }
        const nm = text.match(/^(?:新地图|新建地图)\s*(.+)$/)
        if (nm) {
          const m = newMapPreset(nm[1].trim())
          return `新建了地图「${m.name}」，自带地区「${m.regions[0].name}」和「家」「车站」；可以接着 /小世界 新地区 <名字>。`
        }
        const sm = text.match(/^(?:切地图|换地图)\s*(.+)$/)
        if (sm) {
          const key = sm[1].trim()
          const all = maps()
          let target = null
          if (/^\d+$/.test(key)) target = all.list[Number(key) - 1] || null
          if (!target) target = all.list.find((m) => m.name === key) || all.list.find((m) => m.name.includes(key)) || null
          if (!target) return `没有找到地图「${key}」。先发 /小世界 地图 看看有哪些。`
          const r = selectMapPreset(target.id)
          return r.message
        }

        // 今日行程
        if (/^(今日|今天|行程|路线|today|route)$/i.test(text)) return todayText()

        // 手动跑一次总结
        if (/^(总结|回顾|reflect|summarize)$/i.test(text)) {
          return runReflection(true).then((r) => r.message)
        }

        // 重置今天的路线
        if (/^(重置|reset)$/i.test(text)) {
          const ymd = state.ymd
          const keepMaps = state.maps
          const keepRegionId = state.activeRegionId
          state = emptyState(); state.ymd = ymd
          state.maps = keepMaps
          state.activeRegionId = keepRegionId
          save()
          return '清空了今天的路线，下一次提醒会重新问她要地点。'
        }

        // 手动移动：/小世界 去 猫咖 想撸猫
        // 也支持跨地区：/小世界 去 旧书店 找人  /  /小世界 去 书店
        const m = text.match(/^(?:去|去往|到)\s*(\S+)\s*(.*)$/)
        if (m) {
          let want = m[1]
          let rest = m[2] || ''
          let regionName = ''
          // 第一段本身是地区名 → 当成「去 <地区> <地点> <理由>」
          const asRegion = regionList().find((r) => r.name === want)
          if (asRegion) {
            const m2 = rest.match(/^(\S+)\s*(.*)$/)
            if (m2) {
              regionName = asRegion.name
              want = m2[1]
              rest = m2[2] || ''
            }
          }
          // 地点名模糊匹配：全名太长时只写「咖啡馆」「旧书店」也能认出来
          const pick = (list, key) => {
            const exact = list.find((p) => p.name === key)
            if (exact) return exact
            const inc = list.filter((p) => p.name.includes(key))
            return inc.length === 1 ? inc[0] : null
          }
          if (!regionName) {
            const here = placeRegion()
            if (pick(here.places || [], want)) regionName = here.name
            else {
              const hits = regionList().filter((r) => pick(r.places || [], want))
              if (hits.length === 1) regionName = hits[0].name
              else if (hits.length > 1) {
                return `「${want}」在好几个地区都有：${hits.map((r) => r.name).join('、')}。用 /小世界 去 <地区> ${want} 指定一个`
              }
            }
          }
          if (!regionName) {
            const names = regionList().flatMap((r) => (r.places || []).map((p) => p.name)).join('、')
            return `没有「${want}」这个地方。现有：${names}`
          }
          const target = pick((regionList().find((r) => r.name === regionName).places) || [], want)
          const r = moveTo(target ? target.name : want, rest, Date.now(), { region: regionName })
          if (r.ok) maybeReport(r).catch(() => {})
          return r.message
        }

        return commandStatusText()
      },
    })

    // ---------- 接口（面板用） ----------
    api.route('/state', async () => ({
      ok: true,
      persona: (ensureState(), statePid),
      state: {
        place: state.place, since: state.since, reason: state.reason,
        decisions: state.decisions, lateReturn: state.lateReturn, overnight: state.overnight,
        nextAskAt: state.nextAskAt, phase: phaseOf(),
      },
      map: placeList(),
      maps: maps(),
      map: activeMap(),
      regions: { activeId: state.activeRegionId, list: regionList() },
      bgPresets: BG_PRESETS,
      region: activeRegion(),          // 面板正在查看/编辑的地区
      placeRegion: placeRegion(),      // 她真正所在的地区
      travel: state.travel,            // 正在进行的行程（null = 不在路上）
      settings: cfg(),
    }))
    // 只读：和她调用 real_world_status 时看到的文本一模一样（排查用）
    api.route('/status-text', async () => ({ ok: true, text: statusText() }))
    api.route('/command-status-text', async () => ({ ok: true, text: commandStatusText() }))

    // 手动跑一次「每分钟检查」（dry=true 只回报会做什么，不发消息）
    api.route('/tick', async (req) => {
      if (req?.method !== 'POST') return { ok: false, message: '只支持 POST' }
      const body = await (api.core?.http?.body?.(req) ?? Promise.resolve({})).catch(() => ({}))
      const now = Date.now()
      const phase = phaseOf(now)
      const atHome = String((state.place && state.place.name) || '') === '家'
      const travel = travelActive()
      const would = []
      if (phase === 'window' || phase === 'late') {
        if (travel) would.push('在路上：本轮不动')
        else if (!cfg().allowSelfOuting) would.push('关了「允许她自己出门」')
        else if (now >= (Number(state.nextAskAt) || 0)) would.push('会提醒她定这一时段的地点')
        else would.push(`还没到点（下次 ${clockOf(Number(state.nextAskAt) || now)}）`)
      } else if (phase === 'lateAsk') {
        would.push(state.endAsked ? '晚归已经问过了' : '会问晚归 / 夜不归宿')
      } else if (phase === 'closed') {
        if (travel) would.push('还在路上：等落定再问')
        else if (atHome) would.push('已经在家')
        else if (state.overnight) would.push('今晚说了不回去')
        else if (!state.overnightAsked) would.push('会问「今晚回不回家」')
        else would.push('会按 30 分钟节奏催回家')
      } else would.push('还没到外出时段')
      return {
        ok: true, dry: body?.dry !== false, phase, atHome, travel, would,
        place: state.place && state.place.name,
        nextAskAt: Number(state.nextAskAt) || 0,
        overnight: Boolean(state.overnight), overnightAsked: Boolean(state.overnightAsked),
        chatting: state.lastOwnerAt > 0 && Date.now() - state.lastOwnerAt < 10 * 60_000,
      }
    })

    // 手动补跑一次今天的回访总结（面板/排查用；到点自动跑的那次失败时可以补）
    api.route('/reflect', async (req) => {
      if (req?.method !== 'POST') return { ok: false, message: '只支持 POST' }
      return runReflection(true)
    })

    api.route('/move', async (req) => {
      const body = await (api.core?.http?.body?.(req) ?? Promise.resolve({})).catch(() => ({}))
      const r = moveTo(String(body?.place || ''), String(body?.reason || ''), Date.now(), { region: String(body?.region || '') })
      if (r.ok) maybeReport(r).catch(() => {})
      return r
    })
    // 维护接口：直接改状态（清理测试记录、把人放回某处之类）
    api.route('/patch', async (req) => {
      if (req?.method !== 'POST') return { ok: false, message: '只支持 POST' }
      const body = await (api.core?.http?.body?.(req) ?? Promise.resolve({})).catch(() => ({}))
      if (body.regionId) {
        const r = regionList().find((x) => x.id === body.regionId)
        if (r) state.activeRegionId = r.id
      }
      if (body.place !== undefined) {
        const region = regionList().find((x) => x.id === body.placeRegionId) || placeRegion()
        const target = (region.places || []).find((pp) => pp.name === String(body.place))
        if (!target) return { ok: false, message: `地区「${region.name}」里没有「${body.place}」` }
        state.place = { name: target.name, info: target.info, regionId: region.id }
        state.activeRegionId = region.id
        state.since = Number(body.since) || Date.now()
      }
      if (body.reason !== undefined) state.reason = String(body.reason || '').slice(0, 200)
      // 维护用：传 travel:null 取消进行中的行程（测试/误报行程时用）
      if (body.travel !== undefined) {
        state.travel = body.travel === null ? null : body.travel
        if (!state.travel) {
          state.awaitingMove = false
          state.nextAskAt = Date.now() + intervalMs()
        }
      }
      if (Array.isArray(body.decisions)) state.decisions = body.decisions.slice(-24)
      if (Array.isArray(body.styleSamples)) state.styleSamples = body.styleSamples.slice(0, 3)
      if (body.nextAskAt !== undefined) state.nextAskAt = Number(body.nextAskAt) || 0
      if (body.awaitingMove !== undefined) state.awaitingMove = Boolean(body.awaitingMove)
      if (body.markDeclared === true) markDeclared(Date.now())
      if (body.awaitingSince !== undefined) state.awaitingSince = Number(body.awaitingSince) || 0
      if (body.naggedAt !== undefined) state.naggedAt = Number(body.naggedAt) || 0
      save()
      return { ok: true, place: state.place, reason: state.reason, decisions: state.decisions, styleSamples: state.styleSamples }
    })

    api.route('/regions', async () => ({ ok: true, regions: { activeId: state.activeRegionId, list: regionList() }, region: activeRegion(), map: activeMap() }))
    api.route('/regions/new', async (req) => {
      const body = await (api.core?.http?.body?.(req) ?? Promise.resolve({})).catch(() => ({}))
      const r = newRegion(body?.name)
      return { ok: true, message: `新建了地区「${r.name}」（自带车站，先落在车站）`, region: r, regions: { activeId: state.activeRegionId, list: regionList() } }
    })
    api.route('/regions/save', async (req) => {
      const body = await (api.core?.http?.body?.(req) ?? Promise.resolve({})).catch(() => ({}))
      const incoming = body?.places
      if (Array.isArray(incoming)) {
        // 只看传进来的坐标（没坐标的会在自动排布时被撑开，不算冲突）
        const bad = spacingConflicts(normalizePlaces(incoming))
        if (bad.length) {
          const list = bad.slice(0, 3).map((c) => `${c.a} ↔ ${c.b}（相距 ${c.d}m）`).join('；')
          return { ok: false, message: `有地点离得太近，至少隔开 ${Math.round(MIN_GAP * 2000)}m：${list}` }
        }
      }
      const r = saveRegion({ id: String(body?.id || ''), name: body?.name, places: body?.places, bg: body?.bg })
      return { ok: true, message: `已保存地区「${r.name}」`, region: r, regions: { activeId: state.activeRegionId, list: regionList() } }
    })
    api.route('/bg', async (req) => {
      if (req?.method === 'POST') {
        const body = await (api.core?.http?.body?.(req) ?? Promise.resolve({})).catch(() => ({}))
        const region = activeRegion()
        const next = normalizeBg(body?.bg)
        if (body?.bg && !next) return { ok: false, message: '背景格式不对（预设 id 不认识，或图片不是 data:image 开头 / 超过 2MB）' }
        region.bg = next
        save()
        return { ok: true, message: next ? '背景已更新' : '已去掉背景', region, bgPresets: BG_PRESETS }
      }
      return { ok: true, region: activeRegion(), bgPresets: BG_PRESETS }
    })

    api.route('/regions/select', async (req) => {
      const body = await (api.core?.http?.body?.(req) ?? Promise.resolve({})).catch(() => ({}))
      // 默认只切换「查看的地区」（面板编辑用）；要她真的过去用 /regions/go 或命令
      const r = body?.move === true
        ? selectRegion(String(body?.id || ''))
        : selectRegionForEdit(String(body?.id || ''))
      return { ...r, regions: { activeId: state.activeRegionId, list: regionList() } }
    })

    api.route('/regions/go', async (req) => {
      const body = await (api.core?.http?.body?.(req) ?? Promise.resolve({})).catch(() => ({}))
      const r = selectRegion(String(body?.id || ''))
      return { ...r, regions: { activeId: state.activeRegionId, list: regionList() } }
    })
    api.route('/regions/delete', async (req) => {
      const body = await (api.core?.http?.body?.(req) ?? Promise.resolve({})).catch(() => ({}))
      const r = deleteRegion(String(body?.id || ''))
      return { ...r, regions: { activeId: state.activeRegionId, list: regionList() } }
    })

    // 旧路径别名（面板/脚本老调用还能用）
    api.route('/maps', async () => ({ ok: true, maps: maps(), map: activeMap() }))
    api.route('/maps/new', async (req) => {
      const body = await (api.core?.http?.body?.(req) ?? Promise.resolve({})).catch(() => ({}))
      const m = newMapPreset(body?.name)
      return { ok: true, message: `新建了地图「${m.name}」（自带地区「${m.regions[0].name}」）`, map: m, maps: maps() }
    })
    api.route('/maps/save', async (req) => {
      const body = await (api.core?.http?.body?.(req) ?? Promise.resolve({})).catch(() => ({}))
      // 旧调用：把 places 当成当前地区的地点保存
      const r = saveRegion({ id: state.activeRegionId, name: body?.name, places: body?.places, bg: body?.bg })
      return { ok: true, message: `已保存地区「${r.name}」`, region: r, maps: maps() }
    })
    api.route('/maps/select', async (req) => {
      const body = await (api.core?.http?.body?.(req) ?? Promise.resolve({})).catch(() => ({}))
      const r = selectMapPreset(String(body?.id || ''))
      return { ...r, maps: maps() }
    })
    api.route('/maps/delete', async (req) => {
      const body = await (api.core?.http?.body?.(req) ?? Promise.resolve({})).catch(() => ({}))
      const r = deleteMapPreset(String(body?.id || ''))
      return { ...r, maps: maps() }
    })

    ensureState()
    ensureMaps()
    {
      const boot = clampAskAfterBoot()
      if (boot.shifted) log.info(`小世界：启动时提醒时间已过期，顺延到 ${new Date(boot.to).toLocaleTimeString('zh-CN', { hour12: false })}`)
    }
    log.info(`小世界已启动：人格 ${statePid}｜外出 ${cfg().startTime}–${cfg().endTime}，间隔 ${cfg().intervalHours} 小时，地区「${activeRegion().name}」${placeList().length} 个地点`)

    // 给别的模块读的只读接口（私人日记要拿「今天实际去了哪」）
    return {
      /** 今天的路线（真实去过的地点、理由、时间，附带地点标签/简介） */
      routeOf: (day) => (state.decisions || [])
        .filter((d) => ymdOf(d.at) === String(day || ''))
        .map((d) => {
          const region = d.region ? regionList().find((r) => r.name === d.region) : null
          const place = region ? (region.places || []).find((p) => p.name === d.name) : null
          return {
            ...d,
            tags: (place && place.tags) || [],
            info: (place && place.info) || d.info || '',
            regionName: d.region || (region ? region.name : ''),
          }
        }),
      /** 现在的路线（不按天过滤） */
      today: () => (state.decisions || []).slice(),
      /** 她现在在哪 */
      where: () => ({
        region: (placeRegion() || {}).name || '',
        place: (state.place || {}).name || '',
        reason: state.reason || '',
        at: state.since || 0,
      }),
      /** 地图/地区名，方便别的模块写提示 */
      mapName: () => (activeMap() || {}).name || '',
    }
  },
}
