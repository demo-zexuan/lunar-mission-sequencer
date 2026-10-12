/**
 * 月球任务时序仪 · 真实数据模型
 *
 * 本模块是整个图形唯一的"真值"来源：任务时序、相位划分、
 * 轨道高度与速度、发动机构型，以及导轨中心线的几何。
 * 图形里的每一个数字（读数、表针、计数窗、旗帜、滑架位置）
 * 都必须从这里的同一个瞬间取值，不允许各自插值。
 *
 * I. 任务时序
 *
 * 1. 事件表（EVENTS）：阿波罗 11 号 9 个关键事件，MET 为真实秒数
 *    (1) 每个事件同时携带导轨进度 p，p 决定几何位置
 *    (2) p 的分配同时决定巡游时各相位的显示时长
 * 2. 相位表（PHASES）：事件之间的 8 段区间，读数与表盘按它分区
 *
 * II. 物理量
 *
 * 1. 高度/距离/速度按相位线性插值，端点取真实数值
 * 2. 发动机构型（burn）决定 WebGL 尾焰挂在哪一级、推力多大
 * 3. 构型（stack）决定箭体哪几段还在：分离后逐段消失
 *
 * III. 导轨几何
 *
 * 1. 导轨中心线是一条平面曲线（y 恒为 0），由 PROFILE 控制点
 *    以 p 为参数的 Catmull-Rom 样条生成
 * 2. 滑架挂在 y = +14 的竖直平面内，因此导轨可以从背后支撑
 * 3. 采样后的折线同时供三处使用：绘制、审计形状、页面运动学
 *
 * @module src/model
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-10-12
 */

// ============================================================================
// I. 任务时序
// ============================================================================

/** 1. 事件表：MET 单位秒，p 为导轨进度（0 = 发射台，1 = 溅落） */
export const EVENTS = [
  { code: "LIFTOFF", zh: "点火升空", en: "Liftoff", met: 0, p: 0.0 },
  { code: "SIC-SEP", zh: "一级分离", en: "S-IC staging", met: 162, p: 0.055 },
  { code: "ORBIT", zh: "停泊轨道", en: "Parking orbit", met: 709, p: 0.115 },
  { code: "TLI", zh: "地月转移注入", en: "Trans-lunar injection", met: 9856, p: 0.2 },
  { code: "LOI", zh: "环月轨道进入", en: "Lunar orbit insertion", met: 272990, p: 0.55 },
  { code: "TOUCHDOWN", zh: "月面着陆", en: "Lunar touchdown", met: 369940, p: 0.7 },
  { code: "DOCK", zh: "上升与对接", en: "Ascent and docking", met: 460980, p: 0.78 },
  { code: "TEI", zh: "返回点火", en: "Trans-earth injection", met: 487422, p: 0.86 },
  { code: "SPLASHDOWN", zh: "再入溅落", en: "Reentry and splashdown", met: 703115, p: 1.0 },
];

/** 八个相位各自的名称：相位描述的是这一段时间里在做什么，不是事件名 */
const PHASE_NAMES = [
  ["上升飞行", "Ascent"],
  ["入轨", "Orbit insertion"],
  ["停泊轨道", "Parking orbit"],
  ["地月转移", "Trans-lunar coast"],
  ["环月与下降", "Lunar orbit and descent"],
  ["月面活动与上升", "Surface stay and ascent"],
  ["对接与返回准备", "Docking and TEI prep"],
  ["返回与再入", "Return and reentry"],
];

/** 2. 相位表：第 i 段 = EVENTS[i] → EVENTS[i+1]，共 8 段 */
export const PHASES = EVENTS.slice(0, -1).map((from, index) => {
  const to = EVENTS[index + 1];
  return {
    index,
    code: `${from.code}→${to.code}`,
    zh: PHASE_NAMES[index][0],
    en: PHASE_NAMES[index][1],
    from: from.met,
    to: to.met,
    pFrom: from.p,
    pTo: to.p,
  };
});

/** 任务总时长（秒），用于读数与文档 */
export const TOTAL_MET = EVENTS[EVENTS.length - 1].met;

/** 真实参考量（说明书、卡片说明与图注引用） */
export const FACTS = {
  distanceKm: 384400,
  saturnVHeightM: 110.6,
  saturnVLiftoffMassT: 2970,
  tliDeltaVKmS: 3.05,
  entrySpeedKmS: 11.0,
  lmMassT: 15.1,
  earthRadiusKm: 6371,
  moonRadiusKm: 1737,
  parkingOrbitKm: 185,
  periluneKm: 111,
};

