/**
 * 月球任务时序仪 · 页面运行时
 *
 * I. 一份状态，四处输出
 *
 * 1. 唯一的状态是任务进度 p（0 = 发射台，1 = 溅落）
 *    (1) 巡游按真实事件节奏推进，交互时指数跟随
 *    (2) window.__lunar.set(p, { settle: true }) 用于逐帧录制 GIF
 * 2. 每一帧从同一个 p 取值：滑架位置、卷扬机行程、构型、
 *    表针、任务钟数字、旗帜、读数、WebGL 尾焰
 *
 * II. 深度重排
 *
 * 1. 运动项带 data-move="rail"，其深度随导轨局部深度变化
 * 2. 每帧算 key = data-k + (depth(railPoint(p)) − depth(restRail))，
 *    只有次序真的变了才重新挂 DOM
 *
 * III. 交互
 *
 * 1. 指针横向拖动 = 扫过整个任务；方向键按事件步进；空格播放/暂停
 * 2. 无人操作 1.4 秒后回到巡游；离开视口、降级动效都停
 *
 * @module src/live
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-10-12
 */

const D = __DATA__;
const P = D.P;
const stage = document.querySelector(".lms-stage");
const front = stage.querySelector("svg.lms-front");
const canvas = stage.querySelector("canvas.lms-gl");
const readout = document.querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");

const restRail = D.rest.rail;
const moving = [...front.querySelectorAll('[data-move="rail"]')].map((node) => ({
  node,
  k: Number(node.dataset.k),
}));
const vehicle = front.querySelector('[data-part="vehicle"]');
const lmGroup = front.querySelector('[data-part="lm"]');
const needle = stage.querySelector(".needle");
const digits = [...stage.querySelectorAll(".met-digit")];
const flags = [...stage.querySelectorAll('[data-part^="flag-"]')];
const stageGroups = new Map([...front.querySelectorAll("[data-stage]")].map((g) => [g.dataset.stage, g]));

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

// ============================================================================
// I. 状态与巡游
// ============================================================================

const TOUR_SECONDS = 17;
const HOLD_SECONDS = 1.6;
const RESET_SECONDS = 5.5;

let p = D.rest.p;
let target = p;
let clock = 0;
let touring = !still.matches;
let visible = false;
let frame = 0;
let last = 0;
let quiet = 0;
let phase = "tour";
let holdFrames = 0;

/** 巡游：正程按事件进度走完，停一下，再复位回发射台 */
function tourAt(t) {
  if (t < TOUR_SECONDS) return t / TOUR_SECONDS;
  if (t < TOUR_SECONDS + HOLD_SECONDS) return 1;
  const back = (t - TOUR_SECONDS - HOLD_SECONDS) / RESET_SECONDS;
  return back >= 1 ? 0 : 1 - back;
}

/**
 * 级间分离
 *
 * I. 分离是"看得见地离开"，而且是**一定会走完**的过程
 *
 * 1. jettisonAt(p) 给出目标进度；真正画出来的 sepState 用时间追上去
 *    (1) 只往前追、不后退：拖到窗口中间松手，分离仍会自己走完，
 *        不会把某一级永远定格在半分离上（这正是之前"一级一直存在"的原因）
 *    (2) 倒带时直接跟随目标值，于是往回拖能立刻恢复成完整的箭
 * 2. 位移沿分离方向推离，再绕该级自身中心轻微翻转，最后淡出
 */
const SEP_SECONDS = 0.5;
const sepState = new Map();

