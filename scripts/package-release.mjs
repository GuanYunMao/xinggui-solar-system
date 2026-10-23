// 把 `vite build` 的产物打两份：
//   1. release/site/      —— 一整个静态站点，直接拖到任意静态托管（Netlify / 仓库 Pages / Vercel）即可
//   2. release/星轨.html   —— 单个自包含 HTML，双击就能玩，也能直接发到手机上
//
// 不引入任何构建期第三方依赖，纯 Node 内置模块实现内联。
import { readFile, writeFile, mkdir, cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const release = path.join(root, "release");

const START = "<!--SINGLE:";

function escapeScript(code) {
  // 内联进 <script> 里，出现 </script 会提前闭合标签；`<\/script` 在 JS 里等价。
  return code.replace(/<\/script/gi, "<\\/script");
}

function escapeStyle(code) {
  return code.replace(/<\/style/gi, "<\\/style");
}

async function main() {
  const htmlPath = path.join(dist, "index.html");
  let html;
  try {
    html = await readFile(htmlPath, "utf8");
  } catch {
    console.error("[release] 找不到 dist/index.html，先跑 vite build");
    process.exit(1);
  }

  await rm(release, { recursive: true, force: true });
  await mkdir(release, { recursive: true });

  // —— 1. 完整静态站点 ——
  await cp(dist, path.join(release, "site"), { recursive: true });

  // —— 2. 单文件 HTML ——
  const placeholders = new Map();
  let single = html.replace(/<link\b[^>]*>/g, (tag) => {
    const href = tag.match(/href="([^"]+)"/)?.[1];
    if (!href) return tag;
    if (/\brel="stylesheet"/.test(tag)) {
      const id = `${START}css:${href}-->`;
      placeholders.set(id, href);
      return id;
    }
    // 单文件里没有同目录的其他资源，这些引用直接去掉
    if (/\brel="(modulepreload|manifest|apple-touch-icon|icon)"/.test(tag)) return "";
    return tag;
  });

  const scriptTags = [...single.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)];
  for (const [tag, src] of scriptTags) {
    const id = `${START}js:${src}-->`;
    placeholders.set(id, src);
    single = single.replace(tag, () => id);
  }

  for (const [id, href] of placeholders) {
    const file = path.join(dist, href.replace(/^\.\//, ""));
    const code = await readFile(file, "utf8");
    const isCss = id.includes("css:");
    // 必须用函数形式替换：压缩后的 JS 里含 `$&` / `$'` 等序列，
    // 当作替换模式会把产出打坏（表现为 "Unexpected identifier"）。
    const replacement = isCss
      ? `<style>${escapeStyle(code)}</style>`
      : `<script type="module">${escapeScript(code)}</script>`;
    single = single.replace(id, () => replacement);
  }

  const singlePath = path.join(release, "星轨.html");
  await writeFile(singlePath, single, "utf8");

  const [a, b] = await Promise.all([stat(singlePath), stat(path.join(release, "site", "index.html"))]);
  console.log(`[release] release/星轨.html        ${(a.size / 1024 / 1024).toFixed(2)} MB（双击即玩）`);
  console.log(`[release] release/site/index.html  ${(b.size / 1024).toFixed(1)} KB（用于托管）`);
  console.log(`[release] release/site/assets/     静态资源`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