// ============================================================================
// II. 物理量
// ============================================================================

const lerp = (a, b, f) => a + (b - a) * f;
const clamp01 = (f) => Math.min(1, Math.max(0, f));

/**
 * 每个相位的端点物理量：[高度 km, 距离地心 km, 速度 km/s]
 *
 * 1. 高度是相对当前主天体（地球相位相对地球，月球相位相对月面）
 * 2. 距离地心用于读数；月球段取近似的月球距离
 * 3. 速度为惯性速度，TLI 后 10.83 → 0.98，再入 11.0 → 0
 */
const ENDPOINTS = [
  // 0 发射：0 → 一级分离
  { alt: [0, 67], range: [6371, 6438], speed: [0, 2.76] },
  // 1 一级分离 → 入轨
  { alt: [67, 185], range: [6438, 6556], speed: [2.76, 7.79] },
  // 2 停泊轨道
  { alt: [185, 185], range: [6556, 6556], speed: [7.79, 7.79] },
  // 3 TLI → 环月：距离地心 6556 → 384400 - 1737
  { alt: [185, 111], range: [6556, 382663], speed: [7.79, 0.98] },
  // 4 LOI → 着陆：月面高度 111 → 0
  { alt: [111, 0], range: [384400, 384400], speed: [1.63, 0] },
  // 5 着陆 → 上升对接
  { alt: [0, 111], range: [384400, 384400], speed: [0, 1.63] },
  // 6 对接 → 返回点火
  { alt: [111, 111], range: [384400, 384400], speed: [1.63, 1.63] },
  // 7 返回 → 溅落：距离地心 384400 → 6371
  { alt: [111, 0], range: [384400, 6371], speed: [1.63, 0] },
];

/**
 * 相位内分数
 *
 * @param p - 导轨进度 0..1
 * @returns {{ index: number, f: number, met: number }}
 */
export function phaseAt(p) {
  const at = clamp01(p);
  // 找到 p 落在哪一段事件区间
  let index = PHASES.length - 1;
  for (let i = 0; i < PHASES.length; i++) {
    if (at >= PHASES[i].pFrom && at <= PHASES[i].pTo) {
      index = i;
      break;
    }
  }
  const ph = PHASES[index];
  const span = ph.pTo - ph.pFrom;
  const f = span > 1e-9 ? clamp01((at - ph.pFrom) / span) : 0;
  return { index, f, met: lerp(ph.from, ph.to, f) };
}

/** 相位内的物理量，读数与图注都从这里取 */
export function physicsAt(p) {
  const { index, f, met } = phaseAt(p);
  const e = ENDPOINTS[index];
  return {
    index,
    f,
    met,
    altKm: lerp(e.alt[0], e.alt[1], f),
    rangeKm: lerp(e.range[0], e.range[1], f),
    speedKmS: lerp(e.speed[0], e.speed[1], f),
    onMoon: index === 4 || index === 5,
  };
}

/**
 * 发动机构型
 *
 * I. 返回当前正在工作的发动机与推力水平（0..1）
 *
 * 1. 各次点火都用真实的持续时长换算成相位内分数
 *    (1) S-IC 与 S-II 覆盖整个上升段
 *    (2) TLI 点火 5 分 47 秒，落在相位 3 的最前段
 *    (3) 两次 LOI 点火、动力下降、上升级、SPS 返回点火
 * 2. 推力水平用于尾焰长度与亮度，不参与任何数字读数
 */
export function burnAt(p) {
  const { index, f } = phaseAt(p);
  const thrust = (level) => ({ engine: level > 0 ? "on" : "off", level });
  if (index === 0) return { engine: "s1c", level: 1 };
  if (index === 1) return { engine: f < 0.55 ? "s2" : "s4b", level: 1 };
  if (index === 2) return thrust(0);
  if (index === 3) return f < 0.012 ? { engine: "s4b", level: 1 } : thrust(0);
  if (index === 4) {
    // 两次环月制动 + 动力下降（相位末段 12 分钟）
    if (f < 0.03 || (f > 0.1 && f < 0.14)) return { engine: "sps", level: 0.85 };
    if (f > 0.96) return { engine: "lmd", level: 0.6 };
    return thrust(0);
  }
  if (index === 5) {
    if (f < 0.06) return thrust(0); // 月面停留
    if (f < 0.12) return { engine: "lma", level: 0.7 };
    return thrust(0);
  }
  if (index === 6) return f > 0.55 && f < 0.72 ? { engine: "sps", level: 0.8 } : thrust(0);
  return thrust(0);
}