function applyStack(progress, dt = 0, snap = false) {
  const jettison = jettisonAt(progress);
  for (const [id, group] of stageGroups) {
    const want = jettison[id] ?? 0;
    const held = sepState.get(id) ?? 0;
    // 录制取该 p 的静态姿态；倒带到事件之前立刻恢复完整箭；
    // 否则一旦踏进分离窗口就一路推到底——停在窗口中间不会留下半分离的箭
    const k = snap ? want : want <= 0 ? 0 : Math.min(1, Math.max(held, want) + dt / SEP_SECONDS);
    sepState.set(id, k);
    if (k <= 0) {
      if (group.style.display === "none") group.style.display = "";
      if (group.dataset.sep) {
        group.removeAttribute("transform");
        group.style.opacity = "";
        delete group.dataset.sep;
      }
      continue;
    }
    if (k >= 1) {
      if (group.style.display !== "none") group.style.display = "none";
      continue;
    }
    const event = JETTISON.find((entry) => entry.id === id);
    const dir = event ? event.dir : [-1, 0, -1];
    const travel = k * JETTISON_TRAVEL;
    // 分离体的位移与自转都在箭体自身的局部坐标系里：先推离，再绕自身中心轻微翻转
    const spin = k * (id === "les" ? 26 : -20);
    const mid = iso(D.stageMid[id], P);
    group.style.display = "";
    group.style.opacity = String(Math.max(0, 1 - k * 1.15));
    group.setAttribute(
      "transform",
      `${translateAlong(P, [dir[0] * travel, dir[1] * travel, dir[2] * travel])} rotate(${spin.toFixed(2)} ${mid[0].toFixed(2)} ${mid[1].toFixed(2)})`,
    );
    group.dataset.sep = "1";
  }
}

// ============================================================================
// II. 每帧写 DOM
// ============================================================================

const RAISED = 3.6;

function draw(dt = 0, snap = false) {
  const rail = railPoint(p);
  const dx = rail[0] - restRail[0];
  const dz = rail[2] - restRail[2];
  const move = translateAlong(P, [dx, 0, dz]);
  for (const item of moving) item.node.setAttribute("transform", move);

  const info = physicsAt(p);
  const hoist = hoistAt(p) * D.hoist;
  if (lmGroup) lmGroup.setAttribute("transform", translateAlong(P, [0, 0, -hoist]));
  applyStack(p, dt, snap);
  syncBar(p);

  // 表针：每个相位扫过一格（整盘八格）
  const sweep = (info.index + info.f) / 8;
  const angle = sweep * Math.PI * 2;
  const dial = D.dial;
  needle.setAttribute(
    "d",
    lineOnTop(
      [dial.x - Math.sin(angle) * 2.0, dial.y + Math.cos(angle) * 2.0],
      [dial.x + Math.sin(angle) * (dial.r - 5), dial.y - Math.cos(angle) * (dial.r - 5)],
      dial.top + 0.25,
      P,
    ),
  );

  // 任务钟：机器自己显示的文字
  const label = metLabel(info.met);
  for (let i = 0; i < digits.length; i++) {
    const ch = label[i] ?? " ";
    if (digits[i].textContent !== ch) digits[i].textContent = ch;
  }

  // 事件旗：走过的升起
  flags.forEach((flag, index) => {
    const up = info.met >= D.events[index].met - 0.5;
    flag.setAttribute("transform", up ? translateAlong(P, [0, 0, RAISED]) : "");
  });

  // 深度重排：只有次序变了才动 DOM
  const delta = depthOf(rail, P) - depthOf(restRail, P);
  const order = moving.map((item) => ({ node: item.node, key: item.k + delta }));
  const sorted = [...order].sort((a, b) => a.key - b.key);
  let changed = false;
  for (let i = 0; i < sorted.length; i++) if (sorted[i].node !== order[i].node) { changed = true; break; }
  if (changed) {
    const fragment = document.createDocumentFragment();
    for (const item of sorted) fragment.appendChild(item.node);
    front.appendChild(fragment);
  }

  // 读数：相位名与数字取自同一个瞬间
  const text = `${metLabel(info.met)} · ${D.phases[info.index].zh} · 距地 ${group(info.rangeKm)} km · ${info.speedKmS.toFixed(2)} km/s`;
  if (readout.textContent !== text) readout.textContent = text;
  stage.setAttribute("aria-valuenow", String(Math.round(p * 1000)));
  return info;
}

// ============================================================================
// III. WebGL：尾焰与溅落水花
// ============================================================================

