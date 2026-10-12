/**
 * 月球任务时序仪 · 构建脚本
 *
 * 把 model.mjs 的真值、art.mjs 的几何和 live.mjs 的运动合成一张
 * 独立的 HTML 页面（暗色与亮色各一份），并用 kit/audit.mjs 证明几何。
 *
 * I. 构建流程
 *
 * 1. 用 fitProjection 定相机，把整个包围盒装进 1180 × 738 的 viewBox
 * 2. 建场景与滑架，全部走同一个 recorder，登记每一项的真实形状
 * 3. A.settle 测出每一对重叠项的先后，写出深度键
 * 4. A.auditOrExit 检查间隙、支撑、折叠、抖动、深度次序
 * 5. 按深度键排序后分层输出：后层 SVG → 画布 → 前层 SVG
 *
 * II. 命令行
 *
 * node build.mjs            暗色页面 dist/index.html
 * node build.mjs --light    亮色页面 dist/index-light.html
 * node build.mjs --audit    跑完整审计，任何一项不为零就退出码 1
 *
 * @module build
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-10-12
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./kit/iso-kit.mjs";
import * as A from "./kit/audit.mjs";
import { glCamera } from "./kit/gl.mjs";
import { kitScript, glScript } from "./scripts/inline-kit.mjs";
import { buildScene, buildCarriage, W, H, AZIMUTH, ELEVATION, LAY, RAIL_P0, HOOK, HOIST_TRAVEL, MET_CHARS, PAD_X } from "./src/art.mjs";
import { EVENTS, PHASES, railPoint, railTangent, metLabel } from "./src/model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const light = process.argv.includes("--light");
const theme = light ? "light" : "dark";

// ============================================================================
// I. 相机与场景
// ============================================================================

const BOX = { x: -282, y: -52, w: 564, d: 144, r: 12 };

/**
 * 建一遍场景
 *
 * I. 相机先粗后精
 *
 * 1. 第一遍用包围盒估一个投影，只为量出真实形状的包围盒
 * 2. 之后用真实包围盒重新拟合，让图形居中并占满 55–65% 的卡片
 */
function buildOnce(P, settle) {
  const R = A.recorder(P);
  const scene = buildScene(P, R);
  const ctx = { back: scene.back, front: scene.front };
  const carriage = buildCarriage(P, R, ctx);
  if (settle) {
    A.settle(R, P);
    R.items.sort((a, b) => a.key - b.key);
    // 逐对看过 4× 特写之后仍然保留的两处"包住"关系：
    // 1. 滑架吊架的两片侧板跨在导轨两侧，没有任何单一深度键能同时排对
    // 2. 电缆端面与接线座平面共面（端子检查要求如此），交线附近互为前后
    A.auditOrExit(R, P, {
      allow: [
        ["rail.tube*", "trolley*"],
        ["stand.terminal", "cable.harness"],
      ],
    });
  }
  return { R, scene, carriage };
}

let P = k.fitProjection(k.boxCorners(BOX, -22, 202), W, H, { pad: 26, azimuth: AZIMUTH, elevation: ELEVATION });
for (let pass = 0; pass < 2; pass++) {
  const rough = buildOnce(P, false);
  const points = [];
  for (const shape of rough.R.solids) {
    const bounds = A.boundsOf(shape);
    points.push(bounds.min, bounds.max);
  }
  P = k.fitProjection(points, W, H, { pad: 26, azimuth: AZIMUTH, elevation: ELEVATION });
}

const { R, scene, carriage } = buildOnce(P, true);

// ============================================================================
// II. 分层输出
// ============================================================================

const backSet = new Set(scene.back);
const frontSet = new Set(scene.front);
const emit = (item) => {
  const attrs = [
    `class="it"`,
    `data-name="${item.name}"`,
    `data-k="${item.key.toFixed(3)}"`,
    `data-piece="${item.piece}"`,
    item.part ? `data-part="${item.part}"` : "",
    item.part && (item.part.startsWith("trolley") || item.part === "vehicle") ? `data-move="rail"` : "",
  ].filter(Boolean).join(" ");
  return `<g ${attrs}>${item.svg}</g>`;
};

