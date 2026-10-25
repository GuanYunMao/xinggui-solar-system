/**
 * 品牌图形：目前只有一个 32px 的简化轨道环，供 HUD 顶部占位。
 *
 * 刻意做成 **favicon.svg 的同一套几何**（环 + 中心点 + 一颗卫星点），只是去掉圆角底，
 * 并用 `currentColor` 描边，好让主题色统一管。不在 HUD 里画第二套细节——
 * 大图标（180 / 192 / 512）等专门一轮，见 t12 回报里的图标产出计划。
 */
export function OrbitGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* 非对称轨道 + 象限刻线：像一枚测绘仪标，而不是通用的“星球”图标。 */}
      <ellipse cx="20" cy="20" rx="14" ry="7.5" transform="rotate(-32 20 20)" stroke="currentColor" strokeOpacity="0.72" strokeWidth="1.2" />
      <ellipse cx="20" cy="20" rx="9.5" ry="14" transform="rotate(38 20 20)" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1" />
      <path d="M20 3V8M20 32V37M3 20H8M32 20H37" stroke="currentColor" strokeOpacity="0.62" strokeWidth="1.2" />
      <path d="M17 20H23M20 17V23" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="20" cy="20" r="2.2" fill="currentColor" />
      <circle cx="30.7" cy="11.6" r="2.3" fill="currentColor" />
      <circle cx="30.7" cy="11.6" r="4.2" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" />
    </svg>
  );
}
