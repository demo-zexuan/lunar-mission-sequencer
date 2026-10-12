/**
 * 月球任务时序仪 · 静态几何与审计形状
 *
 * 本模块把 model.mjs 的真值变成一台真实机器的等距图：
 * 底座、导轨（任务剖面）、滑架、土星五号模型、地球与月球球体、
 * 发射台与塔架、相位表盘、任务钟、事件旗、溅落水箱、电缆。
 *
 * I. 机构设计
 *
 * 1. 导轨被弯成任务剖面的形状，它本身就是这台仪器的"程序"
 *    (1) 左端发射台起，陡升、平飞、停在月球上方，沿更低的返回弧折回，
 *        最后陡降入水；去程弧与回程弧在竖直方向拉开 20 单位以上
 *    (2) 剖面高度由悬挂几何反推：导轨 z = 载荷底部 z + 挂长（HOOK + 箭体）
 * 2. 滑架是单轮吊架：一个主滚轮压在导轨上，一个导向滚轮托在下面
 *    (1) 两个滚轮的轴线都沿 y，而导轨切线始终在 xz 平面内，
 *        所以滚轮在自身平面内滚动，滑架整体平移即可，不需要俯仰
 *    (2) 吊架两片侧板跨在导轨两侧（y = ±3.6）：远侧板必须画在导轨之前、
 *        近侧板画在导轨之后，故拆成 trolley.far / trolley.near 两项
 * 3. 箭体挂在 y = +14 的竖直平面内，让出导轨背面给三根支撑臂
 *
 * II. 运动项与静止项
 *
 * 1. 静止项进 R.put 后由 A.settle 定深度键
 * 2. 运动项（滑架、箭体、旗帜、表针、摆臂）带 data-part 与 data-k，
 *    页面按 data-k + (depth(p) − data-ref) 每帧重排
 * 3. 箭体每一段的 owner 都是 "stack"：静止态内部互相嵌套的接触
 *    由 owner 豁免，但整箭仍通过一级发动机落到发射台上
 *
 * @module src/art
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-10-12
 */

import * as k from "../kit/iso-kit.mjs";
import * as G from "../kit/lathe.mjs";
import { tubePieces, tubeSvg } from "../kit/tube.mjs";
import * as A from "../kit/audit.mjs";
import { railPath, railPoint, EVENTS } from "./model.mjs";

// ============================================================================
// I. 版面常量
// ============================================================================

export const W = 1180;
export const H = 738;
export const AZIMUTH = 34;
export const ELEVATION = 30;

/** 底座与各机构的平面布置 */
export const LAY = {
  plate: { x: -215, y: -56, w: 415, d: 114, r: 10 },
  plateZ: -16,
  plateH: 16,
  footH: 6,
  beam: { x: -190, y: 50, w: 380, d: 7, r: 2 },
  beamH: 5,
  ruler: { x: -186, y: 51, w: 372, d: 5, r: 1 },
  dial: { x: 80, y: 16, r: 28, h: 10 },
  tank: { x: -175, y: -11, w: 31, d: 45, r: 3 },
  tankH: 26,
  water: 24,
  earth: { x: -196, y: 0, r: 22, z: 84 },
  moon: { x: 142, y: 11, r: 24, z: 57 },
  pad: { x: -140, y: 11, w: 30, d: 26, r: 4 },
  padH: 8,
  tower: { x: -104, y: -16 },
  towerH: 70,
  postY: -32,
  posts: [-50, 45, 130],
  tie: 62,
  flags: { from: -140, to: 0, y: 46 },
  counter: { x: -66, y: 4, w: 76, d: 30, r: 4 },
};

export const RAIL_R = 2.4;
export const HOOK = 18;
export const HOIST_TRAVEL = 16;
export const PAD_X = LAY.pad.x;
export const P_REST = 0.008;
export const RAIL_P0 = railPoint(P_REST);

/** 箭体分段：从吊钩往下 [id, 高度, 半径] */
export const STAGES = [
  { id: "les", h: 4, r: 1.2 },
  { id: "cm", h: 6, r: 3.2 },
  { id: "sm", h: 6, r: 3.2 },
  { id: "lm", h: 8, r: 4.0 },
  { id: "s4b", h: 8, r: 4.3 },
  { id: "s2", h: 10, r: 6.0 },
  { id: "sic", h: 20, r: 6.0 },
];

/** 每段的上下端 z（静止态，吊钩在 RAIL_P0[2] − HOOK） */
export const STAGE_TOP = (() => {
  const out = {};
  let z = RAIL_P0[2] - HOOK;
  for (const stage of STAGES) {
    out[stage.id] = { top: z, bottom: z - stage.h, h: stage.h, r: stage.r };
    z -= stage.h;
  }
  return out;
})();

/** 任务钟显示的位数（T+195:18:35） */
export const MET_CHARS = 11;

// ============================================================================
// II. 工具
// ============================================================================

const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const at = (P, point) => k.iso(point, P);

/** 解析回转体：给出 r(s) 与导数，采样成剖面并交给 lathe 的解析平滑 */
function analytic(s0, s1, radius, slope, knots = 24) {
  const profile = [];
  for (let i = 0; i <= knots; i++) {
    const s = s0 + ((s1 - s0) * i) / knots;
    profile.push([s, Math.max(0, radius(s)), 1]);
  }
  return { profile, radius, slope };
}

/** 沿折线按弧长等距重采样，用于把绘制形状录成审计形状 */
function samplePath(points, spacing) {
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (len < 1e-6) continue;
    let t = carry;
    while (t < len) {
      const f = t / len;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
      t += spacing;
    }
    carry = t - len;
  }
  out.push(points[points.length - 1]);
  return out;
}

// ============================================================================
// III. 场景装配
// ============================================================================

/**
 * 装配整台仪器
 *
 * @param P - 投影
 * @param R - 审计记录器
 * @returns 图层项、数据与辅助量
 */
