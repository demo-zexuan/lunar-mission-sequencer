// 用法: node scripts/gif.mjs <page.html> [--out out/mission.gif] [--frames 132] [--fps 12] [--width 1280] [--height 800]
//       [--select ".iso-plate"] [--from 0] [--to 1] [--ease linear|inout] [--hold 8] [--keep] [--work out/.gif-work]
// 示例: node scripts/gif.mjs dist/index.html --frames 132 --fps 12 --out out/mission.gif

/**
 * 任务时序仪 GIF 录制脚本
 *
 * 用 CDP 驱动无头 Chrome，逐帧设置任务进度 p 并截图，
 * 再用 ffmpeg 两遍调色板合成 1280×800 的循环 GIF。
 *
 * I. 录制流程
 *
 * 1. 启动无头 Chrome（SwiftShader 软渲染，保证 WebGL 画布层可用）
 *    (1) 复用 capture.mjs 的浏览器探测与 CDP 管道（同 CHROME_PATH 搜索、同启动参数）
 *    (2) 视口固定为 --width × --height，deviceScaleFactor = 1，截图即为 CSS 像素
 *
 * 2. 等待页面真正就绪，而不是猜一个固定等待时间
 *    (1) 轮询 window.__lunar.ready（20 s 超时），再等 document.fonts.ready 与两帧 rAF
 *    (2) 随后调用 __lunar.pause() 并置 __lunar.still = true，冻结所有基于时间的动画
 *    (3) 逐帧调用 __lunar.set(p, { settle: true })，该调用同步绘制目标帧
 *
 * 3. 每帧截图裁剪到 --select 元素的完整包围盒
 *    (1) 元素比视口大时，用 Emulation.setDeviceMetricsOverride 临时放大视口使其完整可见
 *    (2) 裁剪框一旦确定就固定不变，保证每张 PNG 尺寸一致（ffmpeg image2 的硬性要求）
 *
 * II. 合成策略
 *
 * 1. 元素宽高比与目标 W:H 相差 ≤ 2% 时，直接 scale 到 W×H（≤2% 的形变可接受）
 * 2. 相差 > 2% 时按比例等比缩放，再用 pad 居中补边到 W×H，补边色取第 0 帧左上角像素
 * 3. 两遍调色板：palettegen(stats_mode=diff) → paletteuse(bayer/diff_mode=rectangle)
 *
 * III. 健壮性
 *
 * 1. 每个 CDP 调用都带超时，会话级错误（message.error）立即抛出，不会静默挂死
 * 2. 退出时（正常、异常、SIGINT/SIGTERM）统一 kill Chrome、删除临时 profile 与工作目录
 *
 * @module scripts/gif
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-10-12
 */

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Node 20 及以下没有全局 WebSocket，带 --experimental-websocket 重新拉起自己
function relaunchIfNeeded() {
  if (typeof WebSocket === "undefined" && !process.execArgv.includes("--experimental-websocket")) {
    const child = spawn(process.execPath, ["--experimental-websocket", ...process.argv.slice(1)], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 1));
    return true;
  }
  return false;
}

/** 单次 CDP 调用的默认超时，防止会话级故障把脚本挂死 */
var SEND_TIMEOUT = 30000;
/** 截图单独给更长超时（大元素 + 软渲染较慢） */
var SHOT_TIMEOUT = 60000;
/** 临时放大视口的上限，避免超出 GPU 纹理上限 */
const MAX_VIEWPORT = 8192;

// 退出清理所需的全局状态（cleanup 会在 exit / 信号里被调用）
// main() 在文件顶部就被 await，所以这些清理用的变量必须是 var（提升），
// 否则它们在 main() 执行时仍处于 TDZ
var chromeProcess = null;
var profileDir = null;
var workDir = null;
var framesDir = null;
var keepDir = null;
var keepFrames = false;
var cleaned = false;