/**
 * 箭体构型
 *
 * I. 返回此刻还挂在滑架上的舱段
 *
 * 1. 分离时刻取真实 MET：逃逸塔 T+3:17、一级 T+2:42、
 *    二级 T+9:30、三级（TLI 后）T+2:50、登月舱对接后抛弃、
 *    服务舱再入前抛弃
 * 2. 布尔值直接驱动页面上的 display 切换
 */
export function stackAt(p) {
  const met = phaseAt(p).met;
  return {
    les: met < 197,
    s1c: met < 162,
    s2: met < 570,
    s4b: met < 10256,
    lm: met < 490000,
    sm: met < 700000,
  };
}

/**
 * 级间分离
 *
 * I. 每一级都在真实时刻脱离，并且**看得见地离开**
 *
 * 1. 分离不是瞬间消失：从 met 起用 JETTISON_SPAN 的时长把该级推离箭体
 *    (1) 推离方向取"向后下方"，与飞行方向相反，符合真实的分离相对运动
 *    (2) 同时淡出，最终从绘制里移除，但分离过程本身是可见的
 * 2. 逃逸塔是例外：它在 T+3:17 向前上方抛掉（逃逸塔分离是拉走，不是掉落）
 * 3. 服务舱在再入前抛掉，溅落的只有指令舱
 */

/** 分离动画占全程的比例：真实 8 天压进 17 秒巡游，这里给足约 0.5 秒的可见过程 */
export const JETTISON_SPAN = 0.028;

/**
 * 由 MET 反查导轨进度
 *
 * 时间轴是分段线性的（前 12 小时占了导轨的一半），所以 MET 上的跨度
 * 不能直接当成 p 上的跨度：分离动画必须在 p 上量，否则一级分离要
 * 花掉三个小时的真实任务时间才走完。
 */
export function pAtMet(met) {
  for (const ph of PHASES) {
    if (met >= ph.from && met <= ph.to) {
      const span = ph.to - ph.from;
      return span > 1e-9 ? ph.pFrom + (ph.pTo - ph.pFrom) * ((met - ph.from) / span) : ph.pFrom;
    }
  }
  return met <= 0 ? 0 : 1;
}

/** 分离顺序与方向：dir 是 (x, y, z) 上的相对推离方向 */
export const JETTISON = [
  { id: "sic", met: 162, zh: "一级分离", dir: [-1, 0, -1] },
  { id: "les", met: 197, zh: "逃逸塔分离", dir: [1, 0, 1] },
  { id: "s2", met: 571, zh: "二级分离", dir: [-1, 0, -1] },
  { id: "s4b", met: 10256, zh: "三级分离", dir: [-1, 0, -1] },
  // 服务舱真实分离在 T+194:49，落在导轨最后 0.1% 上，按 MET 换算根本看不见；
  // 这里改用它所在的再入界面 p 值，事件本身不变
  { id: "sm", p: 0.962, met: 700000, zh: "服务舱分离", dir: [1, 0, -1] },
];

/** 分离行程（世界单位）：够远到读得出"掉下去了"，又不至于飞出画面 */
export const JETTISON_TRAVEL = 54;

/**
 * 每级的分离进度
 *
 * @param p - 导轨进度 0..1
 * @returns {Record<string, number>} 0 = 仍连着，1 = 已完全脱离
 */
export function jettisonAt(p) {
  const out = {};
  for (const event of JETTISON) out[event.id] = clamp01((p - (event.p ?? pAtMet(event.met))) / JETTISON_SPAN);
  return out;
}

/**
 * 登月舱吊放行程
 *
 * I. 滑架在月面上方停住，卷扬机把登月舱单独放下再收回
 *
 * 1. 下降：p 0.655 → 0.700，行程 0 → 1
 * 2. 月面停留：p 0.700 → 0.735，保持 1
 * 3. 上升与对接：p 0.735 → 0.780，行程 1 → 0
 * 4. 行程换算成世界单位由 geometry 决定（HOIST_TRAVEL）
 */
export function hoistAt(p) {
  const at = clamp01(p);
  if (at <= 0.655) return 0;
  if (at < 0.7) return clamp01((at - 0.655) / 0.045);
  if (at <= 0.735) return 1;
  if (at < 0.78) return 1 - clamp01((at - 0.735) / 0.045);
  return 0;
}

/** MET → "T+102:45:40" */
export function metLabel(met) {
  const s = Math.max(0, Math.round(met));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `T+${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/** 数字分组，读数用 */
export function group(value, digits = 0) {
  const fixed = value.toFixed(digits);
  const [whole, frac] = fixed.split(".");
  const spaced = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${spaced}.${frac}` : spaced;
}