export function buildScene(P, R) {
  const back = [];
  const front = [];
  const shapesOf = new Map();

  /**
   * 放一项：把 svg 交给排序层，同时登记审计形状
   *
   * @param name - 项名（stand.* 前缀代表落到地面）
   * @param atPoint - 世界参考点，决定深度键
   * @param svg - 该项的 SVG
   * @param shapes - 审计形状
   * @param opts - { bias, piece, part, layer }
   */
  const put = (name, atPoint, svg, shapes, opts = {}) => {
    const item = R.put({
      name,
      at: atPoint,
      bias: opts.bias ?? 0,
      piece: opts.piece ?? name.split(".")[0],
      svg,
      shapes,
      part: opts.part ?? null,
    });
    shapesOf.set(name, item);
    (opts.layer === "front" ? front : back).push(item);
    return item;
  };

  const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));

  // --------------------------------------------------------------------------
  // 1. 底座
  // --------------------------------------------------------------------------
  const { plate, plateZ, plateH, footH } = LAY;
  const halo = `<path class="iso-halo" d="${k.haloOf(plate, plateZ - footH, plateH + footH, P)}"/>`;
  for (const [x, y] of byDepth(k.corners(plate, 24))) {
    const svg = S(k.cylinder(x, y, 12, plateZ - footH, 1.8, P, 28), { tone: "lo" }) + S(k.cylinder(x, y, 9, plateZ - footH + 1.8, footH - 1.8, P, 28), { tone: "mid" });
    put("stand.foot", [x, y, plateZ - footH], svg, [R.solid(A.cylinder(x, y, 12, plateZ - footH, 1.8, { name: "stand.foot.flange" })), R.solid(A.cylinder(x, y, 9, plateZ - footH + 1.8, footH - 1.8, { name: "stand.foot.body" }))], { bias: -0.4 });
  }
  const screws = k.corners(plate, 12);
  const plateInner =
    L(k.planOutline(k.insetPlan(plate, 6), 0, P), { tone: "lo" }) +
    L(screws.map(([x, y]) => k.ring(x, y, 2.4, 0, P, 16)).join(""), { tone: "lo" }) +
    D(screws.map(([x, y]) => at(P, [x, y, 0])), { size: 0.5 });
  put("stand.plate", [plate.x + plate.w / 2, plate.y + plate.d / 2, 0], S(k.slabOf(plate, plateZ, plateH, P, 8, 1.6), { tone: "mid", inner: plateInner }), [R.solid(A.slab(plate, plateZ, plateH, { name: "stand.plate", ground: true }))], { bias: -0.3 });

  // 前梁 + 标尺
  const { beam, beamH, ruler } = LAY;
  const ticks = k.topTicks(ruler.x + 4, ruler.x + ruler.w - 4, 5, 5, ruler.y + ruler.d - 1, beamH + 0.6, [1.6, 3.2], P);
  const beamInner =
    S(k.slabOf(ruler, beamH, 0.6, P, 3), { tone: "lo", crease: "none" }) +
    L(ticks.minor, { tone: "lo" }) + L(ticks.major, { tone: "mid" }) +
    L([beam.x + 30, beam.x + 60, beam.x + 90].map((x) => k.planOutline({ x, y: beam.y + 2, w: 18, d: 3, r: 1.2 }, beamH, P, 3)).join(""), { tone: "faint" }) +
    D([at(P, [ruler.x + 2, ruler.y + 3, beamH + 0.6]), at(P, [ruler.x + ruler.w - 2, ruler.y + 3, beamH + 0.6])], { size: 0.45 }) +
    D([at(P, [beam.x + 12, beam.y + 4, beamH]), at(P, [beam.x + beam.w - 12, beam.y + 4, beamH])], { size: 0.45 });
  put("stand.beam", [beam.x + beam.w / 2, beam.y + beam.d / 2, beamH], S(k.slabOf(beam, 0, beamH, P, 4, 0.8), { tone: "mid", inner: L(k.sideSeam(beam, beamH - 1.2, P, 4), { tone: "faint" }) }), [R.solid(A.slab(beam, 0, beamH, { name: "stand.beam" }))], { bias: 0.4, layer: "front" });

  // 铭牌（唯一用规则线代表的印刷文字，端点自由）
  const label = { x: plate.x + 18, y: plate.y + 16, w: 54, d: 26, r: 3 };
  const labelInner =
    L(k.planOutline(k.insetPlan(label, 2), 1.0, P, 3), { tone: "faint" }) +
    L(
      [
        k.lineOnTop([label.x + 6, label.y + 7], [label.x + 44, label.y + 7], 1.02, P),
        k.lineOnTop([label.x + 6, label.y + 13], [label.x + 38, label.y + 13], 1.02, P),
        k.lineOnTop([label.x + 6, label.y + 19], [label.x + 26, label.y + 19], 1.02, P),
      ].join(""),
      { tone: "lo", free: true },
    ) +
    D([at(P, [label.x + 3, label.y + 3, 1.0]), at(P, [label.x + label.w - 3, label.y + label.d - 3, 1.0])], { size: 0.45 });
  put(
    "stand.label",
    [label.x + label.w / 2, label.y + label.d / 2, 1],
    S(k.slabOf(label, 0, 1.0, P, 4), { tone: "lo", crease: "none", inner: labelInner }),
    [R.solid(A.slab(label, 0, 1.0, { name: "stand.label" }))],
    { bias: 0.3 },
  );

  // 表盘与任务钟直接坐在底座台面上

  // --------------------------------------------------------------------------
  // 2. 导轨：任务剖面
  // --------------------------------------------------------------------------
  const RAIL = railPath(480);
  const railPoints = RAIL.points.map(([x, y, z]) => [x, y, z]);
  const railZAtX = (targetX) => {
    // 沿折线线性插值出该 x 处的高度，比取最近采样点准得多
    let best = railPoints[0][2];
    let bestGap = Infinity;
    for (let i = 1; i < railPoints.length; i++) {
      const a = railPoints[i - 1];
      const b = railPoints[i];
      if ((a[0] - targetX) * (b[0] - targetX) > 0) continue;
      const t = Math.abs(b[0] - a[0]) < 1e-6 ? 0 : (targetX - a[0]) / (b[0] - a[0]);
      const z = a[2] + (b[2] - a[2]) * t;
      const gap = Math.abs(z - (a[2] + b[2]) / 2);
      if (gap < bestGap) {
        bestGap = gap;
        best = z;
      }
    }
    return best;
  };
  const railChunks = tubePieces(railPoints, RAIL_R, P, { maxLength: 24, spacing: 2.2 });
  // 导轨整根作为一个绘制项：相邻块在绘制上重叠 0.5，若拆成多项就互为穿插；
  // 滑架永远在导轨之前（y = +14 对 y = 0），所以整根导轨用一个深度键即可
  const railDiscs = [];
  railChunks.forEach((piece) => {
    const samples = samplePath(piece.points, 2.6);
    for (const point of samples) {
      railDiscs.push(point);
    }
  });
  const railShapes = railDiscs.map((point) => R.solid(A.ball(point, RAIL_R, { name: "rail.tube", owner: "rail" })));
  const railMid = railPoints[Math.floor(railPoints.length / 2)];
  const railItem = put("rail.tube", railMid, railChunks.map((piece) => tubeSvg(piece, { tone: "hi" })).join(""), railShapes, { bias: 0.05, piece: "rail" });
  const maxRailKey = railItem.key;

  // 三根支撑立柱：从背面伸臂托住导轨，正面完全让给箭体
  for (const x of LAY.posts) {
    const z = railZAtX(x);
    const basePlan = { x: x - 5, y: LAY.postY - 6, w: 10, d: 12, r: 2 };
    const armPlan = { x: x - 2.6, y: LAY.postY, w: 5.2, d: 29.6, r: 1.4 };
    const saddlePlan = { x: x - 3.6, y: -2.4, w: 7.2, d: 4.8, r: 1 };
    const svg =
      S(k.slabOf(basePlan, 0, 4, P, 4, 0.8), { tone: "mid" }) +
      S(k.cylinder(x, LAY.postY, 5.4, 4, z - 20, P, 28), { tone: "mid", crease: "none" }) +
      L(k.sideArc(x, LAY.postY, 5.4, z * 0.5, P, 20), { tone: "faint" }) +
      S(k.cylinder(x, LAY.postY, 7.0, z - 16, 6, P, 28), { tone: "mid" }) +
      S(k.cylinder(x, LAY.postY, 5.4, z - 10, 3.6, P, 28), { tone: "mid", crease: "none" }) +
      S(k.slabOf(armPlan, z - 6.4, 4, P, 4, 0.7), { tone: "mid" }) +
      S(k.slabOf(saddlePlan, z - 8.6, 4.0, P, 3, 0.6), { tone: "mid" }) +
      D([at(P, [x - 2, LAY.postY + 6.2, z - 4.4]), at(P, [x + 2, LAY.postY + 6.2, z - 4.4])], { size: 0.45 });
    put(
      "stand.post",
      [x, LAY.postY, z],
      svg,
      [
        R.solid(A.slab(basePlan, 0, 4, { name: "stand.post.base" })),
        R.solid(A.cylinder(x, LAY.postY, 5.4, 4, z - 20, { name: "stand.post.column" })),
        R.solid(A.cylinder(x, LAY.postY, 7.0, z - 16, 6, { name: "stand.post.collar" })),
        R.solid(A.cylinder(x, LAY.postY, 5.4, z - 10, 3.6, { name: "stand.post.head" })),
        R.solid(A.slab(armPlan, z - 6.4, 4, { name: "stand.post.arm" })),
        R.solid(A.slab(saddlePlan, z - 8.6, 4.0, { name: "stand.post.saddle" })),
      ],
      { bias: 0.2 },
    );
  }
  // 横拉杆分成两段，落在立柱之间而不是穿过柱子；斜撑贴在柱面外侧
  for (let i = 0; i < LAY.posts.length - 1; i++) {
    const from = LAY.posts[i] + 5.5;
    const to = LAY.posts[i + 1] - 5.5;
    const plan = { x: from, y: LAY.postY - 2.4, w: to - from, d: 4.8, r: 1.4 };
    put("stand.tie", [(from + to) / 2, LAY.postY, LAY.tie], S(k.slabOf(plan, LAY.tie, 4.4, P, 4, 0.6), { tone: "mid" }), [R.solid(A.slab(plan, LAY.tie, 4.4, { name: "stand.tie" }))], { bias: 0.15 });
  }
  for (const x of LAY.posts) {
    const z = railZAtX(x);
    const leg = { x: x - 2.2, y: LAY.postY + 5.5, w: 4.4, d: 3.4, r: 1 };
    put("stand.brace", [x, LAY.postY + 6, z * 0.4], S(k.slabOf(leg, z * 0.42, 3.4, P, 3, 0.5), { tone: "mid" }) + D([at(P, [x, LAY.postY + 8.9, z * 0.42 + 3.4])], { size: 0.45 }), [R.solid(A.slab(leg, z * 0.42, 3.4, { name: "stand.brace" }))], { bias: 0.1 });
  }

  // --------------------------------------------------------------------------
  // 3. 地球与月球
  // --------------------------------------------------------------------------
  const earth = LAY.earth;
  const earthContact = earth.z - Math.sqrt(earth.r * earth.r - 81);
  put(
    "earth.column",
    [earth.x, earth.y, 0],
    S(k.cylinder(earth.x, earth.y, 11, 0, 3, P, 32), { tone: "mid" }) +
      S(k.cylinder(earth.x, earth.y, 6, 3, earthContact - 3, P, 28), { tone: "mid", crease: "none" }) +
      L(k.sideArc(earth.x, earth.y, 6, earthContact * 0.5, P, 20), { tone: "faint" }) +
      S(k.cylinder(earth.x, earth.y, 9, earthContact - 4.5, 4.5, P, 32), { tone: "mid" }),
    [R.solid(A.cylinder(earth.x, earth.y, 11, 0, 3, { name: "earth.base", owner: "earth" })), R.solid(A.cylinder(earth.x, earth.y, 6, 3, earthContact - 3, { name: "earth.column", owner: "earth" })), R.solid(A.cylinder(earth.x, earth.y, 9, earthContact - 4.5, 4.5, { name: "earth.collar", owner: "earth" }))],
    { bias: 0.1 },
  );
  const earthF = G.frameAlong([earth.x, earth.y, earth.z], [0, 0, 1]);
  put(
    "earth.globe",
    [earth.x, earth.y, earth.z],
    S(G.sphereOf([earth.x, earth.y, earth.z], earth.r, P, { steps: 56 }), { tone: "hi" }) +
      L([-0.34, -0.2, 0, 0.2, 0.34].map((f) => G.arcOf(earthF, earth.r * f, earth.r * Math.sqrt(1 - f * f), P, { slope: -f / Math.sqrt(1 - f * f), trim: 0 })).join(""), { tone: "faint" }) +
      D([at(P, [earth.x, earth.y + earth.r + 0.9, earth.z])], { size: 0.5, tone: "hi" }),
    [R.solid(A.ball([earth.x, earth.y, earth.z], earth.r, { name: "earth.globe", owner: "earth" }))],
    { bias: 0.2, piece: "earth" },
  );
  // 赤道铜环省略：环内表面与球面是零间隙的相切，深度求解会判成交锁

  const moon = LAY.moon;
  const moonContact = moon.z - Math.sqrt(moon.r * moon.r - 81);
  put(
    "moon.column",
    [moon.x, moon.y, 0],
    S(k.cylinder(moon.x, moon.y, 10, 0, 3, P, 32), { tone: "mid" }) +
      S(k.cylinder(moon.x, moon.y, 5.5, 3, moonContact - 3, P, 28), { tone: "mid", crease: "none" }) +
      L(k.sideArc(moon.x, moon.y, 5.5, moonContact * 0.45, P, 20), { tone: "faint" }) +
      L(k.sideArc(moon.x, moon.y, 5.5, moonContact * 0.78, P, 20), { tone: "faint" }) +
      S(k.cylinder(moon.x, moon.y, 8, moonContact - 4.5, 4.5, P, 32), { tone: "mid" }),
    [R.solid(A.cylinder(moon.x, moon.y, 10, 0, 3, { name: "moon.base", owner: "moon" })), R.solid(A.cylinder(moon.x, moon.y, 5.5, 3, moonContact - 3, { name: "moon.column", owner: "moon" })), R.solid(A.cylinder(moon.x, moon.y, 8, moonContact - 4.5, 4.5, { name: "moon.collar", owner: "moon" }))],
    { bias: 0.1 },
  );
  put("moon.globe", [moon.x, moon.y, moon.z], S(G.sphereOf([moon.x, moon.y, moon.z], moon.r, P, { steps: 52 }), { tone: "hi" }), [R.solid(A.ball([moon.x, moon.y, moon.z], moon.r, { name: "moon.globe", owner: "moon" }))], { bias: 0.2, piece: "moon" });
  const craters = [
    [0.34, 0.55, 2.6],
    [-0.5, 0.3, 3.0],
    [0.1, -0.62, 2.2],
    [0.66, -0.2, 1.8],
    [-0.32, -0.46, 2.4],
  ];
  craters.forEach(([u, v, r]) => {
    const normal = G.unit3([u, v, Math.sqrt(Math.max(0.08, 1 - u * u - v * v))]);
    const centre = G.add3([moon.x, moon.y, moon.z], G.mul3(normal, Math.sqrt(moon.r * moon.r - r * r)));
    const F = G.frameAlong(centre, normal);
    put(
      "moon.crater",
      centre,
      S(G.disc(0, 0.7, r, F, P, { steps: 24 }), { tone: "lo" }) + L(G.circleOf(F, 0.7, r, P, 24), { tone: "faint" }),
      [R.solid(A.disc(F, 0, 0.7, r, { name: "moon.crater", owner: "moon", seated: true }))],
      { bias: 0.25, piece: "moon" },
    );
  });
  const site = G.add3([moon.x, moon.y, moon.z], G.mul3(G.unit3([0, 0.05, 1]), moon.r));
  put(
    "moon.site",
    site,
    S(k.cylinder(site[0], site[1], 3.4, site[2] - 0.4, 0.8, P, 24), { tone: "lo" }) +
      S(k.cylinder(site[0] + 2.4, site[1] + 2.4, 0.4, site[2], 6, P, 12), { tone: "lo", crease: "none" }) +
      S(k.slabOf({ x: site[0] + 2.4, y: site[1] + 2.4, w: 4.4, d: 0.5, r: 0.2 }, site[2] + 4.4, 2.2, P, 2), { tone: "mid" }),
    [R.solid(A.cylinder(site[0], site[1], 3.4, site[2] - 0.4, 0.8, { name: "moon.pad", owner: "moon", seated: true })), R.solid(A.cylinder(site[0] + 2.4, site[1] + 2.4, 0.4, site[2], 6, { name: "moon.mast" })), R.solid(A.slab({ x: site[0] + 2.4, y: site[1] + 2.4, w: 4.4, d: 0.5, r: 0.2 }, site[2] + 4.4, 2.2, { name: "moon.flag" }))],
    { bias: 0.35, piece: "moon" },
  );

  // --------------------------------------------------------------------------
  // 4. 溅落水箱（远侧壁与水面在后层，近侧壁与压条在前层）
  // --------------------------------------------------------------------------
  const tank = LAY.tank;
  const panel = (side) => {
    if (side === "far") return { x: tank.x + 4.2, y: tank.y + 3, w: tank.w - 8.4, d: 1.2, r: 0.3 };
    if (side === "left") return { x: tank.x + 3, y: tank.y + 3, w: 1.2, d: tank.d - 6, r: 0.3 };
    if (side === "near") return { x: tank.x + 4.2, y: tank.y + tank.d - 4.2, w: tank.w - 8.4, d: 1.2, r: 0.3 };
    return { x: tank.x + tank.w - 4.2, y: tank.y + 3, w: 1.2, d: tank.d - 6, r: 0.3 };
  };
  put(
    "tank.floor",
    [tank.x + tank.w / 2, tank.y + tank.d / 2, 3],
    S(k.slabOf(tank, 0, 3, P, 4, 0.6), { tone: "mid" }) + S(k.slabOf(k.insetPlan(tank, 1.4), 3, 0.5, P, 4), { tone: "lo", crease: "none" }),
    [R.solid(A.slab(tank, 0, 3, { name: "tank.floor" }))],
    { bias: -0.1, piece: "tank" },
  );
  // 箱体合成一个绘制项：角柱与玻璃板在屏幕上互为前后（柱子在外、板在内），
  // 拆成两项就没有任何一个深度键能同时排对，合并后由项内顺序决定
  // 水面也是箱体的一部分：玻璃板围住水面，拆开就会互为前后
  const tankFrameSvg = k.corners(tank, 0).map(([x, y]) => S(k.cylinder(x, y, 1.8, 3, LAY.tankH - 3, P, 20), { tone: "mid" })).join("") +
    ["far", "left", "near", "right"].map((side) => {
      const plan = panel(side);
      return S(k.slabOf(plan, 3, 21.4, P, 3, 0.5), { tone: "lo", className: "glass" });
    }).join("") +
    S(k.slabOf(k.insetPlan(tank, 4.2), LAY.water - 0.6, 0.6, P, 4), { tone: "lo", flat: true, className: "water" });
  const tankFrameShapes = [
    ...k.corners(tank, 0).map(([x, y]) => R.solid(A.cylinder(x, y, 1.8, 3, LAY.tankH - 3, { name: "tank.post", owner: "tank" }))),
    ...["far", "left", "near", "right"].map((side) => R.solid(A.slab(panel(side), 3, 21.4, { name: `tank.glass.${side}`, owner: "tank" }))),
    R.solid(A.slab(k.insetPlan(tank, 4.2), LAY.water - 0.6, 0.6, { name: "tank.water", owner: "tank" })),
  ];
  put("tank.frame", [tank.x + tank.w / 2, tank.y + tank.d / 2, 14], tankFrameSvg, tankFrameShapes, { bias: 0.2, piece: "tank" });
  put(
    "tank.valve",
    [tank.x + 7, tank.y + 7, 5],
    S(k.cylinder(tank.x + 7, tank.y + 7, 1.6, 3, 5, P, 20), { tone: "mid" }) + S(k.cylinder(tank.x + 7, tank.y + 5.4, 1.2, 5, 4, P, 16), { tone: "mid" }) + L(k.knurl(tank.x + 7, tank.y + 5.4, 1.2, 5, 9, 12, P), { tone: "lo" }),
    [R.solid(A.cylinder(tank.x + 7, tank.y + 7, 1.6, 3, 5, { name: "tank.valve.body", owner: "tank" })), R.solid(A.cylinder(tank.x + 7, tank.y + 5.4, 1.2, 5, 4, { name: "tank.valve.stem", owner: "tank" }))],
    { bias: 0.3, piece: "tank" },
  );

  // --------------------------------------------------------------------------
  // 5. 发射台与塔架
  // --------------------------------------------------------------------------
  // 发射台台面高度由悬挂几何反推：一级发动机底部正好落在台面上
  const pad = LAY.pad;
  const padH = STAGE_TOP.sic.bottom;
  const padInner =
    L(k.planOutline(k.insetPlan(pad, 3), padH, P, 4), { tone: "faint" }) +
    L(k.planOutline({ x: pad.x + 4, y: pad.y + pad.d / 2 - 3, w: pad.w - 8, d: 6, r: 1 }, padH, P, 3), { tone: "faint" });
  put("pad.base", [pad.x + pad.w / 2, pad.y + pad.d / 2, padH], S(k.slabOf(pad, 0, padH, P, 5, 1.0), { tone: "mid", inner: padInner }), [R.solid(A.slab(pad, 0, padH, { name: "pad.base" }))], { bias: 0.2, piece: "pad" });
  for (const [cx, cy] of k.corners(pad, 4.5)) {
    put("pad.clamp", [cx, cy, padH + 2], S(k.slabOf({ x: cx - 1.6, y: cy - 1.6, w: 3.2, d: 3.2, r: 0.6 }, padH, 4, P, 3, 0.5), { tone: "hi", crease: "lo" }) + D([at(P, [cx, cy, padH + 4])], { size: 0.5 }), [R.solid(A.slab({ x: cx - 1.6, y: cy - 1.6, w: 3.2, d: 3.2, r: 0.6 }, padH, 4, { name: "pad.clamp", owner: "pad" }))], { bias: 0.3, piece: "pad" });
  }
  const tower = LAY.tower;
  const towerLegs = k.corners({ x: tower.x - 5.5, y: tower.y - 5.5, w: 11, d: 11, r: 0.6 }, 0.6);
  const towerSvg = [
    ...towerLegs.map(([x, y]) => S(k.slabOf({ x: x - 0.8, y: y - 0.8, w: 1.6, d: 1.6, r: 0.3 }, 0, LAY.towerH, P, 3, 0.4), { tone: "mid" })),
    ...[18, 34, 50, 66].flatMap((z) => [
      S(k.slabOf({ x: tower.x - 5.8, y: tower.y - 0.6, w: 11.6, d: 1.2, r: 0.3 }, z, 1.2, P, 2), { tone: "mid" }),
      S(k.slabOf({ x: tower.x - 0.6, y: tower.y - 5.8, w: 1.2, d: 11.6, r: 0.3 }, z, 1.2, P, 2), { tone: "mid" }),
    ]),
    ...[22, 42, 62].map((z) => S(k.slabOf({ x: tower.x - 7, y: tower.y - 7, w: 14, d: 14, r: 1.2 }, z, 0.9, P, 4, 0.5), { tone: "mid" })),
    S(k.slabOf({ x: tower.x - 5.5, y: tower.y - 5.5, w: 11, d: 11, r: 0.8 }, LAY.towerH, 1.4, P, 4, 0.5), { tone: "mid" }),
    S(k.slabOf({ x: tower.x - 1.2, y: tower.y - 1.2, w: 2.4, d: 2.4, r: 0.5 }, LAY.towerH + 1.4, 12, P, 3, 0.4), { tone: "mid" }),
    S(k.slabOf({ x: tower.x - 5.5, y: tower.y - 1.0, w: 11, d: 2.0, r: 0.5 }, LAY.towerH + 10, 1.4, P, 3, 0.4), { tone: "mid" }),
    D(towerLegs.map(([x, y]) => at(P, [x, y, 3])), { size: 0.45 }),
  ].join("");
  put(
    "tower.frame",
    [tower.x, tower.y, LAY.towerH / 2],
    towerSvg,
    [
      ...towerLegs.map(([x, y]) => R.solid(A.slab({ x: x - 0.8, y: y - 0.8, w: 1.6, d: 1.6, r: 0.3 }, 0, LAY.towerH, { name: "tower.leg", owner: "tower" }))),
      ...[22, 42, 62].map((z) => R.solid(A.slab({ x: tower.x - 7, y: tower.y - 7, w: 14, d: 14, r: 1.2 }, z, 0.9, { name: "tower.deck", owner: "tower" }))),
      R.solid(A.slab({ x: tower.x - 5.5, y: tower.y - 5.5, w: 11, d: 11, r: 0.8 }, LAY.towerH, 1.4, { name: "tower.cap", owner: "tower" })),
      R.solid(A.slab({ x: tower.x - 1.2, y: tower.y - 1.2, w: 2.4, d: 2.4, r: 0.5 }, LAY.towerH + 1.4, 12, { name: "tower.mast", owner: "tower" })),
      R.solid(A.slab({ x: tower.x - 5.5, y: tower.y - 1.0, w: 11, d: 2.0, r: 0.5 }, LAY.towerH + 10, 1.4, { name: "tower.jib", owner: "tower" })),
    ],
    { bias: 0.4, piece: "tower" },
  );

  // --------------------------------------------------------------------------
  // 6. 相位表盘
  // --------------------------------------------------------------------------
  const dial = LAY.dial;
  const dialTop = dial.h;
  const dialTicks = k.radialTicks(dial.x, dial.y, dial.r - 2.2, 48, 6, dialTop, [1.4, 3.0], P);
  const dialIndex = k.radialTicks(dial.x, dial.y, dial.r, 8, 1, dialTop, [3.2, 5.4], P, 0);
  const dialInner =
    L(k.knurl(dial.x, dial.y, dial.r, dialTop - 3.4, dialTop, 84, P, 0.3), { tone: "lo" }) +
    L(k.sideArc(dial.x, dial.y, dial.r, dialTop - 3.4, P, 40), { tone: "faint" }) +
    L(k.ring(dial.x, dial.y, dial.r - 2.2, dialTop, P, 64), { tone: "lo" }) +
    L(dialTicks.minor, { tone: "lo" }) + L(dialTicks.major, { tone: "mid" }) +
    L(dialIndex.major, { tone: "hi" }) +
    L(k.ring(dial.x, dial.y, 2.0, dialTop, P, 20), { tone: "mid" });
  const needleD = k.lineOnTop([dial.x, dial.y + 3.6], [dial.x, dial.y - (dial.r - 5)], dialTop + 0.25, P);
  put(
    "dial.body",
    [dial.x, dial.y, dialTop],
    S(k.cylinder(dial.x, dial.y, dial.r, 0, dial.h, P, 72, 0.8), { tone: "hi", crease: "lo", inner: dialInner }) + L(needleD, { tone: "lit", className: "needle" }),
    [R.solid(A.cylinder(dial.x, dial.y, dial.r, 0, dial.h, { name: "dial.body" }))],
    { bias: 0.6, piece: "dial" },
  );

  // --------------------------------------------------------------------------
  // 7. 任务钟（朝上的凹窗，显示 T+195:18:35）
  // --------------------------------------------------------------------------
  const counter = LAY.counter;
  const counterTop = 16;
  const windowPlan = { x: counter.x + 6, y: counter.y + 8, w: counter.w - 12, d: 22, r: 2 };
  const digits = [];
  const step = (windowPlan.w - 6) / MET_CHARS;
  for (let i = 0; i < MET_CHARS; i++) {
    const transform = k.topMatrix([windowPlan.x + 3 + step * (i + 0.5), windowPlan.y + windowPlan.d / 2], counterTop - 2.2, P, "x");
    digits.push(`<g transform="${transform}"><text class="iso-text met-digit" data-digit="${i}" text-anchor="middle" dominant-baseline="central" style="font-size:5.4px">0</text></g>`);
  }
  const counterSvg =
    S(k.slabOf(counter, 0, 16, P, 5, 1.0), { tone: "mid", inner: L(k.sideSeam(counter, 14.6, P, 5), { tone: "faint" }) }) +
    S(k.slabOf(k.insetPlan(windowPlan, -1.6), counterTop, 1.2, P, 4), { tone: "lo", crease: "none" }) +
    S(k.slabOf(windowPlan, counterTop - 2.4, 2.4, P, 4), { tone: "lo", flat: true, className: "screen-bed" }) +
    L(k.planOutline(windowPlan, counterTop, P, 4), { tone: "mid" }) +
    L(k.planOutline(k.insetPlan(windowPlan, 1.6), counterTop, P, 4), { tone: "faint" }) +
    D([at(P, [counter.x + 4, counter.y + 4, counterTop]), at(P, [counter.x + counter.w - 4, counter.y + 4, counterTop]), at(P, [counter.x + 4, counter.y + counter.d - 4, counterTop]), at(P, [counter.x + counter.w - 4, counter.y + counter.d - 4, counterTop])], { size: 0.45 }) +
    S(k.slabOf({ x: counter.x - 2, y: counter.y - 1, w: 6, d: 4, r: 1 }, counterTop - 6, 4, P, 3, 0.5), { tone: "mid" }) +
    S(k.cylinder(counter.x + 1, counter.y + 1, 1.1, counterTop - 10, 4, P, 16), { tone: "mid" }) +
    digits.join("");
  put(
    "counter.body",
    [counter.x + counter.w / 2, counter.y + counter.d / 2, counterTop],
    counterSvg,
    [R.solid(A.slab(counter, 0, 16, { name: "counter.body", owner: "counter" })), R.solid(A.slab(windowPlan, counterTop - 2.4, 2.4, { name: "counter.bed", owner: "counter" })), R.solid(A.slab({ x: counter.x - 2, y: counter.y - 1, w: 6, d: 4, r: 1 }, counterTop - 6, 4, { name: "counter.gland", owner: "counter" })), R.solid(A.cylinder(counter.x + 1, counter.y + 1, 1.1, counterTop - 10, 4, { name: "counter.neck", owner: "counter" }))],
    { bias: 0.6, piece: "counter" },
  );

  // --------------------------------------------------------------------------
  // 8. 九面事件旗（每面旗代表一个真实事件，走到就升起）
  // --------------------------------------------------------------------------
  const flagY = LAY.flags.y;
  const flagStep = (LAY.flags.to - LAY.flags.from) / (EVENTS.length - 1);
  EVENTS.forEach((event, index) => {
    const x = LAY.flags.from + flagStep * index;
    const basePlan = { x: x - 4, y: flagY - 4, w: 8, d: 8, r: 1.2 };
    put(
      "flag.base",
      [x, flagY, 1],
      S(k.slabOf(basePlan, 0, 1.2, P, 3, 0.4), { tone: "mid" }) + D([at(P, [x - 2.4, flagY + 2.4, 1.2]), at(P, [x + 2.4, flagY + 2.4, 1.2])], { size: 0.4 }),
      [R.solid(A.slab(basePlan, 0, 1.2, { name: "flag.base" }))],
      { bias: 0.25 },
    );
    const mast =
      S(k.cylinder(x, flagY, 1.1, 1.2, 10, P, 16), { tone: "mid", crease: "none" }) +
      S(k.cylinder(x, flagY, 1.7, 11.2, 1.0, P, 16), { tone: "mid" }) +
      S(k.slabOf({ x: x + 0.4, y: flagY - 0.4, w: 6.6, d: 0.8, r: 0.2 }, 6.2, 4.6, P, 2), { tone: "hi", crease: "lo" }) +
      D([at(P, [x + 3.4, flagY, 10.6])], { size: 0.5 });
    put(
      "flag.mast",
      [x, flagY, 6],
      mast,
      [R.solid(A.cylinder(x, flagY, 1.1, 1.2, 10, { name: "flag.mast", owner: "flag" })), R.solid(A.cylinder(x, flagY, 1.7, 11.2, 1.0, { name: "flag.cap", owner: "flag" })), R.solid(A.slab({ x: x + 0.4, y: flagY - 0.4, w: 6.6, d: 0.8, r: 0.2 }, 6.2, 4.6, { name: "flag.plate", owner: "flag" }))],
      { bias: 0.3, piece: "flag", part: `flag-${index}`, layer: "front" },
    );
  });

  // --------------------------------------------------------------------------
  // 9. 电缆：从任务钟的填料函沿底座后缘走到接线座
  // --------------------------------------------------------------------------
  // 电缆两端都落在接线座的 +x 平面上：端面圆环与平面共面，端子检查才算"落在座上"
  const cableRoute = G.fillet(
    [
      [counter.x + 4, counter.y + 1, counterTop - 4],
      [counter.x + 9, counter.y + 1, counterTop - 4],
      [counter.x + 9, -44, 3],
      [-50, -44, 3],
    ],
    3,
    6,
  );
  const blockPlan = { x: -62, y: -48, w: 12, d: 8, r: 1.4 };
  put(
    "stand.terminal",
    [-56, -44, 3],
    S(k.slabOf(blockPlan, 0, 5, P, 3, 0.6), { tone: "mid" }) + D([at(P, [-58, -45, 5]), at(P, [-54, -45, 5])], { size: 0.45 }) + S(k.cylinder(-56, -44, 1.6, 5, 1.2, P, 16), { tone: "lo" }),
    [R.solid(A.slab(blockPlan, 0, 5, { name: "stand.terminal" })), R.solid(A.cylinder(-56, -44, 1.6, 5, 1.2, { name: "stand.terminal.post" }))],
    { bias: 0.1 },
  );
  const cablePieces = tubePieces(cableRoute, 0.5, P, { maxLength: 18, spacing: 2.2 });
  const cableRuns = R.route("cable.harness", cableRoute, 0.5, { owner: "cable", touch: ["stand.terminal", "counter"], piece: "cable" });
  const cableItems = [
    put(
      "cable.harness",
      cableRoute[Math.floor(cableRoute.length / 2)],
      cablePieces.map((piece) => tubeSvg(piece, { tone: "lo" })).join(""),
      cableRuns,
      { bias: 0.05, piece: "cable" },
    ),
  ];

  return { back, front, shapesOf, maxRailKey, railZAtX, RAIL, halo, dial, dialTop, counterTop, windowPlan, cableItems };
}