const WATER = D.water;
const TANK = D.tank;
const FRAGMENT = `
uniform vec3 uNoz;
uniform float uNozR;
uniform float uGlow;
uniform float uReach;
uniform float uSplash;
uniform vec2 uSplashAt;
uniform float uLight;
const float WATER_Z = ${WATER.toFixed(1)};

vec3 paperOf(float e) {
  vec3 c = mix(vec3(1.0), vec3(0.99, 0.78, 0.42), smoothstep(0.0, 0.2, e));
  c = mix(c, vec3(1.0, 0.45, 0.10), smoothstep(0.15, 0.5, e));
  c = mix(c, vec3(0.84, 0.20, 0.05), smoothstep(0.42, 0.68, e));
  c = mix(c, vec3(1.0, 0.94, 0.80), smoothstep(0.66, 0.92, e));
  return c;
}

vec4 inkFor(vec3 seen, float cover) {
  vec3 absorbed = 1.0 - seen;
  float a = max(max(absorbed.r, max(absorbed.g, absorbed.b)), cover);
  return vec4(vec3(a) - absorbed, a);
}

vec4 paperOut(vec3 seen, float cover, float energy) {
  vec4 ink = inkFor(seen, cover);
  ink.rgb = min(ink.rgb, vec3(ink.a));
  float n = (hash12(gl_FragCoord.xy + fract(uTime * 0.61) * 91.0) + hash12(gl_FragCoord.yx * 1.37 + fract(uTime * 0.37) * 57.0) - 1.0) / 255.0;
  return max(ink + vec4(vec3(n), n) * smoothstep(0.0, 1.5 / 255.0, ink.a), 0.0);
}

vec4 darkOut(vec3 col) {
  col = tonemap(col, 1.2);
  float m = max(col.r, max(col.g, col.b));
  float n = (hash12(gl_FragCoord.xy + fract(uTime * 0.61) * 91.0) + hash12(gl_FragCoord.yx * 1.37 + fract(uTime * 0.37) * 57.0) - 1.0) / 255.0;
  col = max(col + n * smoothstep(0.0, 1.5 / 255.0, m), 0.0);
  m = max(col.r, max(col.g, col.b));
  return vec4(col, m);
}

void main() {
  vec2 vb = viewOf(gl_FragCoord.xy);
  vec3 V = towardViewer();
  vec3 p0 = rayOf(vb);
  float cE = uCam.w;
  float dith = hash12(gl_FragCoord.xy);
  float axis = 0.0, edge = 0.0, pale = 0.0;
  vec3 col = vec3(0.0);

  // I. 尾焰：从喷口向下的一段世界空间锥体
  if (uGlow > 0.002) {
    float ta = (uNoz.z - p0.z) / V.z;
    float tb = (uNoz.z - uReach - p0.z) / V.z;
    // 射线参数 t 越大越靠近观察者，而尾焰从喷口往 z 小的一侧延伸，
    // 所以从远端的 tb 往喷口的 ta 步进
    float dt = max(ta - tb, 0.0) / 22.0;
    for (int i = 0; i < 22; i++) {
      float t = tb + (float(i) + dith) * dt;
      vec3 q = p0 + t * V;
      float s = uNoz.z - q.z;
      float r = length(q.xy - uNoz.xy);
      float Rv = uNozR * (0.9 + 0.55 * s / max(uReach, 1.0));
      float rn = r / max(Rv, 1e-3);
      float near = smoothstep(-0.6, 1.6, s);
      float fade = 1.0 - smoothstep(uReach * 0.4, uReach, s);
      float w = dt * cE / max(Rv, 1e-3) * near * fade;
      axis += smoothstep(1.05, 0.35, rn) * w;
      edge += exp(-pow((rn - 0.9) / 0.24, 2.0)) * w;
      pale += exp(-rn * rn * 2.4) * w * (1.0 - smoothstep(uReach * 0.35, uReach * 0.95, s));
    }
    axis *= uGlow; edge *= uGlow; pale *= uGlow;
    if (uLight > 0.5) {
      float m = tonemap(vec3(axis * 0.8 + pale * 1.5), 1.2).r;
      vec3 seen = mix(paperOf(m), vec3(1.0, 0.88, 0.6), clamp(pale * 0.9, 0.0, 1.0));
      seen = mix(seen, vec3(0.86, 0.24, 0.06), clamp(edge * 0.8, 0.0, 1.0));
      gl_FragColor = paperOut(seen, 0.94 * smoothstep(0.42, 0.9, m), m);
      return;
    }
    col += vec3(1.0, 0.45, 0.11) * axis * 0.5;
    col += vec3(1.0, 0.84, 0.5) * pale * 1.2;
    col += vec3(1.0, 0.5, 0.14) * edge * 0.35;
  }

  // II. 溅落：水面上的扩散环与飞溅片，全部在世界空间
  if (uSplash > 0.002) {
    vec3 w = onFloor(vb, WATER_Z);
    float r = length(w.xy - uSplashAt);
    float inTank = 1.0 - smoothstep(${(Math.min(TANK.w, TANK.d) / 2 - 1).toFixed(1)}, ${(Math.min(TANK.w, TANK.d) / 2 + 2).toFixed(1)}, r);
    float ring = exp(-pow((r - 4.0 - 22.0 * uSplash) / 4.2, 2.0));
    float sheet = exp(-r / (9.0 + 26.0 * uSplash)) * inTank;
    float splash = uSplash * uSplash;
    if (uLight > 0.5) {
      float m = clamp(sheet * 0.7 + ring * 0.55, 0.0, 1.0) * splash;
      vec3 seen = mix(vec3(1.0), vec3(0.55, 0.72, 0.92), clamp(m * 1.4, 0.0, 1.0));
      vec4 ink = inkFor(seen, 0.0);
      gl_FragColor = paperOut(seen, 0.0, m) * m;
      return;
    }
    col += vec3(0.86, 0.93, 1.0) * sheet * 0.5 * splash;
    col += vec3(1.0, 0.96, 0.9) * ring * 0.45 * splash;
  }

  gl_FragColor = darkOut(col);
}
`;