// ============================================================================
// III. 导轨几何
// ============================================================================

/**
 * 导轨中心线控制点 [x, y, z, p]
 *
 * I. 曲线即任务剖面：左端发射台起，陡升、平飞、落到月球上方，
 *    再沿一条更低的返回弧折回左端，最后陡降入水
 *
 * 1. 高度由悬挂几何反推
 *    (1) 发射台：箭体底部 z = 8（台面），全箭挂长 74 → 导轨 z = 82
 *    (2) 月面：登月舱底部落在月面 z = 113，吊放行程 26 → 导轨 z = 185
 *    (3) 溅落：指令舱底部落到水面 z = 24，只剩逃逸塔以下 → 导轨 z = 56
 * 2. 去程弧与回程弧在竖直方向拉开约 25 单位，避免屏幕上重叠
 * 3. 月面停靠点 p 0.700 → 0.780 几乎不动，由卷扬机完成下降与上升
 */
export const PROFILE = [
  [-125, 0, 90, 0.0],
  [-122, 0, 100, 0.03],
  [-116, 0, 112, 0.055],
  [-106, 0, 124, 0.09],
  [-94, 0, 131, 0.115],
  [-72, 0, 136, 0.15],
  [-26, 0, 139, 0.2],
  [28, 0, 140, 0.35],
  [72, 0, 139, 0.45],
  [98, 0, 138, 0.55],
  [122, 0, 138, 0.62],
  [142, 0, 139, 0.7],
  [140, 0, 139, 0.78],
  [20, 0, 116, 0.86],
  [-40, 0, 111, 0.9],
  [-90, 0, 103, 0.93],
  [-118, 0, 92, 0.955],
  [-136, 0, 74, 0.975],
  [-146, 0, 60, 0.99],
  [-150, 0, 52, 1.0],
];

/**
 * 以 p 为参数的 Catmull-Rom 样条（非均匀、端点夹持）
 *
 * I. 三次 Hermite 形式，节点处严格过控制点
 *
 * 1. 切向量取相邻控制点的差商，端点用单侧差商
 * 2. 平顶（月面停靠）处切向量自然趋零，不会产生过冲
 */
function splineAt(p) {
  const at = clamp01(p);
  const n = PROFILE.length;
  let i = n - 2;
  for (let j = 0; j < n - 1; j++) {
    if (at >= PROFILE[j][3] && at <= PROFILE[j + 1][3]) {
      i = j;
      break;
    }
  }
  const a = PROFILE[i];
  const b = PROFILE[i + 1];
  const prev = PROFILE[Math.max(0, i - 1)];
  const next = PROFILE[Math.min(n - 1, i + 2)];
  const span = b[3] - a[3] || 1;
  const t = (at - a[3]) / span;
  const t2 = t * t;
  const t3 = t2 * t;
  const out = [];
  for (let axis = 0; axis < 3; axis++) {
    const m0 = ((b[axis] - prev[axis]) / (b[3] - prev[3] || 1)) * span;
    const m1 = ((next[axis] - a[axis]) / (next[3] - a[3] || 1)) * span;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    out.push(h00 * a[axis] + h10 * m0 + h01 * b[axis] + h11 * m1);
  }
  return out;
}

/**
 * 采样导轨折线
 *
 * I. 生成页面与几何共用的中心线
 *
 * 1. 等 p 采样 480 段，同时累计弧长
 * 2. 返回 { points, lengths, total }，points 为 [x, y, z, p]
 * 3. 页面用它在任意 p 上取位置与切向，几何用它画轨与录形状
 */
export function railPath(steps = 480) {
  const points = [];
  const lengths = [0];
  let total = 0;
  let previous = null;
  for (let i = 0; i <= steps; i++) {
    const p = i / steps;
    const [x, y, z] = splineAt(p);
    if (previous) total += Math.hypot(x - previous[0], y - previous[1], z - previous[2]);
    points.push([x, y, z, p]);
    lengths.push(total);
    previous = [x, y, z];
  }
  return { points, lengths: lengths.slice(1), total };
}

/** 导轨上任意 p 处的世界位置 */
export function railPoint(p) {
  const [x, y, z] = splineAt(p);
  return [x, y, z];
}

/** 导轨上任意 p 处的单位切向（用于滑架俯仰） */
export function railTangent(p) {
  const d = 1e-4;
  const a = splineAt(clamp01(p - d));
  const b = splineAt(clamp01(p + d));
  const v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
