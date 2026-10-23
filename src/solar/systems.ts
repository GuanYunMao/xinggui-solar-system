/**
 * 系统数据层：把「唯一的太阳系」与「任意一个星系」分开的起点。
 *
 * 1.1.0 的最小验证原型只会用到 REAL_PROTO 里的三个天体 —— 它存在的意义不是好看，
 * 是回答一个工程问题：同一台相机能不能从 78 AU 连续推到 100 km 而不抖。
 *
 * 单位约定：沙盘用压缩后的世界单位（现状），实境原型用**米**。
 * 位置一律在 JS 里用 double 存，只有相机相对之后才转 float32 进 GPU。
 */

import type { Body } from "./data";

export type SystemSpec = {
  id: string;
  name: string;
  /** 单位：沙盘是压缩世界单位，实境是米 */
  unit: "worldUnit" | "meter";
  bodies: Body[];
};

/** 现在的太阳系（压缩比例），供沙盘使用 */
export type { Body };

/**
 * 最小验证原型：太阳 / 地球 / 月球，全部真实数值、单位是米。
 * 数据来源：NASA Fact Sheet（太阳半径 695,700 km、地球 6,371 km、月球 1,737.4 km）。
 * 轨道用圆轨道近似 —— 原型只验证相机与深度精度，不验证开普勒解。
 */
export const REAL_PROTO_BODIES: Body[] = [
  {
    id: "sun",
    name: "太阳",
    kind: "恒星 · G2V",
    blurb: "真实单位原型，仅用于验证相机与深度精度。",
    radius: 6.957e8,
    orbitRadius: 0,
    period: 1,
    phase: 0,
    inclination: 0,
    obliquity: 0,
    spin: 0.08,
    focus: 6.957e9,
    swatch: "#f0c27a",
    texture: "sun",
    facts: [{ label: "半径", value: "695,700 km" }],
  },
  {
    id: "earth",
    name: "地球",
    kind: "类地行星",
    blurb: "真实单位原型。1 AU = 1.496e11 m。",
    radius: 6.371e6,
    orbitRadius: 1.496e11,
    period: 18,
    phase: 0,
    inclination: 0,
    obliquity: 0.408,
    spin: 0.95,
    parent: "sun",
    focus: 3e7,
    swatch: "#6aa2d8",
    texture: "earth",
    facts: [{ label: "轨道", value: "1.496e11 m" }],
  },
  {
    id: "moon",
    name: "月球",
    kind: "天然卫星",
    blurb: "真实单位原型。地月距离 3.844e8 m。",
    radius: 1.7374e6,
    orbitRadius: 3.844e8,
    period: 2.55,
    phase: 0.6,
    inclination: 0.089,
    obliquity: 0.117,
    spin: 0,
    locked: true,
    parent: "earth",
    focus: 1e7,
    swatch: "#c5c1b8",
    texture: "moon",
    facts: [{ label: "地月距离", value: "3.844e5 km" }],
  },
];

/** 真实单位原型系统 */
export const REAL_PROTO: SystemSpec = {
  id: "real-proto",
  name: "实境原型",
  unit: "meter",
  bodies: REAL_PROTO_BODIES,
};

/**
 * 相机 near/far 的每帧收窄（t7 定稿）。固定值不可能成立：
 * 全景档需要 4.87e9 的跨度，而 100 km 高度档只要 2.7e3。
 * 这里只依赖焦点距离 d，把跨度压到 4096× 以内。
 */
export function tightenClipPlanes(
  camera: { near: number; far: number; updateProjectionMatrix: () => void },
  distance: number,
) {
  const d = Math.max(distance, 1e-6);
  const near = Math.min(Math.max(d / 4096, 0.05), d / 1.25);
  const far = Math.max(1.25 * d, 16384 * near);
  // 只在变化超过 5% 时更新，避免每帧重算投影矩阵
  if (Math.abs(camera.near - near) > near * 0.05 || Math.abs(camera.far - far) > far * 0.05) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}