const backSvg = k.figureSvg({
  width: W,
  height: H,
  className: "lms-back",
  label:
    "月球任务时序仪：一台落地式仪器，导轨被弯成阿波罗 11 号的任务剖面。" +
    "滑架吊着一枚土星五号模型，从左侧发射台出发，沿导轨升空、飞向右侧的月球、把登月舱吊放到月面，再沿更低的返回弧折回，最后溅落在左前方的水箱里。" +
    "台面右侧是相位表盘与任务钟，前沿立着九面事件旗。",
  body: [
    scene.halo,
    ...R.items.filter((item) => backSet.has(item)).map(emit),
  ],
});

const frontSvg = `<svg xmlns="http://www.w3.org/2000/svg" class="iso-svg lms-layer lms-front" viewBox="0 0 ${W} ${H}" aria-hidden="true">${R.items.filter((item) => frontSet.has(item)).map(emit).join("")}</svg>`;

const stage = `<div class="lms-stage" tabindex="0" role="slider" aria-label="月球任务时序仪：左右方向键按事件步进，空格播放或暂停，Home 回到发射，End 跳到溅落" aria-valuemin="0" aria-valuemax="1000" aria-valuenow="0" aria-valuetext="点火升空">${backSvg}<canvas class="lms-layer lms-gl" aria-hidden="true"></canvas>${frontSvg}</div>`;

// ============================================================================
// III. 数据与页面
// ============================================================================

const engineOf = (id) => {
  const table = {
    s1c: { z: carriage.stageBottom.sic, r: 4.4 },
    s2: { z: carriage.stageBottom.s2, r: 3.4 },
    s4b: { z: carriage.stageBottom.s4b, r: 1.9 },
    lmd: { z: carriage.stageBottom.lm, r: 1.8 },
    lma: { z: carriage.stageBottom.lm + 5.4, r: 1.2 },
    sps: { z: carriage.stageBottom.sm - 2.6, r: 1.7 },
  };
  return table[id] ?? { z: carriage.stageBottom.sic, r: 4.4 };
};

const DATA = {
  W,
  H,
  camera: glCamera(P),
  P,
  rest: { p: RAIL_P0.length ? 0.008 : 0, rail: RAIL_P0 },
  padX: PAD_X,
  plateY: 14,
  hook: HOOK,
  hoist: HOIST_TRAVEL,
  metChars: MET_CHARS,
  events: EVENTS,
  phases: PHASES,
  stageBottom: carriage.stageBottom,
  stageTop: carriage.stageTop,
  // 每级箭体的世界中心：分离时绕它自转，绕的是部件自己的中心而不是画面原点
  stageMid: Object.fromEntries(
    ["les", "cm", "sm", "lm", "s4b", "s2", "sic"].map((id) => [id, [PAD_X, 14, (carriage.stageTop[id].top + carriage.stageTop[id].bottom) / 2]]),
  ),
  engines: { s1c: engineOf("s1c"), s2: engineOf("s2"), s4b: engineOf("s4b"), lmd: engineOf("lmd"), lma: engineOf("lma"), sps: engineOf("sps") },
  dial: { x: scene.dial.x, y: scene.dial.y, r: scene.dial.r, top: scene.dialTop },
  flag: { y: LAY.flags.y, from: LAY.flags.from, to: LAY.flags.to },
  light,
  water: LAY.water,
  tank: LAY.tank,
  moon: LAY.moon,
  earth: LAY.earth,
};