// ============================================================================
// IV. 滑架与箭体（运动项，页面按 data-part 移动）
// ============================================================================

/**
 * 滑架与土星五号模型
 *
 * I. 全部按静止态（p = P_REST）建在发射台上，页面只写 transform
 *
 * 1. 滑架：主滚轮压在导轨上，导向滚轮托在导轨下，两片侧板跨在导轨两侧
 *    (1) 远侧板单独成项，深度键必须低于它所在的那段导轨
 *    (2) 其余部件成一项，深度键高于导轨
 * 2. 箭体：吊钩在 (x, 14, 导轨 z − HOOK)，向下依次是逃逸塔、指令舱、
 *    服务舱、登月舱、三级、二级、一级
 *    (1) 每段带 data-stage，分离后由页面切换 display
 *    (2) 登月舱带 data-part="lm"，卷扬机行程由页面写内层 transform
 */
export function buildCarriage(P, R, ctx) {
  const put = (name, atPoint, svg, shapes, opts = {}) => {
    const item = R.put({
      name,
      at: atPoint,
      bias: opts.bias ?? 0,
      piece: opts.piece ?? "trolley",
      svg,
      shapes,
      part: opts.part ?? null,
    });
    (opts.layer === "front" ? ctx.front : ctx.back).push(item);
    return item;
  };

  const [rx, ry, rz] = RAIL_P0;
  const railTop = rz + RAIL_R;
  const railBottom = rz - RAIL_R;
  const plateY = 14;
  const mainRollerR = 3.0;
  const mainZ = railTop + mainRollerR;

  const farPlate = { x: rx - 5.6, y: -5.4, w: 11.2, d: 2.0, r: 0.9 };

  const nearPlate = { x: rx - 5.6, y: 3.4, w: 11.2, d: 2.0, r: 0.9 };
  const axleY = { x: rx - 0.7, y: -6.4, w: 1.4, d: 12.8, r: 0.6 };
  const drumF = G.frameAlong([rx, plateY + 5.4, rz - 15], [1, 0, 0]);
  const trolleySvg =
    S(k.slabOf(farPlate, rz - 9, 15, P, 3, 0.6), { tone: "mid" }) +
    D([at(P, [rx - 3.6, -4.4, rz + 4]), at(P, [rx + 3.6, -4.4, rz + 4])], { size: 0.45 }) +
    S(k.slabOf(nearPlate, rz - 9, 15, P, 3, 0.6), { tone: "mid" }) +
    D([at(P, [rx - 3.6, 4.4, rz + 4]), at(P, [rx + 3.6, 4.4, rz + 4])], { size: 0.45 }) +
    // 主从两只球头：球到导轨轴线的距离与方向无关，滑架因此不必随切向俯仰
    S(G.sphereOf([rx, 0, mainZ], mainRollerR, P, { steps: 40 }), { tone: "hi" }) +
    S(G.ringBand(2.6, 3.4, mainRollerR, mainRollerR + 0.9, G.frameAlong([rx, 0, mainZ], [0, 1, 0]), P, { steps: 32 }), { tone: "mid" }) +
    S(k.slabOf({ x: rx - 5.6, y: -3.4, w: 11.2, d: 6.8, r: 1 }, rz - 10, 2.6, P, 3, 0.5), { tone: "mid" }) +
    S(k.slabOf({ x: rx - 2.9, y: 3.4, w: 5.8, d: 13, r: 1.2 }, rz - 13.6, 3.6, P, 3, 0.5), { tone: "mid" }) +
    S(k.slabOf({ x: rx - 4, y: plateY - 4, w: 8, d: 8, r: 1.2 }, rz - 18, 5, P, 3, 0.6), { tone: "mid" }) +
    S(k.cylinder(rx, plateY, 2.6, rz - 18, 5, P, 24), { tone: "hi", crease: "lo" }) +
    S(G.disc(-5.2, 5.2, 3.2, drumF, P, { steps: 24 }), { tone: "hi" }) +
    S(G.ringBand(-6.1, -5.2, 1.4, 4.2, drumF, P, { steps: 24 }), { tone: "mid" }) +
    S(G.ringBand(5.2, 6.1, 1.4, 4.2, drumF, P, { steps: 24 }), { tone: "mid" }) +
    S(k.cylinder(rx + 6.2, plateY + 5.4, 1.2, rz - 15, 6, P, 16), { tone: "mid" }) +
    D([at(P, [rx - 3.6, 4.4, rz - 11]), at(P, [rx + 3.6, 4.4, rz - 11])], { size: 0.45 });
  put(
    "trolley.near",
    [rx, 2.4, rz - 2],
    trolleySvg,
    [
      R.solid(A.slab(farPlate, rz - 9, 15, { name: "trolley.plate.far", owner: "trolley" })),
      R.solid(A.slab(nearPlate, rz - 9, 15, { name: "trolley.plate.near", owner: "trolley" })),
      R.solid(A.ball([rx, 0, mainZ], mainRollerR, { name: "trolley.roller.main", owner: "rail.tube" })),
      R.solid(A.ring(G.frameAlong([rx, 0, mainZ], [0, 1, 0]), 2.6, 3.4, mainRollerR, mainRollerR + 0.9, { name: "trolley.socket.main", owner: "trolley" })),
      R.solid(A.slab({ x: rx - 5.6, y: -3.4, w: 11.2, d: 6.8, r: 1 }, rz - 10, 2.6, { name: "trolley.beam", owner: "rail.tube" })),
      R.solid(A.slab({ x: rx - 2.9, y: 3.4, w: 5.8, d: 13, r: 1.2 }, rz - 13.6, 3.6, { name: "trolley.arm", owner: "trolley" })),
      R.solid(A.slab({ x: rx - 1.7, y: -1.7, w: 3.4, d: 3.4, r: 0.5 }, rz - 7.4, 3.4, { name: "trolley.shoe", owner: "rail.tube" })),
      R.solid(A.slab({ x: rx - 4, y: plateY - 4, w: 8, d: 8, r: 1.2 }, rz - 18, 5, { name: "trolley.block", owner: "trolley" })),
      R.solid(A.cylinder(rx, plateY, 2.6, rz - 18, 5, { name: "trolley.hook", owner: "trolley" })),
      R.solid(A.disc(drumF, -5.2, 5.2, 3.2, { name: "trolley.drum", owner: "trolley" })),
      R.solid(A.ring(drumF, -6.1, -5.2, 1.4, 4.2, { name: "trolley.flange.a", owner: "trolley" })),
      R.solid(A.ring(drumF, 5.2, 6.1, 1.4, 4.2, { name: "trolley.flange.b", owner: "trolley" })),
      R.solid(A.cylinder(rx + 6.2, plateY + 5.4, 1.2, rz - 15, 6, { name: "trolley.wheel", owner: "trolley" })),
    ],
    { bias: 0.6, piece: "trolley", part: "trolley", layer: "front" },
  );

  // --- 箭体 ---
  const stack = STAGE_TOP;
  const R0 = rx;
  const Y = plateY;
  const owner = { owner: "stack" };
  const stageSvg = {};
  const stageShapes = {};

  const les = analytic(stack.les.bottom, stack.les.top, (s) => {
    const t = (s - stack.les.bottom) / (stack.les.top - stack.les.bottom);
    return stack.les.r * (1.0 - 0.42 * t * t);
  }, (s) => {
    const h = stack.les.top - stack.les.bottom;
    return (-2 * stack.les.r * 0.42 * (s - stack.les.bottom)) / (h * h);
  });
  // 注意：车削剖面的 s 是从 frame.o 沿 frame.a 量的，所以用绝对高度做剖面时，
  // 坐标原点必须落在 z = 0，否则整件会被抬高两倍偏移
  const upAt = (x, y) => G.frameAlong([x, y, 0], [0, 0, 1]);
  stageSvg.les =
    S(G.solidOf(les.profile, upAt(R0, Y), P, { smooth: { slope: les.slope }, steps: 28 }), { tone: "hi" }) +
    S(k.cylinder(R0, Y, stack.les.r * 0.44, stack.les.top - 1.4, 1.4, P, 16), { tone: "hi" });
  stageShapes.les = [R.solid(A.solid(upAt(R0, Y), les.profile, { name: "les.tower", radius: les.radius, ...owner })), R.solid(A.cylinder(R0, Y, stack.les.r * 0.44, stack.les.top - 1.4, 1.4, { name: "les.tip", ...owner }))];

  const cmCone = [
    [0, stack.cm.r],
    [4.6, stack.cm.r * 0.44],
  ];
  stageSvg.cm =
    S(G.solidOf(cmCone, G.frameAlong([R0, Y, stack.cm.bottom], [0, 0, 1]), P, { smooth: false, steps: 40 }), { tone: "hi" }) +
    S(G.sphereOf([R0, Y, stack.cm.bottom + 4.6], stack.cm.r * 0.44, P, { steps: 32 }), { tone: "hi" }) +
    L(G.arcOf(G.frameAlong([R0, Y, stack.cm.bottom], [0, 0, 1]), 1.2, stack.cm.r * 0.95, P), { tone: "faint" }) +
    D([at(P, [R0 + stack.cm.r * 0.83, Y - stack.cm.r * 0.58, stack.cm.bottom + 2.0])], { size: 0.5 });
  stageShapes.cm = [R.solid(A.solid(G.frameAlong([R0, Y, stack.cm.bottom], [0, 0, 1]), cmCone, { name: "cm.cone", ...owner })), R.solid(A.ball([R0, Y, stack.cm.bottom + 4.6], stack.cm.r * 0.44, { name: "cm.cap", ...owner }))];

  const smF = G.frameAlong([R0, Y, stack.sm.bottom], [0, 0, 1]);
  const smBell = analytic(stack.sm.bottom - 3.4, stack.sm.bottom, (s) => stack.sm.r * (0.16 + 0.34 * ((stack.sm.bottom - s) / 3.4)), () => -stack.sm.r * 0.1);
  // 服务舱四片辐射散热板：贴在舱壁外侧，不能四片重叠在同一处
  const smRadial = [0, 1, 2, 3].map((i) => {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    return G.frameOf([R0 + ux * (stack.sm.r - 0.3), Y + uy * (stack.sm.r - 0.3), stack.sm.bottom + 1.2], [ux, uy, 0], [0, 0, 1], [-uy, ux, 0]);
  });
  stageSvg.sm =
    S(k.cylinder(R0, Y, stack.sm.r, stack.sm.bottom, stack.sm.h, P, 40), { tone: "hi" }) +
    L([1.2, 3.0, 4.8].map((d) => G.arcOf(smF, d, stack.sm.r, P)).join(""), { tone: "faint" }) +
    L([[R0 + stack.sm.r * 0.62, Y - stack.sm.r * 0.78], [R0 - stack.sm.r * 0.78, Y + stack.sm.r * 0.62]].map(([px, py]) => `M${at(P, [px, py, stack.sm.bottom + 0.8]).join(" ")}L${at(P, [px, py, stack.sm.bottom + stack.sm.h - 0.8]).join(" ")}`).join(""), { tone: "faint" }) +
    smRadial.map((F) => S(G.prismOf(F, [[0.4, -1.5], [3.6, -1.1], [3.6, 1.1], [0.4, 1.5]], 0, 0.45, P), { tone: "mid" })).join("") +
    S(G.solidOf(smBell.profile, upAt(R0, Y), P, { smooth: { slope: smBell.slope }, steps: 32 }), { tone: "mid" });
  stageShapes.sm = [
    R.solid(A.cylinder(R0, Y, stack.sm.r, stack.sm.bottom, stack.sm.h, { name: "sm.body", ...owner })),
    ...smRadial.map((F, i) => R.solid(A.prism(F, [[0.4, -1.5], [3.6, -1.1], [3.6, 1.1], [0.4, 1.5]], 0, 0.45, { name: `sm.radiator${i}`, ...owner }))),
    R.solid(A.solid(upAt(R0, Y), smBell.profile, { name: "sm.bell", radius: smBell.radius, ...owner })),
  ];

  const lmTop = stack.lm.top;
  const lmBottom = stack.lm.bottom;
  const descentBottom = lmBottom + 1.4;
  const descentTop = descentBottom + 3.8;
  const octagon = (cx, cy, r, phase = Math.PI / 8) => Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2 + phase;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
  const descentR = stack.lm.r * 1.15;
  const ascentR = stack.lm.r * 0.86;
  // 四条腿从下降级八边形的四个顶点斜撑到月面，脚垫是明确的圆盘
  const legGeom = [0, 1, 2, 3].map((i) => {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const from = [R0 + ux * descentR * 0.92, Y + uy * descentR * 0.92, descentBottom + 0.5];
    const to = [R0 + ux * (descentR * 1.52), Y + uy * (descentR * 1.52), lmBottom + 0.6];
    return { from, to, mid: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2], dir: G.unit3(G.sub3(to, from)) };
  });
  const legLen = legGeom.map(({ from, to }) => Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]));
  const lmSvg =
    S(k.extrude(octagon(R0, Y, descentR), descentBottom, 3.8, P, { convex: true, bevel: 0.5 }), { tone: "hi" }) +
    L(octagon(R0, Y, descentR).map(([px, py]) => `M${at(P, [px, py, descentBottom + 3.8]).join(" ")}`).join(""), { tone: "faint" }) +
    S(k.extrude(octagon(R0, Y, ascentR, Math.PI / 8 + 0.39), descentTop, lmTop - descentTop, P, { convex: true, bevel: 0.4 }), { tone: "hi" }) +
    S(k.slabOf({ x: R0 - ascentR * 0.62, y: Y - ascentR * 0.62, w: ascentR * 1.24, d: ascentR * 1.24, r: 0.5 }, lmTop - 0.7, 0.7, P, 3, 0.35), { tone: "mid" }) +
    D([at(P, [R0 - 1.3, Y - 1.7, lmTop - 2.6]), at(P, [R0 + 1.3, Y - 1.7, lmTop - 2.6])], { size: 0.5, tone: "lo" }) +
    legGeom.map(({ mid, dir }, i) => S(G.prismOf(G.frameAlong(mid, dir), [[-0.45, -0.45], [0.45, -0.45], [0.45, 0.45], [-0.45, 0.45]], -legLen[i] / 2, legLen[i] / 2, P), { tone: "mid" }) + S(k.cylinder(legGeom[i].to[0], legGeom[i].to[1], 1.9, lmBottom, 0.8, P, 20), { tone: "mid" })).join("") +
    S(G.solidOf([[0, 0.55], [1.4, 1.15]], G.frameAlong([R0, Y, descentBottom], [0, 0, -1]), P, { smooth: false, steps: 26 }), { tone: "mid" }) +
    S(k.cylinder(R0 + ascentR * 0.78, Y - ascentR * 0.78, 0.35, lmTop + 0.3, 3.0, P, 12), { tone: "mid" }) +
    S(G.disc(0, 0.4, 1.3, G.frameAlong([R0 + ascentR * 0.78, Y - ascentR * 0.78, lmTop + 3.3], [0.5, -0.5, 1]), P, { steps: 20 }), { tone: "mid" });
  stageSvg.lm = `<g data-part="lm">${lmSvg}</g>`;
  stageShapes.lm = [
    R.solid(A.extruded(octagon(R0, Y, descentR), descentBottom, 3.8, { name: "lm.descent", ...owner })),
    R.solid(A.extruded(octagon(R0, Y, ascentR, Math.PI / 8 + 0.39), descentTop, lmTop - descentTop, { name: "lm.ascent", ...owner })),
    R.solid(A.slab({ x: R0 - ascentR * 0.62, y: Y - ascentR * 0.62, w: ascentR * 1.24, d: ascentR * 1.24, r: 0.5 }, lmTop - 0.7, 0.7, { name: "lm.hatch", ...owner })),
    ...legGeom.map(({ mid, dir }, i) => R.solid(A.prism(G.frameAlong(mid, dir), [[-0.45, -0.45], [0.45, -0.45], [0.45, 0.45], [-0.45, 0.45]], -legLen[i] / 2, legLen[i] / 2, { name: `lm.leg${i}`, ...owner }))),
    ...legGeom.map(({ to }, i) => R.solid(A.cylinder(to[0], to[1], 1.9, lmBottom, 0.8, { name: `lm.pad${i}`, ...owner }))),
    R.solid(A.solid(G.frameAlong([R0, Y, descentBottom], [0, 0, -1]), [[0, 0.55], [1.4, 1.15]], { name: "lm.bell", ...owner })),
  ];

  // 三级：尾部裙段做成薄壳环，J-2 发动机吊在环里（二级还在时被挡住，二级抛掉后才露出来）
  const s4bBottom = stack.s4b.bottom;
  const s4bAft = s4bBottom + 1.6;
  const s4bF = upAt(R0, Y);
  stageSvg.s4b =
    S(G.ringBand(s4bBottom, s4bAft, stack.s4b.r - 0.6, stack.s4b.r, s4bF, P, { steps: 44 }), { tone: "mid" }) +
    S(k.cylinder(R0, Y, stack.s4b.r, s4bAft, stack.s4b.h - 1.6, P, 44), { tone: "hi" }) +
    L([1.4, 3.4, 5.4].map((d) => G.arcOf(s4bF, s4bAft + d, stack.s4b.r, P)).join(""), { tone: "faint" }) +
    L([[R0 + stack.s4b.r * 0.66, Y - stack.s4b.r * 0.75]].map(([px, py]) => `M${at(P, [px, py, s4bAft + 0.6]).join(" ")}L${at(P, [px, py, stack.s4b.top - 0.6]).join(" ")}`).join(""), { tone: "faint" }) +
    S(G.solidOf([[s4bBottom - 1.4, 0.5], [s4bAft, 1.25]], s4bF, P, { smooth: false, steps: 30 }), { tone: "mid" }) +
    D([at(P, [R0 + stack.s4b.r * 0.7, Y - stack.s4b.r * 0.7, s4bAft + 0.9])], { size: 0.45 });
  stageShapes.s4b = [
    R.solid(A.ring(s4bF, s4bBottom, s4bAft, stack.s4b.r - 0.6, stack.s4b.r, { name: "s4b.skirt", ...owner })),
    R.solid(A.cylinder(R0, Y, stack.s4b.r, s4bAft, stack.s4b.h - 1.6, { name: "s4b.body", ...owner })),
    R.solid(A.solid(s4bF, [[s4bBottom - 1.4, 0.5], [s4bAft, 1.25]], { name: "s4b.bell", ...owner })),
  ];

  // 二级：级间段同样是薄壳环，读得出"两段接在一起"
  const s2Bottom = stack.s2.bottom;
  const s2Inter = s2Bottom + 2.0;
  const s2F = upAt(R0, Y);
  stageSvg.s2 =
    S(G.ringBand(s2Bottom, s2Inter, stack.s2.r - 0.7, stack.s2.r, s2F, P, { steps: 48 }), { tone: "mid" }) +
    S(k.cylinder(R0, Y, stack.s2.r, s2Inter, stack.s2.h - 2.0, P, 48), { tone: "hi" }) +
    L([2.4, 5.0].map((d) => G.arcOf(s2F, s2Inter + d, stack.s2.r, P)).join(""), { tone: "faint" }) +
    L([[R0 + stack.s2.r * 0.7, Y - stack.s2.r * 0.72], [R0 - stack.s2.r * 0.72, Y + stack.s2.r * 0.7]].map(([px, py]) => `M${at(P, [px, py, s2Inter + 0.8]).join(" ")}L${at(P, [px, py, stack.s2.top - 0.8]).join(" ")}`).join(""), { tone: "faint" }) +
    S(G.solidOf([[s2Inter - 1.2, 0.6], [s2Inter + 0.9, 1.5]], s2F, P, { smooth: false, steps: 30 }), { tone: "mid" });
  stageShapes.s2 = [
    R.solid(A.ring(s2F, s2Bottom, s2Inter, stack.s2.r - 0.7, stack.s2.r, { name: "s2.interstage", ...owner })),
    R.solid(A.cylinder(R0, Y, stack.s2.r, s2Inter, stack.s2.h - 2.0, { name: "s2.body", ...owner })),
    R.solid(A.solid(s2F, [[s2Inter - 1.2, 0.6], [s2Inter + 0.9, 1.5]], { name: "s2.bell", ...owner })),
  ];

  // 一级：裙部是一圈薄壳（发动机舱是开口的），底封头封住箭体，
  // 五台 F-1 吊在舱内、尾翼贴在裙外壁——之前把裙部画成实心圆柱，发动机全埋在里头
  const sicBottom = stack.sic.bottom;
  const sicSkirt = sicBottom + 1.2;
  const sicBase = sicBottom + 5.4;
  const sicF = upAt(R0, Y);
  const finGeom = [0, 1, 2, 3].map((i) => {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    return {
      F: G.frameOf([R0 + ux * (stack.sic.r - 0.15), Y + uy * (stack.sic.r - 0.15), 0], [ux, uy, 0], [0, 0, 1], [-uy, ux, 0]),
      poly: [[sicSkirt + 0.3, -1.05], [sicBottom + 9.4, -0.5], [sicBottom + 9.4, 0.5], [sicSkirt + 0.3, 1.05]],
    };
  });
  const engineGeom = [
    [0, 0, 1.95],
    [stack.sic.r * 0.5, 0, 1.72],
    [-stack.sic.r * 0.5, 0, 1.72],
    [0, stack.sic.r * 0.5, 1.72],
    [0, -stack.sic.r * 0.5, 1.72],
  ].map(([dx, dy, r]) => {
    const bell = analytic(sicBottom, sicBase, (s) => r * (0.42 + 0.58 * ((s - sicBottom) / (sicBase - sicBottom))), () => r * 0.58 / (sicBase - sicBottom));
    return { dx, dy, r, profile: bell.profile, radius: bell.radius, slope: bell.slope };
  });
  stageSvg.sic =
    S(G.ringBand(sicSkirt, sicBase, stack.sic.r - 1.0, stack.sic.r, sicF, P, { steps: 48 }), { tone: "mid" }) +
    S(k.cylinder(R0, Y, stack.sic.r - 1.0, sicBase, 0.9, P, 48), { tone: "mid" }) +
    S(k.cylinder(R0, Y, stack.sic.r, sicBase + 0.9, stack.sic.top - sicBase - 0.9, P, 48), { tone: "hi" }) +
    L([3.0, 7.0, 11.0].map((d) => G.arcOf(sicF, sicBase + 0.9 + d, stack.sic.r, P)).join(""), { tone: "faint" }) +
    L([[R0 + stack.sic.r * 0.68, Y - stack.sic.r * 0.74], [R0 - stack.sic.r * 0.74, Y + stack.sic.r * 0.68]].map(([px, py]) => `M${at(P, [px, py, sicBase + 1.6]).join(" ")}L${at(P, [px, py, stack.sic.top - 1.2]).join(" ")}`).join(""), { tone: "faint" }) +
    finGeom.map(({ F, poly }) => S(G.prismOf(F, poly, 0, 2.6, P), { tone: "mid" })).join("") +
    engineGeom.map(({ dx, dy, profile, slope }) => S(G.solidOf(profile, upAt(R0 + dx, Y + dy), P, { smooth: { slope }, steps: 26 }), { tone: "mid" })).join("");
  stageShapes.sic = [
    R.solid(A.ring(sicF, sicSkirt, sicBase, stack.sic.r - 1.0, stack.sic.r, { name: "sic.skirt", ...owner })),
    R.solid(A.cylinder(R0, Y, stack.sic.r - 1.0, sicBase, 0.9, { name: "sic.base", ...owner })),
    R.solid(A.cylinder(R0, Y, stack.sic.r, sicBase + 0.9, stack.sic.top - sicBase - 0.9, { name: "sic.body", ...owner })),
    ...finGeom.map(({ F, poly }, i) => R.solid(A.prism(F, poly, 0, 2.6, { name: `sic.fin${i}`, ...owner }))),
    ...engineGeom.map(({ dx, dy, profile, radius }, i) => R.solid(A.solid(upAt(R0 + dx, Y + dy), profile, { name: `sic.bell${i}`, radius, ...owner }))),
  ];

  const order = ["les", "cm", "sm", "lm", "s4b", "s2", "sic"];
  const vehicleSvg = order.map((id) => `<g data-stage="${id}">${stageSvg[id]}</g>`).join("");
  const vehicleShapes = order.flatMap((id) => stageShapes[id]);

  put("vehicle.stack", [R0, Y, (stack.les.top + stack.sic.bottom) / 2], vehicleSvg, vehicleShapes, { bias: 0.5, piece: "vehicle", part: "vehicle", layer: "front" });

  const stageBottom = Object.fromEntries(order.map((id) => [id, stack[id].bottom]));
  const stageTop = Object.fromEntries(order.map((id) => [id, stack[id].top]));
  return { railTop, plateY, stageSvg, order, drumF, stageBottom, stageTop };
}
