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
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="16" cy="17" r="8.5" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.7" />
      <circle cx="16" cy="17" r="1.35" fill="currentColor" />
      <circle cx="22.6" cy="11.2" r="2.15" fill="currentColor" />
    </svg>
  );
}