function usage() {
  console.log(`Record a progress-driven GIF of a figure page with headless Chrome + ffmpeg.

  node scripts/gif.mjs <page.html | url> [options]

  --out <file.gif>    output path (default out/mission.gif)
  --frames <n>        number of captured progress frames (default 132)
  --fps <n>           GIF frame rate (default 12)
  --width <px>        GIF width (default 1280)
  --height <px>       GIF height (default 800)
  --select <css>      element to capture, whole element, never cropped (default ".iso-plate")
  --from <p>          start progress, 0..1 (default 0)
  --to <p>            end progress, 0..1 (default 1)
  --ease <name>       "linear" (default) | "inout" (smoothstep) — maps frame index to p
  --hold <n>          extra identical frames at p = --to (default 8)
  --keep              keep the PNG frames in <out dir>/frames-<name>/
  --work <dir>        scratch directory (default out/.gif-work)
  -h, --help          print this message

  The page must expose window.__lunar = { ready, set(p, {settle}), play, pause }.`);
}

function parse(argv) {
  const options = {
    out: "out/mission.gif",
    frames: 132,
    fps: 12,
    width: 1280,
    height: 800,
    select: ".iso-plate",
    from: 0,
    to: 1,
    ease: "linear",
    hold: 8,
    keep: false,
    work: "out/.gif-work",
  };
  const rest = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--out") options.out = next();
    else if (arg === "--frames") options.frames = Number(next());
    else if (arg === "--fps") options.fps = Number(next());
    else if (arg === "--width") options.width = Number(next());
    else if (arg === "--height") options.height = Number(next());
    else if (arg === "--select") options.select = next();
    else if (arg === "--from") options.from = Number(next());
    else if (arg === "--to") options.to = Number(next());
    else if (arg === "--ease") options.ease = next();
    else if (arg === "--hold") options.hold = Number(next());
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--work") options.work = next();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else rest.push(arg);
  }
  options.target = rest[0];
  return options;
}

/** 与 capture.mjs 完全一致的浏览器探测顺序 */
function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  const playwright = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(playwright)) {
    for (const dir of readdirSync(playwright).sort().reverse()) {
      for (const sub of ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        candidates.push(join(playwright, dir, sub));
      }
    }
  }
  return candidates.find((path) => existsSync(path));
}