const layer = canvas
  ? glLayer({
      canvas,
      fragment: FRAGMENT,
      view: [D.W, D.H],
      camera: D.camera,
      uniforms: ["uNoz", "uNozR", "uGlow", "uReach", "uSplash", "uSplashAt", "uLight"],
      onError(message) {
        window.__glError = message;
        console.error(message);
      },
    })
  : null;
if (layer) stage.setAttribute("data-gl", "");
window.__glDebug = { hasCanvas: Boolean(canvas), hasLayer: Boolean(layer), error: window.__glError ?? null };

/** 主题对应的着色分支：1 = 亮色（纸上的墨），0 = 暗色（自发光） */
let lightUniform = D.light ? 1 : 0;

const glow = { x: 0, v: 0 };
const splash = { x: 0, v: 0 };
let splashAt = 0;
let lastNozzle = null;

/** 尾焰与溅落状态：从同一个 p 取，不留第二份真值 */
function effects(info, dt, calm, snap) {
  const burn = burnAt(p);
  const nozzle = burn.engine === "off" ? null : D.engines[burn.engine];
  const want = nozzle ? burn.level : 0;
  const rail = railPoint(p);
  const world = nozzle
    ? [D.padX + (rail[0] - restRail[0]), D.plateY, nozzle.z + (rail[2] - restRail[2]) - hoistAt(p) * (burn.engine === "lmd" || burn.engine === "lma" ? D.hoist : 0)]
    : null;
  if (snap) {
    glow.x = want;
    glow.v = 0;
  } else {
    settle(glow, want, dt, 0.22, calm);
  }
  lastNozzle = world;

  // 溅落：p 越过 1 之前的一段出现，然后衰减
  const wantSplash = p > 0.995 ? 1 : 0;
  if (wantSplash && !splashAt) splashAt = 1e-6;
  if (snap) {
    splash.x = wantSplash ? 1 : 0;
    splash.v = 0;
  } else if (wantSplash) {
    splashAt += dt;
    settle(splash, 1, dt, 0.3, calm);
  } else {
    settle(splash, 0, dt, 0.5, calm);
  }
  return { level: glow.x, nozzle: world, nozzleR: nozzle ? nozzle.r : 1, splash: splash.x };
}