const CSS = `
.lms-stage{position:relative;touch-action:pan-y;user-select:none;-webkit-user-select:none}
.lms-stage>svg,.lms-stage>canvas{display:block;width:100%;height:auto}
.lms-stage>.lms-layer{position:absolute;inset:0;height:100% !important;pointer-events:none}
.iso:not([data-theme="light"]) .lms-gl{mix-blend-mode:screen}
.lms-stage:focus-visible{outline:1px solid var(--anatomy-muted);outline-offset:6px}
.lms-stage .glass{opacity:.6}
.lms-stage .water{opacity:.9}
.lms-stage .screen-bed{opacity:.92}
.lms-stage .met-digit{fill:var(--anatomy-hi);font-family:var(--anatomy-mono);letter-spacing:.02em}
.lms-stage .needle{stroke-width:1.2}
.lms-legend{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:10px;color:var(--anatomy-muted);font-family:var(--anatomy-mono);font-size:10.5px}
.lms-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--anatomy-faint)}
.lms-controls button,.lms-controls select{
  appearance:none;border:1px solid var(--anatomy-faint);background:var(--anatomy-face);color:var(--anatomy-text);
  font:inherit;font-size:12px;line-height:1;padding:7px 11px;border-radius:7px;cursor:pointer;
  transition:border-color .16s var(--anatomy-ease),color .16s var(--anatomy-ease);
}
.lms-controls button:hover,.lms-controls select:hover{border-color:var(--anatomy-muted);color:var(--anatomy-strong)}
.lms-controls button:focus-visible,.lms-controls select:focus-visible,.lms-controls input:focus-visible{outline:1px solid var(--anatomy-muted);outline-offset:3px}
.lms-controls button[aria-pressed="true"]{border-color:var(--anatomy-strong);color:var(--anatomy-strong)}
.lms-controls .lms-scrub{flex:1 1 180px;min-width:120px;height:22px;margin:0;accent-color:var(--anatomy-strong);background:transparent;cursor:pointer}
.lms-controls .lms-spacer{flex:1 1 auto}
.lms-controls .lms-label{color:var(--anatomy-muted);font-family:var(--anatomy-mono);font-size:10.5px;letter-spacing:.04em}
`;

const readout = "T+00:00:00 · 点火升空 · 距地 6,371 km · 0.00 km/s";

// 操作入口：播放、进度、跳事件、速度、主题——键盘能做的这里都能点
const controls = `
<div class="lms-controls" role="group" aria-label="任务操作">
  <button type="button" data-act="play" aria-pressed="true" aria-label="播放或暂停巡游">暂停</button>
  <input class="lms-scrub" type="range" min="0" max="1000" value="0" step="1" data-act="scrub" aria-label="任务进度" />
  <span class="lms-label" data-act="percent">0%</span>
  <select data-act="jump" aria-label="跳到事件">
    ${EVENTS.map((event, index) => `<option value="${index}">${event.zh} · ${metLabel(event.met)}</option>`).join("")}
  </select>
  <button type="button" data-act="speed" aria-label="巡游速度">1×</button>
  <button type="button" data-act="theme" aria-label="切换亮色与暗色">${light ? "暗色" : "亮色"}</button>
  <button type="button" data-act="reset" aria-label="回到发射台">回到发射</button>
</div>`;

const body = k.plateHtml({
  fig: "Fig 1",
  title: "月球任务时序仪",
  hint: "拖动或按方向键走完整个任务",
  readout,
  keys: [
    { mark: "lit", label: "受力的那一级：正在点火时尾焰从它的喷口喷出" },
    { mark: "raised", label: "导轨即任务剖面：滑架位置就是任务进度" },
    { mark: "flat", label: "九面事件旗，走到一个升起一个" },
    { mark: "dotted", label: "表针每相位转一圈，任务钟走真实 MET" },
  ],
  caption:
    "阿波罗 11 号的任务剖面被弯成了一根导轨：T+0 从发射台升起，T+2:44:16 地月转移注入，T+75:49:50 进入环月轨道，T+102:45:40 着陆，T+135:23:42 返回点火，T+195:18:35 溅落。整程 8 天 3 小时 18 分 35 秒，往返 384,400 km。",
  body: `<style>${CSS}</style>${stage}${controls}`,
});

const modelSource = readFileSync(join(HERE, "src", "model.mjs"), "utf8").replace(/^export /gm, "");
const liveSource = readFileSync(join(HERE, "src", "live.mjs"), "utf8");
const script = kitScript() + "\n" + glScript() + "\n" + modelSource + "\n" + liveSource.replace("__DATA__", () => JSON.stringify(DATA));

mkdirSync(join(HERE, "dist"), { recursive: true });
const out = join(HERE, "dist", light ? "index-light.html" : "index.html");
writeFileSync(out, k.pageHtml({ title: "月球任务时序仪 · Lunar Mission Sequencer", theme, body, script, width: W + 48 }));
console.log("wrote", out);