/** ffmpeg 探测：显式路径优先，其次 PATH 上的 ffmpeg */
function ffmpegPath() {
  const explicit = [process.env.FFMPEG_PATH, "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].filter(Boolean).find((path) => existsSync(path));
  if (explicit) return explicit;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "ffmpeg");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 读 PNG 的 IHDR，拿到帧的真实像素尺寸（无第三方依赖） */
function pngSize(path) {
  const head = Buffer.alloc(24);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  if (head.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path} 不是合法 PNG`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** 用 ffmpeg 取第 0 帧左上角像素，作为补边底色（省掉一个 PNG 解码器） */
function sampleTopLeft(binary, framePath) {
  const result = spawnSync(binary, ["-v", "error", "-i", framePath, "-vf", "crop=1:1:0:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 20 });
  const bytes = result.stdout;
  if (result.status !== 0 || !bytes || bytes.length < 3) return "000000";
  return [bytes[0], bytes[1], bytes[2]].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** 跑一次 ffmpeg，失败时把 stderr 末尾带出来 */
function runFfmpeg(binary, args, cwd, label) {
  return new Promise((done, fail) => {
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", (error) => fail(new Error(`${label}: 无法执行 ffmpeg（${error.message}）`)));
    child.on("close", (code) => {
      if (code === 0) done();
      else fail(new Error(`${label}: ffmpeg 退出码 ${code}\n${stderr.trim().split("\n").slice(-8).join("\n")}`));
    });
  });
}

/** 帧序号 → 进度 p；inout 用 smoothstep 缓入缓出 */
function progressAt(index, count, from, to, ease) {
  const t = count <= 1 ? 1 : index / (count - 1);
  const eased = ease === "inout" ? t * t * (3 - 2 * t) : t;
  return from + (to - from) * eased;
}

/** 幂等清理：kill Chrome、删临时 profile、按需保留帧目录 */
function cleanup() {
  if (cleaned) return;
  cleaned = true;

  // I. 关闭浏览器进程
  if (chromeProcess && chromeProcess.exitCode === null && !chromeProcess.killed) {
    try {
      chromeProcess.kill("SIGKILL");
    } catch {}
  }

  // II. 删除临时用户数据目录
  if (profileDir) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  }

  // III. 处理工作目录：--keep 时先把帧搬到 <out 目录>/frames-<name>/
  if (workDir) {
    if (keepFrames && framesDir && existsSync(framesDir) && keepDir) {
      try {
        mkdirSync(dirname(keepDir), { recursive: true });
        rmSync(keepDir, { recursive: true, force: true });
        try {
          renameSync(framesDir, keepDir);
        } catch {
          // 跨设备时 rename 会失败，退回复制
          cpSync(framesDir, keepDir, { recursive: true });
        }
        console.log(`kept ${keepDir}`);
      } catch (error) {
        console.error(`warning: 保留帧目录失败：${error.message}`);
      }
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }
  if (!options.target) {
    usage();
    process.exit(1);
  }

  const fail = (message) => {
    console.error(`error: ${message}`);
    process.exit(1);
  };

  // I. 参数校验
  const frames = Math.round(options.frames);
  const hold = Math.round(options.hold);
  const width = Math.round(options.width);
  const height = Math.round(options.height);
  const { fps, from, to, ease, select } = options;
  if (!Number.isFinite(frames) || frames < 1) fail(`--frames 必须是 ≥ 1 的整数，收到 ${options.frames}`);
  if (!Number.isFinite(hold) || hold < 0) fail(`--hold 必须是 ≥ 0 的整数，收到 ${options.hold}`);
  if (!Number.isFinite(fps) || fps <= 0) fail(`--fps 必须 > 0，收到 ${options.fps}`);
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) fail(`--width/--height 必须是正整数，收到 ${options.width}×${options.height}`);
  if (ease !== "linear" && ease !== "inout") fail(`--ease 只支持 "linear" 或 "inout"，收到 ${ease}`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from > 1 || to < 0 || to > 1) fail(`--from/--to 必须落在 0..1，收到 ${options.from} / ${options.to}`);

  const url = /^https?:|^file:/.test(options.target) ? options.target : pathToFileURL(resolve(options.target)).href;
  const outPath = resolve(options.out);
  workDir = resolve(options.work);
  framesDir = join(workDir, "frames");
  const palettePath = join(workDir, "palette.png");
  const name = basename(outPath).replace(/\.gif$/i, "") || "mission";
  keepDir = join(dirname(outPath), `frames-${name}`);
  keepFrames = options.keep;

  const chromeBinary = chromePath();
  if (!chromeBinary) fail("找不到 Chrome/Chromium。请设置 CHROME_PATH 指向浏览器可执行文件。");
  const ffmpegBinary = ffmpegPath();
  if (!ffmpegBinary) fail("找不到 ffmpeg。请设置 FFMPEG_PATH，或安装到 /opt/homebrew/bin/ffmpeg。");

  mkdirSync(framesDir, { recursive: true });
  mkdirSync(dirname(outPath), { recursive: true });

  // II. 启动无头 Chrome（参数与 capture.mjs 一致，SwiftShader 保证 WebGL 可用）
  profileDir = mkdtempSync(join(tmpdir(), "lunar-gif-"));
  chromeProcess = spawn(
    chromeBinary,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const port = await new Promise((done, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("Chrome 未在 20 s 内启动")), 20000);
    chromeProcess.stderr.on("data", (chunk) => {
      text += chunk;
      const match = text.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    });
    chromeProcess.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome 提前退出（code ${code}）`));
    });
  });

  let socket = null;
  let code = 0;
  try {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const problems = [];
    const settle = (call, message) => {
      const handler = pending.get(call);
      if (handler) {
        pending.delete(call);
        handler(message);
      }
    };
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.id && pending.has(data.id)) {
        settle(data.id, data);
      } else if (data.method === "Runtime.consoleAPICalled" && (data.params.type === "error" || data.params.type === "warning")) {
        problems.push(`console.${data.params.type}: ${data.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 400)}`);
      } else if (data.method === "Runtime.exceptionThrown") {
        const detail = data.params.exceptionDetails;
        problems.push(`exception: ${detail.exception?.description ?? detail.text}`.slice(0, 600));
      }
    };
    // 会话断开时把所有在途调用全部失败掉，避免 await 永久挂起
    const abortPending = (reason) => {
      for (const call of [...pending.keys()]) settle(call, { error: { message: reason } });
    };
    socket.onclose = () => abortPending("CDP 连接已关闭");
    socket.onerror = () => abortPending("CDP 连接出错");
    await new Promise((done) => (socket.onopen = done));

    // 1. send() 带超时；CDP 返回 error 时直接 reject
    // (1) 超时后把在途回调移除，防止回调被迟到消息二次触发
    // (2) 任何一次失败都会冒泡到 main 的 catch，不会静默继续录帧
    const send = (method, params = {}, timeout = SEND_TIMEOUT) =>
      new Promise((done, reject) => {
        const call = ++id;
        const timer = setTimeout(() => {
          pending.delete(call);
          reject(new Error(`CDP ${method} 超时（${timeout} ms）`));
        }, timeout);
        pending.set(call, (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(`CDP ${method} 失败：${message.error.message}`));
          else done(message);
        });
        socket.send(JSON.stringify({ id: call, method, params }));
      });
    const evaluate = async (expression) => {
      const message = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      const details = message.result?.exceptionDetails;
      if (details) throw new Error(`页面脚本抛错：${details.exception?.description ?? details.text}`.slice(0, 400));
      return message.result?.result?.value;
    };
    const rafTwice = async () => {
      try {
        await evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`);
      } catch (error) {
        // rAF 不触发说明合成器没有出帧，此时截到的必然是旧帧，必须显式失败而不是继续录
        throw new Error(`等待两帧 requestAnimationFrame 失败（页面可能没有合成帧）：${error.message}`);
      }
    };
    const setProgress = async (p) => {
      await evaluate(`window.__lunar.set(${JSON.stringify(p)}, { settle: true })`);
      await rafTwice();
    };
    const measure = () =>
      evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(select)}) || document.querySelector("svg") || document.body;
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
      })()`);
    const fits = (box) => box.w <= box.vw + 0.5 && box.h <= box.vh + 0.5;

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url });

    // III. 等待页面就绪：轮询真实条件，不做固定时长猜测
    // 1. window.__lunar.ready（20 s 超时）
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await evaluate("!!(window.__lunar && window.__lunar.ready)");
      if (ready) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!ready) {
      const present = await evaluate("!!window.__lunar");
      if (!present) throw new Error(`页面 ${url} 没有暴露 window.__lunar（期望 { ready, set, play, pause }）`);
      throw new Error(`页面 ${url} 的 window.__lunar.ready 在 20 s 内没有变为 true`);
    }
    if (!(await evaluate("typeof window.__lunar.set === 'function'"))) throw new Error(`页面 ${url} 的 window.__lunar.set 不是函数`);
    // 2. 字体与两帧 rAF，确保首帧截图不会拿到半渲染状态
    await evaluate("document.fonts.ready.then(() => true)");
    await rafTwice();
    // 3. 冻结时间驱动的动画：暂停时间轴，并置 still 开关（不依赖 matchMedia 模拟）
    // (1) 整段包 try/catch：页面若把 __lunar 冻结或 pause 抛错，也不该让整次录制失败
    await evaluate(`(() => {
      try {
        const lunar = window.__lunar;
        if (typeof lunar.pause === "function") lunar.pause();
        lunar.still = true;
      } catch {}
      return true;
    })()`);

    // IV. 确定裁剪框：必须是元素的完整包围盒，绝不裁切元素
    if (!(await evaluate(`!!document.querySelector(${JSON.stringify(select)})`))) {
      console.warn(`warning: 页面上没有 ${select}，回退到 <svg> 或 <body>`);
    }
    let box = await measure();
    if (!fits(box)) {
      // 1. 元素大于视口：临时放大视口直到装得下（布局可能随宽度回流，所以循环复测）
      for (let attempt = 0; attempt < 3 && !fits(box); attempt++) {
        await send("Emulation.setDeviceMetricsOverride", {
          width: Math.min(MAX_VIEWPORT, Math.max(Math.ceil(box.w) + 8, width)),
          height: Math.min(MAX_VIEWPORT, Math.max(Math.ceil(box.h) + 8, height)),
          deviceScaleFactor: 1,
          mobile: false,
        });
        box = await measure();
      }
      // 2. 仍装不下（超过 MAX_VIEWPORT）：靠 captureBeyondViewport 兜底，裁剪框依旧是完整元素
      if (!fits(box)) console.warn(`warning: 元素 ${Math.round(box.w)}×${Math.round(box.h)} 超过视口上限，改用 captureBeyondViewport 捕获完整元素`);
    }
    // 3. 先渲染一次起始帧再复测，取并集，保证所有帧共用一个裁剪框（PNG 尺寸必须一致）
    await setProgress(from);
    const after = await measure();
    box = {
      x: Math.min(box.x, after.x),
      y: Math.min(box.y, after.y),
      w: Math.max(box.w, after.w),
      h: Math.max(box.h, after.h),
      vw: after.vw,
      vh: after.vh,
    };
    const clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: Math.max(1, Math.round(box.h)) };

    // V. 逐帧录制：set() 同步绘制 → 两帧 rAF → 截图
    const total = frames + hold;
    console.log(`recording ${total} frames (${frames} progress + ${hold} hold) · element ${clip.width}×${clip.height} @ ${clip.x},${clip.y} · ease ${ease}`);
    for (let index = 0; index < total; index++) {
      // 1. hold 段固定停在 p = to，形成结尾停顿
      const p = index < frames ? progressAt(index, frames, from, to, ease) : to;
      await setProgress(p);
      // 2. 裁剪坐标是页面坐标（含滚动偏移），配合 captureBeyondViewport 永远拿到完整元素
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...clip, scale: 1 } }, SHOT_TIMEOUT);
      writeFileSync(join(framesDir, `f${String(index).padStart(4, "0")}.png`), Buffer.from(shot.result.data, "base64"));
      if (index % 20 === 0 || index === total - 1) console.log(`frame ${index + 1}/${total} · p=${p.toFixed(4)}`);
    }

    // VI. 计算缩放/补边：宽高比相差 > 2% 就等比缩放 + 补边，否则直接拉伸
    const frame = pngSize(join(framesDir, "f0000.png"));
    const targetAspect = width / height;
    const frameAspect = frame.width / frame.height;
    const padded = Math.abs(frameAspect - targetAspect) / targetAspect > 0.02;
    let chain = `scale=${width}:${height}:flags=lanczos`;
    if (padded) {
      const ratio = Math.min(width / frame.width, height / frame.height);
      const scaledWidth = Math.max(1, Math.round(frame.width * ratio));
      const scaledHeight = Math.max(1, Math.round(frame.height * ratio));
      const background = sampleTopLeft(ffmpegBinary, join(framesDir, "f0000.png"));
      chain = `scale=${scaledWidth}:${scaledHeight}:flags=lanczos,pad=${width}:${height}:${Math.floor((width - scaledWidth) / 2)}:${Math.floor((height - scaledHeight) / 2)}:color=0x${background}`;
      console.log(`frame ${frame.width}×${frame.height} → ${scaledWidth}×${scaledHeight}, padded to ${width}×${height} with #${background}`);
    } else {
      console.log(`frame ${frame.width}×${frame.height} → ${width}×${height} (aspect within 2%, scaled directly)`);
    }

    // VII. 两遍调色板合成 GIF
    // 1. 第一遍：从所有帧统计最优 256 色调色板（stats_mode=diff 对帧间差异更敏感）
    // 2. 第二遍：bayer 抖动 + diff_mode=rectangle，只重绘变化区域，显著减小体积
    // 3. -start_number 0 明确从 f0000.png 开始（image2 demuxer 的默认值本就是 0，写出来更稳）
    await runFfmpeg(
      ffmpegBinary,
      ["-y", "-framerate", String(fps), "-start_number", "0", "-i", "f%04d.png", "-vf", `${chain},palettegen=stats_mode=diff`, palettePath],
      framesDir,
      "palettegen",
    );
    await runFfmpeg(
      ffmpegBinary,
      ["-y", "-framerate", String(fps), "-start_number", "0", "-i", "f%04d.png", "-i", palettePath, "-lavfi", `${chain}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`, "-loop", "0", outPath],
      framesDir,
      "paletteuse",
    );

    // VIII. 汇报结果
    const sizeMb = statSync(outPath).size / (1024 * 1024);
    const duration = total / fps;
    console.log(`saved ${outPath}`);
    console.log(`frames ${total} · ${fps} fps · ${duration.toFixed(2)} s · ${sizeMb.toFixed(2)} MB`);
    if (problems.length) console.log(problems.slice(0, 20).join("\n"));
    else console.log("console: clean");
  } catch (error) {
    console.error(`error: ${error.message}`);
    code = 1;
  } finally {
    try {
      socket?.close();
    } catch {}
    cleanup();
  }
  process.exit(code);
}

// ============================================================================
// 入口：所有模块级常量都已求值，这里再启动，避免 TDZ
// ============================================================================
if (!relaunchIfNeeded()) await main();