function paintEffects(state, calm, snap) {
  if (!layer) return;
  window.__glState = { level: state.level, splash: state.splash, nozzle: state.nozzle, r: state.nozzleR };
  const active = state.level > 0.004 || state.splash > 0.004;
  if (!active) {
    layer.clear();
    return;
  }
  const at = state.nozzle ?? lastNozzle ?? [0, 0, 0];
  layer.draw(
    {
      uNoz: at,
      uNozR: state.nozzleR,
      uGlow: state.level,
      uReach: Math.min(26 + 34 * state.level, Math.max(8, at[2] - 2)),
      uSplash: state.splash,
      uSplashAt: [D.tank.x + D.tank.w / 2, D.tank.y + D.tank.d / 2],
      uLight: lightUniform,
    },
    calm || snap ? 0.8 : clock,
  );
}

// ============================================================================
// IV. 主循环
// ============================================================================

function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  const calm = still.matches;
  clock += dt * speed;
  if (touring) target = tourAt(clock);
  p = calm ? target : p + (target - p) * (1 - Math.exp(-dt / 0.26));
  if (Math.abs(target - p) < 1e-4) p = target;
  const info = draw(dt, false);
  const state = effects(info, dt, calm, false);
  paintEffects(state, calm, false);
  if (holdFrames > 0) {
    holdFrames -= 1;
    paintEffects(state, calm, true);
  }
  const settled = !touring && p === target && !still.matches ? false : true;
  const separating = [...stageGroups.keys()].some((id) => (jettisonAt(p)[id] ?? 0) > 0 && (sepState.get(id) ?? 0) < 1);
  const busy = touring || p !== target || separating || glow.x > 0.004 || splash.x > 0.004 || holdFrames > 0;
  frame = visible && (busy || !settled) ? requestAnimationFrame(tick) : 0;
}

const run = () => {
  if (!frame && visible) {
    last = 0;
    frame = requestAnimationFrame(tick);
  }
};

const kick = () => {
  touring = false;
  clearTimeout(kick.timer);
  kick.timer = setTimeout(() => {
    touring = !still.matches;
    clock = 0;
    run();
  }, 3600);
  run();
};

new IntersectionObserver(
  (entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    if (visible) run();
  },
  { rootMargin: "120px 0px" },
).observe(stage);

// ============================================================================
// V. 交互
// ============================================================================

const NEAREST_EVENT = (value) => {
  let best = 0;
  for (let i = 0; i < D.events.length; i++) if (Math.abs(D.events[i].p - value) < Math.abs(D.events[best].p - value)) best = i;
  return best;
};

function steer(next) {
  target = clamp(next, 0, 1);
  kick();
}

stage.addEventListener("pointerdown", (event) => {
  if (still.matches) touring = false;
  stage.setPointerCapture(event.pointerId);
  stage.dataset.drag = "1";
  steer(target);
  event.preventDefault();
});

stage.addEventListener("pointermove", (event) => {
  if (stage.dataset.drag !== "1") return;
  const box = stage.getBoundingClientRect();
  steer((event.clientX - box.left) / box.width);
});

for (const type of ["pointerup", "pointercancel"]) {
  stage.addEventListener(type, (event) => {
    delete stage.dataset.drag;
    if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  });
}

stage.addEventListener("keydown", (event) => {
  const here = NEAREST_EVENT(target);
  let next = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = D.events[Math.min(D.events.length - 1, here + (event.shiftKey ? 3 : 1))].p;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = D.events[Math.max(0, here - (event.shiftKey ? 3 : 1))].p;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = 1;
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    touring = !touring && !still.matches;
    if (touring) clock = p * TOUR_SECONDS;
    else target = p;
    run();
    return;
  }
  if (next === null) return;
  event.preventDefault();
  steer(next);
});

stage.addEventListener("focus", () => {
  stage.setAttribute("aria-valuetext", `${D.events[NEAREST_EVENT(p)].zh} · ${metLabel(physicsAt(p).met)}`);
});

// ============================================================================
// VI. 操作入口
//
// I. 键盘能做的，页面上都要能点
//
// 1. 播放/暂停、进度滑杆、跳事件、速度、主题、回到发射
// 2. 主题切换只改 body 的 data-theme：两套调色板都在 ISO_CSS 里，
//    WebGL 那一层靠 uLight 跟着换，不是换一份页面
// 3. 滑杆与状态双向同步：拖动时写 p，巡游时读 p 回写
// ============================================================================

const SPEEDS = [1, 2, 4];
const bar = document.querySelector(".lms-controls");
const playButton = bar?.querySelector('[data-act="play"]');
const scrubInput = bar?.querySelector('[data-act="scrub"]');
const percentLabel = bar?.querySelector('[data-act="percent"]');
const jumpSelect = bar?.querySelector('[data-act="jump"]');
const speedButton = bar?.querySelector('[data-act="speed"]');
const themeButton = bar?.querySelector('[data-act="theme"]');
const resetButton = bar?.querySelector('[data-act="reset"]');
let speed = 1;
let themeName = document.body.dataset.theme === "light" ? "light" : "dark";

function setTheme(name) {
  themeName = name === "light" ? "light" : "dark";
  document.body.dataset.theme = themeName;
  if (themeButton) themeButton.textContent = themeName === "light" ? "暗色" : "亮色";
  // 画布层是同一套相机，但亮色要换"纸上的墨"配方，靠 uniform 切分支
  lightUniform = themeName === "light" ? 1 : 0;
  holdFrames = 4;
  run();
}

function setPlaying(next) {
  touring = next && !still.matches;
  if (touring) clock = p * TOUR_SECONDS;
  else target = p;
  if (playButton) {
    playButton.textContent = touring ? "暂停" : "播放";
    playButton.setAttribute("aria-pressed", touring ? "true" : "false");
  }
  run();
}

playButton?.addEventListener("click", () => setPlaying(!touring));

scrubInput?.addEventListener("input", () => {
  setPlaying(false);
  steer(Number(scrubInput.value) / 1000);
});

jumpSelect?.addEventListener("change", () => {
  const index = Number(jumpSelect.value);
  setPlaying(false);
  steer(D.events[index]?.p ?? 0);
  stage.focus({ preventScroll: true });
});

speedButton?.addEventListener("click", () => {
  speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
  speedButton.textContent = `${speed}×`;
});

themeButton?.addEventListener("click", () => setTheme(themeName === "light" ? "dark" : "light"));

resetButton?.addEventListener("click", () => {
  setPlaying(false);
  steer(0);
});

/** 滑杆与百分比只在数值真的变了时回写，避免每帧碰 DOM */
let shown = -1;
function syncBar(value) {
  const step = Math.round(value * 1000);
  if (step === shown) return;
  shown = step;
  if (scrubInput && document.activeElement !== scrubInput) scrubInput.value = String(step);
  if (percentLabel) percentLabel.textContent = `${Math.round(value * 100)}%`;
  if (jumpSelect) {
    const near = NEAREST_EVENT(value);
    if (jumpSelect.value !== String(near)) jumpSelect.value = String(near);
  }
  if (playButton && !touring && playButton.textContent !== "播放") {
    playButton.textContent = "播放";
    playButton.setAttribute("aria-pressed", "false");
  }
}

// ============================================================================
// VII. 录制钩子
// ============================================================================

window.__lunar = {
  ready: true,
  still: false,
  /** 逐帧设置任务进度；settle 为真时所有缓动值直接跳到目标 */
  set(next, opts = {}) {
    touring = false;
    clearTimeout(kick.timer);
    p = clamp(next, 0, 1);
    target = p;
    clock = 0;
    const info = draw(0, true);
    const state = effects(info, 0, true, true);
    paintEffects(state, true, true);
    if (opts.settle !== false) {
      // 录制时保持尾焰画面，避免两次 rAF 后画布被清空
      holdFrames = 4;
      run();
    }
  },
  play() {
    touring = true;
    clock = p * TOUR_SECONDS;
    run();
  },
  pause() {
    touring = false;
    target = p;
    run();
  },
  progress() {
    return p;
  },
};

if (still.matches) touring = false;
draw(0, true);
paintEffects(effects(physicsAt(p), 0, true, true), true, true);
